/**
 * Response contracts for the note-entry and wordbook read endpoints.
 *
 * 条目制笔记(2026-09-06):单文档 + 版本链的响应契约(wordNoteResponseSchema /
 * wordNoteUpsertResponseSchema / noteRevisionsResponseSchema / noteRestoreResponseSchema)
 * 随文档模型退场,由条目契约取代。
 */
import { z } from "zod";

export const noteEntrySchema = z.object({
  id: z.string(),
  content_md: z.string(),
  /** 非空 = 已隐藏(非破坏管理);恢复时置回 null。 */
  hidden_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

/** GET /api/words/:slug/notes — 词的全部笔记条目(含已隐藏)+ 隐藏计数。 */
export const wordNoteEntriesResponseSchema = z.object({
  entries: z.array(noteEntrySchema),
  hidden_count: z.number().int().nonnegative(),
}).strict();

/** POST/PUT/hide/restore 条目变更的统一响应。 */
export const noteEntryMutationResponseSchema = z.object({
  entry: noteEntrySchema,
}).strict();

/** DELETE 条目响应。 */
export const noteEntryDeleteResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

/** GET /api/notes — 笔记列表页(仅可见条目,创建时间倒序)。 */
export const noteListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    wordSlug: z.string(),
    wordLemma: z.string(),
    wordTitle: z.string(),
    contentMd: z.string(),
    createdAt: z.string(),
    /** 与基线契约保持同形(nullable),避免 differ 产生不可豁免的 UNKNOWN。 */
    updatedAt: z.string().nullable(),
  }).strict()),
  total: z.number().int().nonnegative(),
}).strict();

const wordbookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
}).strict();

export const wordbookListResponseSchema = z.object({
  items: z.array(wordbookSummarySchema),
  total: z.number().int().nonnegative(),
}).strict();

export const wordbookDefaultResponseSchema = wordbookSummarySchema;
