/**
 * Daily capture response contracts（2026-10-10，M1 捕获侧）。
 *
 * 行 schema 取 domain 导出的类型（单一真源：`src/domain/daily-capture.ts`），
 * 全部 `.strict()`。日文件投影是 text/markdown（不走 JSON 契约，同题纸/
 * 作文/笔记导出先例——operations 里 response schema 为 z.string()）。
 */
import { z } from "zod";
import type {
  DailyCaptureAbsorptionReceipt,
  DailyCaptureDayEntry,
  DailyCaptureDaySummary,
  DailyCaptureEntryMeta,
  DailyCaptureEntryRow,
  DailyCaptureEvidencePack,
  DailyCaptureTypeRow,
  DailyCaptureWordSignal,
} from "../domain/daily-capture";

export const dailyCaptureMetaResponseSchema: z.ZodType<DailyCaptureEntryMeta> = z
  .object({
    meaning: z.string().optional(),
    translation: z.string().optional(),
    sourceUrl: z.string().optional(),
    obsidianRef: z.string().optional(),
    wordSlugs: z.array(z.string()).optional(),
    important: z.boolean().optional(),
  })
  .strict();

export const dailyCaptureAbsorptionReceiptSchema: z.ZodType<DailyCaptureAbsorptionReceipt> = z
  .object({
    action: z.enum(["bind_l3", "add_word", "enqueue_review", "file_method", "rewrite", "none"]),
    target: z.string().nullable(),
    id: z.string().nullable(),
    at: z.string(),
    word_slug: z.string().nullable(),
    deduped: z.boolean().optional(),
  })
  .strict();

export const dailyCaptureTypeResponseSchema: z.ZodType<DailyCaptureTypeRow> = z
  .object({
    user_id: z.string(),
    type_key: z.string(),
    label: z.string(),
    absorption_hint: z.string().nullable(),
    sort: z.number().int(),
    hidden: z.boolean(),
    created_at: z.string(),
  })
  .strict();

/** 行字段形状（单一真源）——行 schema 与日视图条目 schema 共用，避免两处列名漂移。 */
const dailyCaptureEntryFields = {
  id: z.string(),
  user_id: z.string(),
  entry_date: z.string(),
  seq: z.number().int(),
  entry_type: z.string(),
  content: z.string(),
  meta: dailyCaptureMetaResponseSchema.nullable(),
  status: z.enum(["raw", "reviewed", "absorbed", "archived"]),
  absorption: z.array(dailyCaptureAbsorptionReceiptSchema).nullable(),
  created_at: z.string(),
  hidden_at: z.string().nullable(),
} as const;

export const dailyCaptureEntryResponseSchema: z.ZodType<DailyCaptureEntryRow> = z
  .object(dailyCaptureEntryFields)
  .strict();

export const dailyCaptureTypesResponseSchema = z
  .object({
    types: z.array(dailyCaptureTypeResponseSchema),
  })
  .strict();

/** 词信号（读时投影）：日视图条目 ⤳ [[slug]] 上那个词的当前状态。 */
export const dailyCaptureWordSignalResponseSchema: z.ZodType<DailyCaptureWordSignal> = z
  .object({
    slug: z.string(),
    state: z.enum(["stub", "ready", "gone"]),
    hasDefinition: z.boolean(),
    l2Promoted: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .strict();

/**
 * 日视图条目 = 行 + 读时词信号（`wordSignals` 必填，可为空数组）。
 *
 * 吸收/回顾响应仍用行 schema（`dailyCaptureEntryResponseSchema`）——那里是写路径
 * 回执，不投影信号；前端合并时保留旧条目的 `wordSignals`（见 DailyCapturePage）。
 */
export const dailyCaptureDayEntryResponseSchema: z.ZodType<DailyCaptureDayEntry> = z
  .object({ ...dailyCaptureEntryFields, wordSignals: z.array(dailyCaptureWordSignalResponseSchema) })
  .strict();

export const dailyCaptureDayResponseSchema = z
  .object({
    date: z.string(),
    /** 投影时刻（整个响应一个时钟；语义是"每次读取最新一版"，非账本烙死值）。 */
    observedAt: z.string(),
    types: z.array(dailyCaptureTypeResponseSchema),
    entries: z.array(dailyCaptureDayEntryResponseSchema),
  })
  .strict();

export const dailyCaptureDaySummaryResponseSchema: z.ZodType<DailyCaptureDaySummary> = z
  .object({
    date: z.string(),
    total: z.number().int(),
    raw: z.number().int(),
    reviewed: z.number().int(),
    absorbed: z.number().int(),
  })
  .strict();

export const dailyCaptureDaysResponseSchema = z
  .object({
    days: z.array(dailyCaptureDaySummaryResponseSchema),
  })
  .strict();

// ── M3：证据包（agent 唯一读面）+ 吸收响应 ──────────────────────────────────

const dailyCaptureEvidenceWordSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    lemma: z.string(),
    ipa: z.string().nullable(),
    short_definition: z.string().nullable(),
    existing_context_count: z.number().int(),
    signal: dailyCaptureWordSignalResponseSchema,
  })
  .strict();

const dailyCaptureEvidenceEntrySchema = z
  .object({
    seq: z.number().int(),
    id: z.string(),
    entry_type: z.string(),
    label: z.string().nullable(),
    absorption_hint: z.string().nullable(),
    content: z.string(),
    status: z.enum(["raw", "reviewed", "absorbed", "archived"]),
    meta: dailyCaptureMetaResponseSchema.nullable(),
    created_at: z.string(),
    words: z.array(dailyCaptureEvidenceWordSchema),
  })
  .strict();

export const dailyCaptureEvidencePackResponseSchema: z.ZodType<DailyCaptureEvidencePack> = z
  .object({
    version: z.literal(1),
    date: z.string(),
    markdown: z.string(),
    entries: z.array(dailyCaptureEvidenceEntrySchema),
  })
  .strict();

export const dailyCaptureAbsorbResponseSchema = z
  .object({
    entry: dailyCaptureEntryResponseSchema,
    receipt: dailyCaptureAbsorptionReceiptSchema,
  })
  .strict();
