/**
 * L3SheetService — 题纸（会话信封）与作答历史（题级链）的编排（批次二，ADR-0034）。
 *
 * 边界：只碰 l3_submissions / l3_question_attempts / l3_question_annotations
 * （升格与总结条）；题归属校验借道 l3Paper / l3Context（RLS 已隔离，他人实体
 * 表现为不存在 → 404）。纯 owner 做题面，读也不开放给 agent（授权注册表登记）。
 *
 * 关键语义：
 * - 开纸幂等：作用域键冲突复用既有 draft 行（200），新建 201；
 * - 定格抢占：先条件 UPDATE（WHERE status='draft'）原子抢行，赢家才物化
 *   attempts / 升格注记——并发双 seal 不会双物化；
 * - 定格后 answers 清空（attempts 是唯一作答真源，拆双真相）；
 * - 未答题软确认：count>0 且未确认 → 409（details.unansweredCount 供前端复述）；
 * - 结果页派生：sealed 详情从 attempts 按作用域题序重排，deleted 行内容遮蔽
 *   （占位语义「作答记录已清理」由前端渲染，服务端不泄漏内容）。
 */

import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "../repositories/interfaces";
import type {
  L3QuestionAttemptRow,
  L3SheetArchiveRow,
  L3SubmissionRow,
} from "../domain";
import {
  buildAttemptSelfAssessment,
  buildSheetScopeKey,
  countRecheckQuestions,
  countUnansweredQuestions,
  sheetStatusAfterSeal,
  stripAnswerSubjectiveFields,
} from "../domain/l3-sheets";
import { resolveSheetScopedQuestions } from "./l3-sheet-scope";
import type {
  OpenL3SheetInput,
  PatchL3SheetInput,
  SealL3SheetInput,
} from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** deleted 行内容遮蔽：占位只暴露存在性（status/deleted_at），不泄漏作答内容。 */
function shadeAttempt(row: L3QuestionAttemptRow): L3QuestionAttemptRow {
  if (row.status !== "deleted") return row;
  return { ...row, answer: null, self_assessment: null };
}

export class L3SheetService {
  constructor(
    private readonly sheetRepo: IL3SheetRepository,
    private readonly paperRepo: IL3PaperRepository,
    private readonly annotationRepo: IL3AnnotationRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActor<T>(userId: string, callback: (repos: IRepositories) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx)), { actorId: userId });
  }

  /** 开纸：作用域键幂等（冲突复用既有 draft 行），归属校验 404 语义同批次一。 */
  async openSheet(input: OpenL3SheetInput): Promise<{ sheet: L3SubmissionRow; created: boolean }> {
    if (input.scope === "file") {
      if (!input.sourceId || !input.questionType) {
        throw new ValidationError("file scope requires sourceId and questionType", "scope");
      }
    } else if (!input.paperId) {
      throw new ValidationError("paper scope requires paperId", "paperId");
    }

    return this.withActor(input.userId, async (repos) => {
      if (input.scope === "file") {
        const source = await repos.l3Context.findSourceById(input.userId, input.sourceId as string);
        if (!source) throw new NotFoundError("L3Source", input.sourceId as string);
      } else {
        const paper = await repos.l3Paper.findPaperById(input.userId, input.paperId as string);
        if (!paper) throw new NotFoundError("L3Paper", input.paperId as string);
      }
      const scopeKey = input.scope === "file"
        ? buildSheetScopeKey({ scope: "file", sourceId: input.sourceId as string, questionType: input.questionType as string })
        : buildSheetScopeKey({ scope: "paper", paperId: input.paperId as string });
      const { row, created } = await repos.l3Sheets.openSheet({
        user_id: input.userId,
        scope: input.scope,
        scope_key: scopeKey,
        source_id: input.scope === "file" ? (input.sourceId as string) : null,
        question_type: input.scope === "file" ? (input.questionType as string) : null,
        paper_id: input.scope === "paper" ? (input.paperId as string) : null,
      });
      return { sheet: row, created };
    });
  }

  /**
   * 题纸详情：draft 含 answers（在写会话恢复）；settled（sealed/discarded）返回
   * 从 attempts 派生的逐题明细（按作用域题序），deleted 行内容遮蔽。
   */
  async getSheet(userId: string, sheetId: string): Promise<{ sheet: L3SubmissionRow; attempts: L3QuestionAttemptRow[] }> {
    return this.withActor(userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(userId, sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", sheetId);
      if (sheet.status === "draft") return { sheet, attempts: [] };

      const rows = await repos.l3Sheets.listBySheet(userId, sheetId);
      const scoped = await resolveSheetScopedQuestions(repos, userId, sheet);
      const orderByQuestion = new Map(scoped.map((question, index) => [question.id, index]));
      const ordered = [...rows].sort((a, b) => {
        const orderA = orderByQuestion.get(a.question_id) ?? Number.MAX_SAFE_INTEGER;
        const orderB = orderByQuestion.get(b.question_id) ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
      return { sheet, attempts: ordered.map(shadeAttempt) };
    });
  }

  /** 逐题 merge（null 清除）：非 draft → 409（条件 UPDATE 空转后二次判别 404/409）。 */
  async patchSheet(input: PatchL3SheetInput): Promise<{ sheet: L3SubmissionRow }> {
    return this.withActor(input.userId, async (repos) => {
      const updated = await repos.l3Sheets.patchAnswers(input.userId, input.sheetId, input.answers);
      if (updated) return { sheet: updated };
      const sheet = await repos.l3Sheets.getSheet(input.userId, input.sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", input.sheetId);
      // W3（ADR《writing-workspace》§4）：writing 稿必须走作文专用写面（CAS 保存契约）
      // ——通用 PATCH 不得成为旁路（服务端拦截，不是 UI 隐藏）。
      if (sheet.scope === "writing") {
        throw new ConflictError("writing sheets require the writing workspace endpoints", undefined, {
          code: "WRITING_ENDPOINT_REQUIRED",
          sheetId: input.sheetId,
        });
      }
      throw new ConflictError("L3 sheet is settled; answers are read-only", undefined, {
        sheetId: input.sheetId,
        status: sheet.status,
      });
    });
  }

  /**
   * 定格三档（事务内）：未答软确认 → 原子抢占（条件 UPDATE）→ 赢家物化。
   * full=物化 attempts + 注记升格 + sealed；incremental=注记升格 + discarded；
   * summary=总结条 + discarded。所有档位都清空 answers。
   */
  async sealSheet(input: SealL3SheetInput): Promise<{
    sheet: L3SubmissionRow;
    unansweredCount: number;
    recheckCount: number;
    materializedCount: number;
    promotedAnnotationCount: number;
  }> {
    return this.withActor(input.userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(input.userId, input.sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", input.sheetId);
      // W3（ADR《writing-workspace》§4）：writing 稿禁用通用定格三档——提交走专用
      // submit（正文物化进 attempt、稿号分配、版本 CAS 全在作文服务内收口）。
      if (sheet.scope === "writing") {
        throw new ConflictError("writing sheets require the writing workspace endpoints", undefined, {
          code: "WRITING_ENDPOINT_REQUIRED",
          sheetId: input.sheetId,
        });
      }
      if (sheet.status !== "draft") {
        throw new ConflictError("L3 sheet is settled", undefined, { sheetId: input.sheetId, status: sheet.status });
      }

      const summaryText = input.mode === "summary" ? (input.summary ?? "").trim() : null;
      if (input.mode === "summary" && !summaryText) {
        throw new ValidationError("summary is required for the summary mode", "summary");
      }

      const scoped = await resolveSheetScopedQuestions(repos, input.userId, sheet);
      if (input.mode === "summary" && scoped.length === 0) {
        throw new ValidationError("scoped questions are empty; cannot pin the summary note", "summary");
      }

      const scopedIds = scoped.map((question) => question.id);
      const unansweredCount = countUnansweredQuestions(scopedIds, sheet.answers);
      // v2 §10：待复查（flags.recheck）为流程状态——进软确认提示（不阻断）；复核修订：随 flags 整段物化。
      const recheckCount = countRecheckQuestions(scopedIds, sheet.answers);
      if (unansweredCount > 0 && !input.acknowledgeUnanswered) {
        throw new ConflictError("unanswered questions require soft confirmation", undefined, {
          unansweredCount,
          recheckCount,
        });
      }

      // 原子抢占：并发双 seal 只有一个赢家（条件 UPDATE 基于最新行版本重评估）。
      const settled = await repos.l3Sheets.sealSheet(input.userId, input.sheetId, {
        status: sheetStatusAfterSeal(input.mode),
        seal_mode: input.mode,
        summary: summaryText,
      });
      if (!settled) {
        throw new ConflictError("L3 sheet is settled", undefined, { sheetId: input.sheetId });
      }

      let materializedCount = 0;
      let promotedAnnotationCount = 0;
      if (input.mode === "full") {
        const answeredQuestions = scoped.filter((question) => sheet.answers[question.id] != null);
        if (answeredQuestions.length > 0) {
          const rows = await repos.l3Sheets.insertAttempts(
            input.userId,
            answeredQuestions.map((question) => ({
              question_id: question.id,
              sheet_id: input.sheetId,
              venue: sheet.scope,
              // v2 §2.1：attempt 只存作答事实（主观字段剥离，进 self_assessment）。
              answer: stripAnswerSubjectiveFields(sheet.answers[question.id]),
              // v2 §4.6/§10：当场主观状态快照（旗标+选项存疑+标记）；三键全空为 null。
              self_assessment: buildAttemptSelfAssessment(sheet.answers[question.id]),
            })),
          );
          materializedCount = rows.length;
        }
        promotedAnnotationCount = (await repos.l3Annotations.promoteBySheet(input.userId, input.sheetId)).length;
      } else if (input.mode === "incremental") {
        promotedAnnotationCount = (await repos.l3Annotations.promoteBySheet(input.userId, input.sheetId)).length;
      } else {
        await repos.l3Annotations.insertSummaryAnnotation({
          user_id: input.userId,
          question_id: scoped[0]!.id,
          sheet_id: input.sheetId,
          note: summaryText as string,
        });
      }

      return { sheet: settled, unansweredCount, recheckCount, materializedCount, promotedAnnotationCount };
    });
  }

  /** 批量题历史（题卡徽标数据源；过滤 deleted，1–200 已在上游收口）。 */
  async listAttempts(userId: string, questionIds: readonly string[]): Promise<{ items: L3QuestionAttemptRow[] }> {
    const ids = [...new Set(questionIds)].slice(0, 200);
    return this.withActor(userId, async (repos) => ({
      items: await repos.l3Sheets.listForQuestions(userId, ids),
    }));
  }

  /** 软删单条历史（再删 404）：删除改管理视图，不级联改写已发生的成绩。 */
  async deleteAttempt(userId: string, attemptId: string): Promise<{ deleted: true }> {
    return this.withActor(userId, async (repos) => {
      const deleted = await repos.l3Sheets.softDeleteAttempt(userId, attemptId);
      if (!deleted) throw new NotFoundError("L3QuestionAttempt", attemptId);
      return { deleted: true };
    });
  }

  /** F-1：题纸档案列表（回看闭环入口；draft/sealed 新→旧，含已评计数与展示标题）。 */
  async listArchive(userId: string, query: { limit: number }): Promise<{ items: L3SheetArchiveRow[] }> {
    return this.withActor(userId, async (repos) => ({
      items: await repos.l3Sheets.listArchive(userId, query.limit),
    }));
  }
}
