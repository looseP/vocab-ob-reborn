/**
 * HTTP input schemas — ported from v1's lib/validation/schemas.ts.
 *
 * These validate raw HTTP input (URL params, JSON body). They use z.coerce
 * for URL string→number conversion and .default() for missing fields.
 * The Service layer receives already-parsed strong types derived from these.
 */

import { z } from "zod";
import {
  assertJsonResourceBudget,
  JSON_MAX_DEPTH,
  JSON_RECORD_MAX_BYTES,
  L3_PROPOSAL_MAX_ITEMS,
  L3_PROPOSAL_PAYLOAD_MAX_BYTES,
  L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
  VOCAB_IMPORT_CONTENT_MAX_BYTES,
  VOCAB_IMPORT_MAX_FILES,
  VOCAB_IMPORT_PATH_MAX_LENGTH,
} from "../resource-budget";
import {
  L3_PRACTICE_OUTCOMES,
  L3_PRACTICE_TYPES,
  L3_SUB_SPACES,
} from "../../services/l3-practice.service";
import {
  L3_SESSION_DEFAULT_CONTEXTS,
  L3_SESSION_END_STATUSES,
  L3_SESSION_MAX_CONTEXTS,
  L3_SESSION_MAX_DAYS,
  L3_SESSION_TYPES,
} from "../../services/l3-session.service";

// ── Primitives ──────────────────────────────────────────────────────────
export const reviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export const uuidSchema = z.string().uuid();

// ── Shared vocabulary (ADR-0017) ────────────────────────────────────────
/** 学习方向三值（ADR-0017；wordbooks/l2/l3 表 CHECK 同值）。 */
export const directionSchema = z.enum(["通用", "考研", "雅思"]);

// ── Words ───────────────────────────────────────────────────────────────
export const wordsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(60),
  offset: z.coerce.number().int().min(0).optional().default(0),
  q: z.string().max(200).optional(),
  cefr: z.string().max(10).optional(),
  review: z.enum(["all", "tracked", "due", "untracked"]).optional().default("all"),
  wordbookId: uuidSchema.optional(),
});

// L1-2：输入联想查询参数——q 必填、上限小（联想只需少量结果）。
export const wordSuggestQuerySchema = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

// ── Plaza（词汇广场 · P4）──────────────────────────────────────────────
// 注意：/api/plaza 契约冻结为语义场（含历史兼容），词根词缀走独立端点
// /api/plaza/roots，避免响应契约变更触发 verify-openapi-breaking 门禁。
export const plazaQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
});

/** 词根词缀广场查询参数（P4）：minCount 最小家族规模、q 词根子串、letter 首字母。 */
export const plazaRootsQuerySchema = z.object({
  minCount: z.coerce.number().int().min(1).max(200).optional().default(3),
  q: z.string().trim().max(100).optional(),
  letter: z.string().regex(/^[a-zA-Z]$/).optional(),
});

// Mirrors the manual sanitization in routes/words.ts POST /batch: every field
// is optional (slug falls back to lemma, then title) and rows without a
// non-empty sanitized slug are dropped server-side.
export const wordBatchCreateItemSchema = z.object({
  slug: z.string().optional(),
  title: z.string().optional(),
  lemma: z.string().optional(),
  pos: z.string().optional(),
  cefr: z.string().optional(),
  ipa: z.string().optional(),
  short_definition: z.string().optional(),
});

export const wordBatchCreateSchema = z.object({
  words: z.array(wordBatchCreateItemSchema).min(1).max(500),
});

// ── Review ──────────────────────────────────────────────────────────────
export const reviewAnswerSchema = z.object({
  progressId: uuidSchema,
  rating: reviewRatingSchema,
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
  // Mode-aware side-effect boundary (P0): cram is a no-persistence self-test.
  mode: z.enum(["review", "cram", "preview", "zen"]).optional(),
});

export const reviewSkipSchema = z.object({
  progressId: uuidSchema,
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const reviewSuspendSchema = z.object({
  progressId: uuidSchema,
  sessionId: uuidSchema.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const reviewUndoSchema = z.object({
  reviewLogId: z.string().min(1),
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const clearL1WeakSignalSchema = z.object({
  wordId: uuidSchema,
  wordbookId: uuidSchema.optional(),
});

export const reviewRejoinSchema = z.object({
  progressId: uuidSchema,
});

export const reviewSettingsSchema = z.object({
  desiredRetention: z.number().min(0.7).max(0.99),
  retuneExisting: z.boolean().optional().default(false),
  wordbookId: uuidSchema.optional(),
});

export const addToReviewSchema = z.object({
  wordId: uuidSchema,
  wordbookId: uuidSchema.optional(),
});

export const batchAddToReviewSchema = z.object({
  wordIds: z.array(uuidSchema).min(1).max(100),
  wordbookId: uuidSchema.optional(),
});

// ── L2 drill mode (双轨 spec) ─────────────────────────────────────────────
// 辨析步应答：choiceIndex 为选项下标（0-3）。幂等键全局共享（不限 track）。
export const l2TaskAnswerSchema = z.object({
  sessionId: uuidSchema,
  stepId: uuidSchema,
  choiceIndex: z.number().int().min(0).max(3),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

// 产出步自评：verdict 不带 FSRS，只回填能力阶段（spec D6'）。
export const l2SelfAssessSchema = z.object({
  sessionId: uuidSchema,
  stepId: uuidSchema,
  verdict: z.enum(["passed", "weak"]),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

// 撤销本会话最近一步：仅产出自评可撤（spec 红线）。
export const l2UndoSchema = z.object({
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const batchAddFromContentSchema = z.object({
  content: z.string().min(1).max(200_000),
  wordbookId: uuidSchema.optional(),
  dryRun: z.boolean().optional(),
  autoEnqueue: z.boolean().optional().default(true),
});

// ── Reading capture (R1) ────────────────────────────────────────────────
export const captureRequestSchema = z.object({
  headword: z.string().trim().min(1).max(120),
  sentence: z.string().trim().min(1).max(4000).optional(),
  sourceUrl: z.string().url().max(2048).optional(),
  obsidianRef: z.string().min(1).max(1024).optional(),
  wordbookId: uuidSchema.optional(),
});

// ── Note entries(条目制笔记,2026-09-06)────────────────────────────────
// 追加式写入:1 请求 = 1 条;无乐观锁/无快照语义(文档模型的 expected_version/snapshot 已随版本链退场)。
export const noteEntryUpsertRequestSchema = z.object({
  content_md: z.string().trim().min(1, "笔记内容不能为空").max(20_000),
});

// ── Wordbooks ───────────────────────────────────────────────────────────
export const wordbookCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const wordbookAddWordsSchema = z.object({
  wordIds: z.array(uuidSchema).min(1).max(500),
});

// ── Highlights ──────────────────────────────────────────────────────────
export const highlightCreateSchema = z.object({
  word_id: uuidSchema,
  source_field: z.string().max(100).default("definition_md"),
  text_snippet: z.string().min(1).max(10_000),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#eab308"),
});

// ── Annotations ─────────────────────────────────────────────────────────
export const annotationUpsertSchema = z.object({
  word_id: uuidSchema,
  content: z.string().max(50_000),
});

// ── Quality ─────────────────────────────────────────────────────────────
export const qualityStrictnessSchema = z.enum(["lenient", "standard", "strict"]).default("standard");

// ── Vocab-note import (P3) ─────────────────────────────────────────────
export const vocabNotesImportFileSchema = z.object({
  /** Vault-relative note path, e.g. "L1_雅思词汇/accelerate.md". */
  path: z.string().trim().min(1).max(VOCAB_IMPORT_PATH_MAX_LENGTH),
  content: z.string().min(1).max(VOCAB_IMPORT_CONTENT_MAX_BYTES),
  updatedAt: z.string().datetime().nullish(),
});

export const vocabNotesImportRequestSchema = z.object({
  files: z.array(vocabNotesImportFileSchema).min(1).max(VOCAB_IMPORT_MAX_FILES),
  dryRun: z.boolean().optional(),
  strictness: qualityStrictnessSchema.optional(),
});

// ── L3 context space ───────────────────────────────────────────────────
function withinJsonBudget(value: unknown, maxBytes: number): boolean {
  try {
    assertJsonResourceBudget(value, { maxBytes, maxDepth: JSON_MAX_DEPTH });
    return true;
  } catch {
    return false;
  }
}

const jsonRecordSchema = z.record(z.string(), z.unknown())
  .refine((value) => withinJsonBudget(value, JSON_RECORD_MAX_BYTES), {
    message: `JSON object exceeds ${JSON_RECORD_MAX_BYTES} bytes or depth ${JSON_MAX_DEPTH}`,
  })
  .default({});

const proposalPayloadSchema = z.record(z.string(), z.unknown())
  .refine((value) => withinJsonBudget(value, L3_PROPOSAL_PAYLOAD_MAX_BYTES), {
    message: `Proposal payload exceeds ${L3_PROPOSAL_PAYLOAD_MAX_BYTES} bytes or depth ${JSON_MAX_DEPTH}`,
  });

export const l3SourceCreateSchema = z.object({
  wordbookId: uuidSchema.nullish(),
  sourceType: z.enum(["article", "book", "video", "audio", "chat", "manual", "web", "other"]),
  title: z.string().trim().min(1).max(500),
  contentText: z.string().min(1).optional(),
  author: z.string().max(300).nullish(),
  url: z.string().url().max(2_000).nullish(),
  language: z.string().max(50).nullish(),
  metadata: jsonRecordSchema.optional(),
});

export const l3ContextCreateSchema = z.object({
  sourceId: uuidSchema,
  contextType: z.enum(["sentence", "paragraph", "excerpt", "dialogue", "note"]),
  text: z.string().min(1).max(100_000),
  normalizedText: z.string().max(100_000).nullish(),
  language: z.string().max(50).nullish(),
  position: jsonRecordSchema.optional(),
  metadata: jsonRecordSchema.optional(),
});

export const l3OccurrenceCreateSchema = z.object({
  contextId: uuidSchema,
  wordId: uuidSchema.optional(),
  slug: z.string().min(1).max(200).optional(),
  surface: z.string().min(1).max(500),
  lemma: z.string().max(500).nullish(),
  startOffset: z.number().int().min(0).nullish(),
  endOffset: z.number().int().min(0).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  evidence: jsonRecordSchema.optional(),
}).refine((value) => Boolean(value.wordId || value.slug), {
  message: "wordId or slug is required",
  path: ["wordId"],
});

// link 类型 / 目标类型的单一词表（create 校验与 list 过滤共用；与 l3 表 CHECK 同值）。
const l3ContextLinkTypeSchema = z.enum([
  "supports",
  "illustrates",
  "contrasts",
  "collocates_with",
  "synonym_of",
  "antonym_of",
  "derived_from",
  "topic_related",
  "manual_link",
]);
const l3ContextLinkTargetTypeSchema = z.enum(["word", "l2_item", "context", "source", "topic", "external"]);

export const l3ContextLinkCreateSchema = z.object({
  contextId: uuidSchema.nullish(),
  wordId: uuidSchema.nullish(),
  linkType: l3ContextLinkTypeSchema,
  targetType: l3ContextLinkTargetTypeSchema,
  targetId: z.string().max(500).nullish(),
  targetRef: jsonRecordSchema.optional(),
  confidence: z.number().min(0).max(1).nullish(),
  provenance: jsonRecordSchema.optional(),
}).refine((value) => Boolean(value.contextId || value.wordId), {
  message: "contextId or wordId is required",
  path: ["contextId"],
});

export const l3SelectionCaptureSchema = z.object({
  text: z.string().trim().min(1),
  anchorStart: z.number().int().min(0),
  anchorEnd: z.number().int().min(0),
  surface: z.string().trim().min(1),
  wordSlug: z.string().trim().min(1),
  contextType: z.enum(["sentence", "excerpt"]).optional(),
  /** 语境义快照（Bound sense）：圈记时绑定的释义/搭配文本，空串归一为 null。 */
  boundSense: z.string().trim().max(2_000).nullish(),
}).refine((v) => v.anchorEnd > v.anchorStart, { message: "anchorEnd must be > anchorStart", path: ["anchorEnd"] });

export const quickL3ContextSchema = z.object({
  slug: z.string().min(1),
  text: z.string().trim().min(1),
  sourceTitle: z.string().trim().optional(),
  sourceUrl: z.string().trim().optional(),
  obsidianRef: z.string().trim().optional(),
  /** 语境义快照（Bound sense）：快记时绑定的释义/搭配文本，空串归一为 null。 */
  boundSense: z.string().trim().max(2_000).nullish(),
});

export const l3LimitCursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
});

// ADR-0029 §6②：词语境列表按方向 / 子空间过滤（与 sources 书架同一过滤轴）。
export const l3WordContextListQuerySchema = l3LimitCursorQuerySchema.extend({
  direction: directionSchema.optional(),
  space: z.enum(L3_SUB_SPACES).optional(),
});

// ── L3 evidence lists (ADR-0029 §6①) ───────────────────────────────────
// occurrences / context-links 的只读列表：cursor 分页沿用 l3LimitCursorQuerySchema，
// 可按词（slug / wordId）、语境与空间 / 方向两轴过滤（"按空间方向列料"）。
export const l3OccurrenceListQuerySchema = l3LimitCursorQuerySchema.extend({
  slug: z.string().trim().min(1).max(200).optional(),
  wordId: uuidSchema.optional(),
  contextId: uuidSchema.optional(),
  direction: directionSchema.optional(),
  space: z.enum(L3_SUB_SPACES).optional(),
});

export const l3ContextLinkListQuerySchema = l3LimitCursorQuerySchema.extend({
  slug: z.string().trim().min(1).max(200).optional(),
  wordId: uuidSchema.optional(),
  contextId: uuidSchema.optional(),
  linkType: l3ContextLinkTypeSchema.optional(),
  targetType: l3ContextLinkTargetTypeSchema.optional(),
  direction: directionSchema.optional(),
  space: z.enum(L3_SUB_SPACES).optional(),
});

export const l3SourceListQuerySchema = z.object({
  sourceType: z.enum(["article", "book", "video", "audio", "chat", "manual", "web", "other"]).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["recent", "captures"]).default("recent"),
  // ADR-0029 §6②：按方向 / 子空间过滤（"按空间方向列料"，与练习线两轴同义）。
  direction: directionSchema.optional(),
  space: z.enum(L3_SUB_SPACES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const l3WordSpaceQuerySchema = z.object({
  wordbookId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
});

export const l3SourceSpaceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
});

export const l3GraphQuerySchema = z.object({
  wordbookId: uuidSchema.optional(),
  slug: z.string().trim().min(1).max(200).optional(),
  sourceId: uuidSchema.optional(),
  // Repository currently returns a bounded one-hop graph only. Reject depth=2
  // instead of silently returning the same result as depth=1.
  depth: z.coerce.number().int().min(1).max(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(300).optional().default(100),
  cursor: z.string().min(1).optional(),
});

// B1 空间汇总（素材宇宙）：生长趋势窗口天数（1-90，默认 30）。
export const l3SpaceSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

export const l3ProposalItemCreateSchema = z.object({
  itemType: z.enum(["source", "context", "occurrence", "context_link"]),
  clientRef: z.string().trim().min(1).max(200).nullish(),
  payload: proposalPayloadSchema,
});

export const l3ProposalCreateSchema = z.object({
  wordbookId: uuidSchema.nullish(),
  sourceType: z.enum(["agent", "import", "external_tool", "manual_draft", "mcp_future", "other"]),
  title: z.string().trim().min(1).max(500).nullish(),
  summary: z.string().max(2_000).nullish(),
  inputHash: z.string().max(256).nullish(),
  proposedBy: z.string().max(300).nullish(),
  provenance: jsonRecordSchema.optional(),
  items: z.array(l3ProposalItemCreateSchema).min(1).max(L3_PROPOSAL_MAX_ITEMS),
}).refine(
  (value) => withinJsonBudget(
    value.items.map((item) => item.payload),
    L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
  ),
  {
    message: `Proposal payloads exceed ${L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES} total bytes`,
    path: ["items"],
  },
);

export const l3ProposalListQuerySchema = z.object({
  status: z.enum(["pending", "confirmed", "rejected", "canceled"]).optional().default("pending"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
});

export const l3ProposalRejectSchema = z.object({
  reviewNote: z.string().max(2_000).nullish(),
});

export const l3RecommendationGenerateSchema = z.object({
  wordbookId: uuidSchema.nullish(),
  mode: z.enum(["review_pack", "learn_next", "gap_scan", "link_suggestions"]),
  seedSlug: z.string().trim().min(1).max(200).nullish(),
  limit: z.number().int().min(1).max(100).nullish(),
  horizonDays: z.number().int().min(1).max(90).nullish(),
  dryRun: z.boolean().nullish(),
});

export const l3RecommendationListQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "rejected", "dismissed", "expired"]).optional().default("pending"),
  recommendationType: z.enum([
    "review_pack",
    "learn_next",
    "link_gap",
    "context_gap",
    "l2_gap",
    "weak_word",
    "related_word",
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
});

export const l3RecommendationRejectSchema = z.object({
  reviewNote: z.string().max(2_000).nullish(),
});

const l3ImportSourceSchema = z.object({
  sourceType: z.enum(["article", "book", "video", "audio", "chat", "manual", "web", "other"]),
  title: z.string().trim().min(1).max(500),
  author: z.string().max(300).nullish(),
  url: z.string().url().max(2_000).nullish(),
  language: z.string().max(50).nullish(),
  metadata: jsonRecordSchema.optional(),
});

const l3ImportTargetWordSchema = z.object({
  wordId: uuidSchema.optional(),
  slug: z.string().trim().min(1).max(200).optional(),
}).refine((value) => Boolean(value.wordId || value.slug), {
  message: "wordId or slug is required",
  path: ["wordId"],
});

const l3RawTextImportOptionsSchema = z.object({
  contextType: z.enum(["sentence", "paragraph"]).optional().default("sentence"),
  maxContexts: z.number().int().min(1).max(200).optional(),
  minContextLength: z.number().int().min(1).max(10_000).optional(),
  maxOccurrencesPerWordPerContext: z.number().int().min(1).max(50).optional(),
}).optional();

export const l3RawTextImportCreateSchema = z.object({
  wordbookId: uuidSchema.nullish(),
  source: l3ImportSourceSchema,
  text: z.string().min(1).max(500_000),
  targetWords: z.array(l3ImportTargetWordSchema).max(200).optional().default([]),
  options: l3RawTextImportOptionsSchema,
  provenance: jsonRecordSchema.optional(),
});

const l3StructuredImportOccurrenceSchema = z.object({
  wordId: uuidSchema.optional(),
  slug: z.string().trim().min(1).max(200).optional(),
  surface: z.string().min(1).max(500),
  lemma: z.string().max(500).nullish(),
  startOffset: z.number().int().min(0).nullish(),
  endOffset: z.number().int().min(0).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  evidence: jsonRecordSchema.optional(),
}).refine((value) => Boolean(value.wordId || value.slug), {
  message: "wordId or slug is required",
  path: ["wordId"],
});

const l3StructuredImportLinkSchema = z.object({
  wordId: uuidSchema.nullish(),
  linkType: z.enum([
    "supports",
    "illustrates",
    "contrasts",
    "collocates_with",
    "synonym_of",
    "antonym_of",
    "derived_from",
    "topic_related",
    "manual_link",
  ]),
  targetType: z.enum(["word", "l2_item", "context", "source", "topic", "external"]),
  targetId: z.string().max(500).nullish(),
  targetRef: jsonRecordSchema.optional(),
  confidence: z.number().min(0).max(1).nullish(),
  provenance: jsonRecordSchema.optional(),
});

const l3StructuredImportContextSchema = z.object({
  clientRef: z.string().trim().min(1).max(200).nullish(),
  contextType: z.enum(["sentence", "paragraph", "excerpt", "dialogue", "note"]),
  text: z.string().min(1).max(100_000),
  normalizedText: z.string().max(100_000).nullish(),
  language: z.string().max(50).nullish(),
  position: jsonRecordSchema.optional(),
  metadata: jsonRecordSchema.optional(),
  occurrences: z.array(l3StructuredImportOccurrenceSchema).max(500).optional().default([]),
  links: z.array(l3StructuredImportLinkSchema).max(500).optional().default([]),
});

export const l3StructuredImportCreateSchema = z.object({
  wordbookId: uuidSchema.nullish(),
  source: l3ImportSourceSchema,
  contexts: z.array(l3StructuredImportContextSchema).min(1).max(200),
  provenance: jsonRecordSchema.optional(),
}).refine(
  (value) => 1 + value.contexts.reduce(
    (total, context) => total + 1 + context.occurrences.length + context.links.length,
    0,
  ) <= L3_PROPOSAL_MAX_ITEMS,
  {
    message: `Structured import creates more than ${L3_PROPOSAL_MAX_ITEMS} proposal items`,
    path: ["contexts"],
  },
);

// ── Upgrade work orders (ADR-0018) ──────────────────────────────────────
// wordbookId 必须显式传入：工单归属错书是脏写，禁止回退到默认词书。
export const upgradeWorkOrderCreateSchema = z.object({
  wordbookId: uuidSchema,
  wordId: uuidSchema,
  direction: directionSchema.optional(),
});

export const upgradeWorkOrderListQuerySchema = z.object({
  wordbookId: uuidSchema,
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── L3 practice attempts / error book (ADR-0019 §1/§3) ──────────────────
// payload.taskId 必填（T04 deterministicTaskId 幂等身份）；缺失即 400。
const l3PracticePayloadSchema = z.object({
  taskId: z.string().trim().min(1, "payload.taskId is required"),
}).passthrough();

export const l3PracticeAttemptCreateSchema = z.object({
  contextId: uuidSchema,
  occurrenceId: uuidSchema.nullish(),
  sessionId: uuidSchema.nullish(),
  practiceType: z.enum(L3_PRACTICE_TYPES),
  outcome: z.enum(L3_PRACTICE_OUTCOMES),
  payload: l3PracticePayloadSchema,
});

export const l3PracticeAttemptListQuerySchema = z.object({
  practiceType: z.enum(L3_PRACTICE_TYPES).optional(),
  outcome: z.enum(L3_PRACTICE_OUTCOMES).optional(),
  space: z.enum(L3_SUB_SPACES).optional(),
  direction: directionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// 错题库查询（T11 加固）：space/direction 两轴语义不变；cursor 纯新增（复用
// l3LimitCursorQuerySchema 的 cursor 范式）。
// cursor 与 offset 同时给出时以 cursor 为准（offset 被忽略，响应 offset 恒 0）。
// ⏳ DEPRECATED(offset)：保留至 **0.2.0 契约窗口**——到期必须删除 offset 参数
//    （以及响应里的 offset 字段）。删除属 breaking change，必须走 api:breaking 审批窗口，
//    不得静默退役、也不得无限期保留。检索锚点：grep "DEPRECATED(offset)"。
export const l3PracticeErrorBookQuerySchema = z.object({
  space: z.enum(L3_SUB_SPACES).optional(),
  direction: directionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
    .describe("DEPRECATED (remove in 0.2.0): offset pagination window; ignored when cursor is present (cursor takes precedence)."),
  cursor: z.string().min(1).optional()
    .describe("Keyset cursor over (created_at,id) from the previous page's nextCursor. Takes precedence over offset."),
});

// ── L3 sessions (ADR-0019 §2) ───────────────────────────────────────────
export const l3SessionCreateSchema = z.object({
  type: z.enum(L3_SESSION_TYPES),
  title: z.string().trim().min(1).max(500).nullish(),
  space: z.enum(L3_SUB_SPACES).nullish(),
  direction: directionSchema.nullish(),
  contextCount: z.number().int().min(1).max(L3_SESSION_MAX_CONTEXTS)
    .nullish()
    .describe(`defaults to ${L3_SESSION_DEFAULT_CONTEXTS}`),
  days: z.number().int().min(1).max(L3_SESSION_MAX_DAYS).nullish(),
  seed: z.string().trim().min(1).max(200).nullish(),
});

// L3_SESSION_END_STATUSES 声明为 readonly L3SessionStatus[]（全量联合），
// 这里按运行时值收窄为两个结束态，输出类型才能喂给 endSession 的 Extract 入参。
const l3SessionEndStatuses = L3_SESSION_END_STATUSES as readonly ["completed", "abandoned"];

export const l3SessionEndSchema = z.object({
  status: z.enum(l3SessionEndStatuses),
});

// ── One-click forgetting (ADR-0020) ─────────────────────────────────────
export const forgettingPreviewQuerySchema = z.object({
  bookId: uuidSchema,
});

export const forgettingApplySchema = z.object({
  bookId: uuidSchema,
  /** 用户确认保留的锚点 wordId；陈旧清单由 service 抛 422。 */
  confirmedAnchorIds: z.array(uuidSchema),
});

export const forgettingRestoreSchema = z.object({
  bookId: uuidSchema,
  batchId: z.string().trim().min(1).max(200),
});
