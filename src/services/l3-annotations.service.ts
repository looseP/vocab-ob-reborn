/**
 * L3AnnotationService — 做题注记（原文分析条目）与规律标签字典（批次一，0033）。
 *
 * 边界：只碰 l3_question_annotations / l3_annotation_tags，归属校验借道
 * l3_questions（findQuestionById；RLS 已隔离，他人题表现为不存在 → 404）。
 * 锚点幂等在本层编排（有锚点先 findByAnchor，命中即返回不插行）；标签字典
 * 首次读取在同一事务内 lazy-seed 预置集。纯 owner 做题面，不向 agent 开放。
 */

import type { PoolClient } from "pg";
import { ConflictError, NotFoundError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3PaperRepository,
  L3QuestionAnnotationPatchDb,
} from "../repositories/interfaces";
import type { L3AnnotationTagKind, L3AnnotationTagRow, L3QuestionAnnotationRow } from "../domain";
import { PRESET_ENTRY_TAGS, PRESET_OPTION_TAGS } from "../domain/l3-annotations";
import { buildSheetScopeKey } from "../domain/l3-sheets";
import type {
  CreateQuestionAnnotationInput,
  PatchQuestionAnnotationInput,
  ReplaceAnnotationTagsInput,
  WithdrawQuestionAnnotationInput,
} from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** camelCase PATCH → 库列 snake_case 白名单（仅拷贝显式提交的键，undefined 不落库）。 */
const PATCH_KEY_MAP: ReadonlyArray<[keyof PatchQuestionAnnotationInput, keyof L3QuestionAnnotationPatchDb]> = [
  ["anchorStart", "anchor_start"],
  ["anchorEnd", "anchor_end"],
  ["excerpt", "excerpt"],
  ["note", "note"],
  ["entryTags", "entry_tags"],
  ["optionTags", "option_tags"],
];

function groupTagRows(rows: L3AnnotationTagRow[]): { entry: string[]; option: string[] } {
  const pick = (kind: L3AnnotationTagKind) => rows.filter((row) => row.kind === kind).map((row) => row.label);
  return { entry: pick("entry"), option: pick("option") };
}

export class L3AnnotationService {
  constructor(
    private readonly annotationRepo: IL3AnnotationRepository,
    private readonly paperRepo: IL3PaperRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActor<T>(userId: string, callback: (repos: IRepositories) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx)), { actorId: userId });
  }

  async listForQuestions(
    userId: string,
    questionIds: readonly string[],
  ): Promise<{ items: L3QuestionAnnotationRow[] }> {
    const ids = [...new Set(questionIds)].slice(0, 200);
    return this.withActor(userId, async (repos) => ({
      items: await repos.l3Annotations.listForQuestions(userId, ids),
    }));
  }

  async createAnnotation(
    input: CreateQuestionAnnotationInput,
  ): Promise<{ item: L3QuestionAnnotationRow; idempotent: boolean }> {
    return this.withActor(input.userId, async (repos) => {
      const question = await repos.l3Paper.findQuestionById(input.userId, input.questionId);
      if (!question) throw new NotFoundError("L3Question", input.questionId);

      // 批次二：带 sheetId 的创建 = 挂题纸的草稿注记（stage='draft'，随定格升格）。
      // 题纸不存在/非属主 → 404；已定格/已弃 → 409（草稿注记只能在在写题纸上产生）。
      let stage: "draft" | "confirmed" = "confirmed";
      let sheetId: string | null = null;
      if (input.sheetId) {
        const sheet = await repos.l3Sheets.getSheet(input.userId, input.sheetId);
        if (!sheet) throw new NotFoundError("L3Sheet", input.sheetId);
        if (sheet.status !== "draft") {
          throw new ConflictError("L3 sheet is settled; draft notes require a draft sheet", undefined, {
            sheetId: input.sheetId,
            status: sheet.status,
          });
        }
        stage = "draft";
        sheetId = input.sheetId;
      }

      if (input.anchorStart != null && input.anchorEnd != null) {
        const existing = await repos.l3Annotations.findByAnchor(
          input.userId,
          input.questionId,
          input.anchorStart,
          input.anchorEnd,
        );
        if (existing) return { item: existing, idempotent: true };
      }

      const item = await repos.l3Annotations.insertAnnotation({
        user_id: input.userId,
        question_id: input.questionId,
        anchor_start: input.anchorStart,
        anchor_end: input.anchorEnd,
        excerpt: input.excerpt,
        note: input.note,
        entry_tags: input.entryTags,
        option_tags: input.optionTags,
        stage,
        sheet_id: sheetId,
      });
      return { item, idempotent: false };
    });
  }

  async patchAnnotation(input: PatchQuestionAnnotationInput): Promise<{ item: L3QuestionAnnotationRow }> {
    return this.withActor(input.userId, async (repos) => {
      const dbPatch: L3QuestionAnnotationPatchDb = {};
      for (const [from, to] of PATCH_KEY_MAP) {
        const value = input[from];
        if (value !== undefined) {
          type Target = L3QuestionAnnotationPatchDb[keyof L3QuestionAnnotationPatchDb];
          (dbPatch as Record<string, unknown>)[to] = value as Target;
        }
      }
      const item = await repos.l3Annotations.updateAnnotation(input.userId, input.id, dbPatch);
      if (item) return { item };
      // v2 §4.7 守卫判别：条件 UPDATE 空转 → 缺行 404 / submitted 锁定 409（走撤回）。
      const existing = await repos.l3Annotations.getAnnotation(input.userId, input.id);
      if (!existing) throw new NotFoundError("L3QuestionAnnotation", input.id);
      throw new ConflictError("annotation is submitted (locked); withdraw it before editing", undefined, {
        annotationId: input.id,
        stage: existing.stage,
      });
    });
  }

  /**
   * v2 §4.7 撤回通道：submitted→draft + 重挂题纸（下次定格随新题纸重新升格）。
   * sheetId 缺省时借原题纸作用域幂等开新纸；提供的 sheetId 必须是本人在写 draft。
   */
  async withdrawAnnotation(input: WithdrawQuestionAnnotationInput): Promise<{ item: L3QuestionAnnotationRow }> {
    return this.withActor(input.userId, async (repos) => {
      const annotation = await repos.l3Annotations.getAnnotation(input.userId, input.id);
      if (!annotation) throw new NotFoundError("L3QuestionAnnotation", input.id);
      if (annotation.stage !== "submitted") {
        throw new ConflictError("only submitted annotations can be withdrawn", undefined, {
          annotationId: input.id,
          stage: annotation.stage,
        });
      }

      let sheetId: string;
      if (input.sheetId) {
        const sheet = await repos.l3Sheets.getSheet(input.userId, input.sheetId);
        if (!sheet) throw new NotFoundError("L3Sheet", input.sheetId);
        if (sheet.status !== "draft") {
          throw new ConflictError("a draft sheet is required to withdraw", undefined, {
            sheetId: input.sheetId,
            status: sheet.status,
          });
        }
        sheetId = sheet.id;
      } else {
        // 无上下文题纸：借原题纸作用域幂等开新纸（file→source+questionType；paper→paperId）。
        const origin = annotation.sheet_id
          ? await repos.l3Sheets.getSheet(input.userId, annotation.sheet_id)
          : null;
        if (!origin) {
          throw new ConflictError("annotation has no sheet context to reopen", undefined, {
            annotationId: input.id,
          });
        }
        const scopeKey = origin.scope === "file"
          ? (origin.source_id && origin.question_type
            ? buildSheetScopeKey({ scope: "file", sourceId: origin.source_id, questionType: origin.question_type })
            : null)
          : (origin.paper_id
            ? buildSheetScopeKey({ scope: "paper", paperId: origin.paper_id })
            : null);
        if (!scopeKey) {
          throw new ConflictError("origin sheet scope is incomplete", undefined, { sheetId: origin.id });
        }
        const { row } = await repos.l3Sheets.openSheet({
          user_id: input.userId,
          scope: origin.scope,
          scope_key: scopeKey,
          source_id: origin.source_id,
          question_type: origin.question_type,
          paper_id: origin.paper_id,
          // 重开的是同一张纸的同一作用域：沿用来源纸的题单快照（不重算——
          // 重算会把来源纸开纸之后加入的题算进来）。来源纸未定格则留 null。
          question_ids: origin.question_ids,
        });
        sheetId = row.id;
      }

      const item = await repos.l3Annotations.withdrawAnnotation(input.userId, input.id, sheetId);
      if (!item) {
        throw new ConflictError("annotation is no longer withdrawable", undefined, { annotationId: input.id });
      }
      return { item };
    });
  }

  async deleteAnnotation(userId: string, id: string): Promise<{ deleted: true }> {
    return this.withActor(userId, async (repos) => {
      const deleted = await repos.l3Annotations.softDeleteAnnotation(userId, id);
      if (!deleted) throw new NotFoundError("L3QuestionAnnotation", id);
      return { deleted: true };
    });
  }

  async getTagDict(userId: string): Promise<{ entry: string[]; option: string[] }> {
    return this.withActor(userId, async (repos) => {
      const existing = await repos.l3Annotations.listTags(userId);
      if (existing.length > 0) return groupTagRows(existing);
      // 首次读取：同事务 lazy-seed 冻结预置集，用户随后可在字典上增删改。
      const seeded = await repos.l3Annotations.replaceTags(userId, {
        entry: [...PRESET_ENTRY_TAGS],
        option: [...PRESET_OPTION_TAGS],
      });
      return groupTagRows(seeded);
    });
  }

  async replaceTagDict(input: ReplaceAnnotationTagsInput): Promise<{ entry: string[]; option: string[] }> {
    return this.withActor(input.userId, async (repos) => {
      const rows = await repos.l3Annotations.replaceTags(input.userId, {
        entry: input.entry,
        option: input.option,
      });
      return groupTagRows(rows);
    });
  }
}
