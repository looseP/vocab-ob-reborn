/**
 * L3GradingService — agent 评卷执行面编排（批次三①，ADR-0035）。
 *
 * 读面 getGradingContext（D8 唯一例外）：sealed 题纸一次取齐（题 + answerIndex/
 * 解析 + 用户作答 + submitted 注记 + 原文），单事务只读组装；draft/discarded →
 * 409（防答案泄漏进做题过程、防 agent 介入未定格状态）。
 * 写面 submitGrading（requireTx 单事务）：results upsert（同键覆写 latest-wins）+
 * 注记 review 白名单写入 + stage 流转（sound→confirmed；questionable/wrong 保持
 * submitted；已 confirmed 不降级——终态不回滚）；questionId/annotationId 越集 422。
 * owner 处置 confirmAnnotation（D18）：submitted→confirmed；非 submitted → 409。
 *
 * 边界：只碰 l3_grading_results / l3_submissions / l3_question_attempts /
 * l3_question_annotations（review 白名单）/ l3_sources（只读）；题纸与题归属由
 * RLS + 既有 repo 收口（他人实体表现为不存在 → 404）。
 */

import type { PoolClient } from "pg";
import { BusinessRuleError, ConflictError, NotFoundError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3ContextRepository,
  IL3GradingRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "../repositories/interfaces";
import type {
  Json,
  L3QuestionAnswer,
  L3QuestionAnnotationRow,
  L3QuestionAttemptRow,
  L3QuestionOption,
  L3QuestionType,
  L3SubSpace,
  L3SubmissionRow,
  L3GradingResultRow,
} from "../domain";
import { findOutOfScopeIds, nextAnnotationStage, toStoredAnnotationReview } from "../domain/l3-grading";
import { resolveSheetScopedQuestions } from "./l3-sheet-scope";
import type { SubmitL3GradingInput } from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 评卷上下文单题视图（answerIndex 为 D8 唯一例外，见 ADR-0035 §2）。 */
export interface GradingContextQuestion {
  id: string;
  ordinal: number;
  question_type: L3QuestionType;
  space: L3SubSpace;
  stem: string;
  options: L3QuestionOption[];
  /** D8 例外：标准答案 jsonb 原样（choice/choices/text…，仅 sealed + agent 面）。 */
  answerIndex: L3QuestionAnswer;
  explanation: string | null;
  source_id: string | null;
  /** 该题纸内最新一条 active attempt 的作答事实与主观快照；无则 null。 */
  attempt: { answer: Json; self_assessment: Json | null; created_at: string } | null;
  /** 该题纸 stage='submitted' 注记（提交即授权收口；历史正式注记群不开放）。 */
  annotations: L3QuestionAnnotationRow[];
}

/** 原文（file=单 source；paper=各题 source 去重集合），供 agent 锚点核对。 */
export interface GradingContextSource {
  id: string;
  title: string;
  content_text: string | null;
}

export interface GradingContextResult {
  sheet: L3SubmissionRow;
  questions: GradingContextQuestion[];
  sources: GradingContextSource[];
}

export class L3GradingService {
  constructor(
    private readonly gradingRepo: IL3GradingRepository,
    private readonly sheetRepo: IL3SheetRepository,
    private readonly paperRepo: IL3PaperRepository,
    private readonly annotationRepo: IL3AnnotationRepository,
    private readonly contextRepo: IL3ContextRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActor<T>(userId: string, callback: (repos: IRepositories) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx)), { actorId: userId });
  }

  /** 仅 sealed 题纸可评卷（D16 双重防护：draft/discarded 一律 409）。 */
  private assertSealed(sheet: L3SubmissionRow, action: string): void {
    if (sheet.status !== "sealed") {
      throw new ConflictError(`${action} requires a sealed sheet`, undefined, {
        sheetId: sheet.id,
        status: sheet.status,
      });
    }
  }

  /** 读面：评卷上下文（agent 专属面；一次取齐免多跳）。 */
  async getGradingContext(userId: string, sheetId: string): Promise<GradingContextResult> {
    return this.withActor(userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(userId, sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", sheetId);
      // W5（ADR《writing-workspace》§5）：writing 稿的评阅走作文 feedback-context
      // （作文 feedback 是唯一质量反馈源）——generic 入口一律 409。
      if (sheet.scope === "writing") {
        throw new ConflictError("writing sheets use the writing feedback endpoints", undefined, {
          code: "WRITING_ENDPOINT_REQUIRED",
          sheetId,
        });
      }
      this.assertSealed(sheet, "grading-context");

      const scoped = await resolveSheetScopedQuestions(repos, userId, sheet);
      const attempts = await repos.l3Sheets.listBySheet(userId, sheetId);
      const annotations = await repos.l3Annotations.listAnnotationsBySheet(userId, sheetId);

      // 每题最新一条 active attempt（listBySheet 已按 created_at,id 定序，后写覆盖）。
      const latestAttempt = new Map<string, L3QuestionAttemptRow>();
      for (const row of attempts) {
        if (row.status !== "active") continue;
        latestAttempt.set(row.question_id, row);
      }

      // 提交即授权收口：仅该题纸 stage='submitted' 注记进上下文。
      const submittedByQuestion = new Map<string, L3QuestionAnnotationRow[]>();
      for (const annotation of annotations) {
        if (annotation.stage !== "submitted") continue;
        const list = submittedByQuestion.get(annotation.question_id);
        if (list) list.push(annotation);
        else submittedByQuestion.set(annotation.question_id, [annotation]);
      }

      // 原文集合：file=题纸 source（含题上 source 兜底）；paper=题集 source 去重。
      const sourceIds = new Set<string>();
      if (sheet.source_id) sourceIds.add(sheet.source_id);
      for (const question of scoped) {
        if (question.source_id) sourceIds.add(question.source_id);
      }
      const sources: GradingContextSource[] = [];
      for (const sourceId of sourceIds) {
        const source = await repos.l3Context.findSourceById(userId, sourceId);
        if (source) {
          sources.push({ id: source.id, title: source.title, content_text: source.content_text });
        }
      }

      return {
        sheet,
        questions: scoped.map((question): GradingContextQuestion => {
          const attempt = latestAttempt.get(question.id) ?? null;
          return {
            id: question.id,
            ordinal: question.ordinal,
            question_type: question.question_type,
            space: question.space,
            stem: question.stem,
            options: question.options,
            answerIndex: question.answer,
            explanation: question.explanation,
            source_id: question.source_id,
            attempt: attempt
              ? { answer: attempt.answer, self_assessment: attempt.self_assessment, created_at: attempt.created_at }
              : null,
            annotations: submittedByQuestion.get(question.id) ?? [],
          };
        }),
        sources,
      };
    });
  }

  /** 解析模式读面（owner）：该题纸 verdict 行集合；前端只消费此面（不带 answerIndex）。 */
  async getGradingResults(userId: string, sheetId: string): Promise<{
    sheet: L3SubmissionRow;
    results: L3GradingResultRow[];
  }> {
    return this.withActor(userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(userId, sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", sheetId);
      // W5：writing 稿解析模式读面走作文 feedback（generic 409）。
      if (sheet.scope === "writing") {
        throw new ConflictError("writing sheets use the writing feedback endpoints", undefined, {
          code: "WRITING_ENDPOINT_REQUIRED",
          sheetId,
        });
      }
      this.assertSealed(sheet, "grading results");
      return { sheet, results: await repos.l3Grading.listBySheet(userId, sheetId) };
    });
  }

  /** 写面：评卷提交（事务内 results upsert + 注记 review 写入 + stage 流转）。 */
  async submitGrading(input: SubmitL3GradingInput): Promise<{
    sheet: L3SubmissionRow;
    resultCount: number;
    annotationReviewCount: number;
    confirmedCount: number;
  }> {
    return this.withActor(input.userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(input.userId, input.sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", input.sheetId);
      // W5：writing 稿评卷写面走作文 feedback PUT（防两套反馈真源）。
      if (sheet.scope === "writing") {
        throw new ConflictError("writing sheets use the writing feedback endpoints", undefined, {
          code: "WRITING_ENDPOINT_REQUIRED",
          sheetId: input.sheetId,
        });
      }
      this.assertSealed(sheet, "grading");

      // ① questionId 越集校验（题纸作用域题目集）。
      const scoped = await resolveSheetScopedQuestions(repos, input.userId, sheet);
      const outOfScopeQuestions = findOutOfScopeIds(
        scoped.map((question) => question.id),
        input.results.map((result) => result.questionId),
      );
      if (outOfScopeQuestions.length > 0) {
        throw new BusinessRuleError("questionId is outside the sheet question scope", undefined, {
          outOfScopeQuestionIds: outOfScopeQuestions,
        });
      }

      // ② annotationId 越集校验（该题纸已提交注记集合：submitted/confirmed 可评，
      //    draft 未提交不授权、跨题纸污染拒绝——越集 422）。
      const annotations = await repos.l3Annotations.listAnnotationsBySheet(input.userId, input.sheetId);
      const reviewable = annotations.filter(
        (annotation) => annotation.stage === "submitted" || annotation.stage === "confirmed",
      );
      const reviewableById = new Map(reviewable.map((annotation) => [annotation.id, annotation]));
      const outOfScopeAnnotations = input.results
        .flatMap((result) => (result.annotationReviews ?? []).map((review) => review.annotationId))
        .filter((annotationId) => !reviewableById.has(annotationId));
      if (outOfScopeAnnotations.length > 0) {
        throw new BusinessRuleError("annotationId is not reviewable on this sheet", undefined, {
          outOfScopeAnnotationIds: outOfScopeAnnotations,
        });
      }

      // ③ results upsert（同键覆写 latest-wins；graded_by 已由路由层按服务端认定注入）。
      const rows = await repos.l3Grading.upsertResults(
        input.results.map((result) => ({
          user_id: input.userId,
          sheet_id: input.sheetId,
          question_id: result.questionId,
          verdict: result.verdict,
          analysis_md: result.analysisMd ?? null,
          graded_by: input.gradedBy,
        })),
      );

      // ④ 注记 review 白名单写入 + stage 流转（终态不回滚）。
      let annotationReviewCount = 0;
      let confirmedCount = 0;
      for (const result of input.results) {
        for (const review of result.annotationReviews ?? []) {
          const current = reviewableById.get(review.annotationId)!;
          const stage = nextAnnotationStage(current.stage, review.verdict);
          if (stage === "confirmed" && current.stage === "submitted") confirmedCount += 1;
          const updated = await repos.l3Annotations.applyAnnotationReview(
            input.userId,
            review.annotationId,
            toStoredAnnotationReview(review),
            stage,
            // F-1：来源题纸 = 本次评卷所属（前端据此标注「本轮/历史评卷」）。
            input.sheetId,
          );
          if (!updated) {
            // 并发竞态兜底（注记在事务期间被撤回/软删）——整体回滚。
            throw new ConflictError("annotation review write raced with a stage change", undefined, {
              annotationId: review.annotationId,
            });
          }
          annotationReviewCount += 1;
        }
      }

      return { sheet, resultCount: rows.length, annotationReviewCount, confirmedCount };
    });
  }

  /** owner 处置（D18）：submitted→confirmed；非 submitted → 409，缺行 → 404。 */
  async confirmAnnotation(userId: string, annotationId: string): Promise<{ item: L3QuestionAnnotationRow }> {
    return this.withActor(userId, async (repos) => {
      const updated = await repos.l3Annotations.confirmAnnotation(userId, annotationId);
      if (updated) return { item: updated };
      const existing = await repos.l3Annotations.getAnnotation(userId, annotationId);
      if (!existing) throw new NotFoundError("L3QuestionAnnotation", annotationId);
      throw new ConflictError("only submitted annotations can be confirmed", undefined, {
        annotationId,
        stage: existing.stage,
      });
    });
  }
}
