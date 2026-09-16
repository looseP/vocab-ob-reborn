/**
 * L3AnnotationService — 做题注记（原文分析条目）与规律标签字典（批次一，0033）。
 *
 * 边界：只碰 l3_question_annotations / l3_annotation_tags，归属校验借道
 * l3_questions（findQuestionById；RLS 已隔离，他人题表现为不存在 → 404）。
 * 锚点幂等在本层编排（有锚点先 findByAnchor，命中即返回不插行）；标签字典
 * 首次读取在同一事务内 lazy-seed 预置集。纯 owner 做题面，不向 agent 开放。
 */

import type { PoolClient } from "pg";
import { NotFoundError } from "../errors";
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
import type {
  CreateQuestionAnnotationInput,
  PatchQuestionAnnotationInput,
  ReplaceAnnotationTagsInput,
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
      if (!item) throw new NotFoundError("L3QuestionAnnotation", input.id);
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
