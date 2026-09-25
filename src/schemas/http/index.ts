/**
 * HTTP input schemas — ported from v1's lib/validation/schemas.ts.
 *
 * These validate raw HTTP input (URL params, JSON body). They use z.coerce
 * for URL string→number conversion and .default() for missing fields.
 * The Service layer receives already-parsed strong types derived from these.
 */

import { z } from "zod";
import { ValidationError } from "@/errors";
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
import { L3_QUESTION_TYPES, questionTypeAllowsSourceless } from "../../domain/l3-question-types";
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
  // T3 Hint 阶梯埋点（2026-09-25，request 纯新增 = 非 breaking）：
  // hintLevel = 作答时已消费的最高提示级（0=未用提示直翻，1=H1 例句/语义链，
  // 2=H2 原型，3=H3 助记锚）；viaH4 = 提示穷尽后经 H4 翻卡（区别于直翻验证）。
  // 旧客户端缺省 → 服务端落 null/false。
  hintLevel: z.number().int().min(0).max(3).optional(),
  viaH4: z.boolean().optional(),
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
  // 能力域标签（V0 接通 l3_source_spaces 写入）：1–5 个固定枚举；省略由服务端归一为「通用」。
  spaces: z.array(z.enum(L3_SUB_SPACES)).min(1).max(5).optional(),
});

/** PUT /l3/sources/:id/spaces：全量替换能力域标签（非空、去重由服务层归一）。 */
export const l3SourceSpacesReplaceSchema = z.object({
  spaces: z.array(z.enum(L3_SUB_SPACES)).min(1).max(5),
});

// ── L3 题目 / 试卷（ADR-0030：题与 context 分离；卷面 payload 引用）────────
export const l3QuestionTypeSchema = z.enum(L3_QUESTION_TYPES);

const l3QuestionOptionSchema = z.object({
  key: z.string().trim().min(1).max(4),
  text: z.string().trim().min(1).max(8_000),
});

const l3EvidenceAnchorSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  label: z.string().trim().min(1).max(40),
}).refine((anchor) => anchor.end > anchor.start, { message: "evidence end must be greater than start", path: ["end"] });

const l3QuestionAnswerSchema = z.object({
  choice: z.string().trim().min(1).max(20).optional(),
  choices: z.array(z.string().trim().min(1).max(20)).max(30).optional(),
  text: z.string().max(20_000).optional(),
  sample: z.string().max(20_000).optional(),
  points: z.array(z.string().max(2_000)).max(50).optional(),
});

/** 题目主体（散题录入与建卷内嵌共用）。 */
const l3QuestionBodySchema = z.object({
  ordinal: z.number().int().min(0).max(500).optional(),
  stem: z.string().trim().min(1).max(30_000),
  options: z.array(l3QuestionOptionSchema).max(12).optional(),
  answer: l3QuestionAnswerSchema.optional(),
  explanation: z.string().max(30_000).nullish(),
  evidence: z.array(l3EvidenceAnchorSchema).max(60).optional(),
});

/** POST /l3/questions：散题录入到文件（source 题组或 fileKey 题组，二选一）。 */
export const l3QuestionCreateSchema = l3QuestionBodySchema.extend({
  questionType: l3QuestionTypeSchema,
  sourceId: uuidSchema.nullish(),
  fileKey: z.string().trim().min(1).max(200).nullish(),
}).refine((body) => Boolean(body.sourceId) || Boolean(body.fileKey), {
  message: "sourceId 或 fileKey 至少提供一个",
  path: ["sourceId"],
});

/** POST /l3/papers：粘贴建卷（单事务建题 + 组 payload 引用）。 */
const l3PaperSectionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  questionType: l3QuestionTypeSchema,
  sourceId: uuidSchema.nullish(),
  fileKey: z.string().trim().min(1).max(200).nullish(),
  questions: z.array(l3QuestionBodySchema).min(1).max(60),
}).superRefine((section, ctx) => {
  // 文件身份（与 service.resolveSectionIdentity 同规则）：阅读类必须挂材料；
  // 翻译/作文无正文题组必须显式给 fileKey。
  if (section.sourceId) return;
  if (!questionTypeAllowsSourceless(section.questionType)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "该题型必须挂阅读材料 sourceId" });
  } else if (!section.fileKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fileKey"], message: "无正文题组必须提供 fileKey" });
  }
});

export const l3PaperCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  direction: directionSchema.nullish(),
  metadata: jsonRecordSchema.optional(),
  sections: z.array(l3PaperSectionSchema).min(1).max(20),
});

/** GET /l3/practice-files：题型空间的文件管理列表（派生视图）。 */
export const l3PracticeFileListQuerySchema = z.object({
  questionType: l3QuestionTypeSchema.optional(),
  direction: directionSchema.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /l3/practice-files/detail：单文件题组（source 题组或 fileKey 题组）。 */
export const l3PracticeFileDetailQuerySchema = z.object({
  questionType: l3QuestionTypeSchema,
  sourceId: uuidSchema.optional(),
  fileKey: z.string().trim().min(1).max(200).optional(),
}).refine((q) => Boolean(q.sourceId) || Boolean(q.fileKey), {
  message: "sourceId 或 fileKey 至少提供一个",
  path: ["sourceId"],
});

/** GET /l3/papers：试卷列表。 */
export const l3PaperListQuerySchema = z.object({
  status: z.enum(["draft", "active", "archived"]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
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

// ── 批次一：做题注记（原文分析条目）与规律标签字典（2026-09-16）─────────────
// body 契约直接复用 domain zod（单一真源：锚点三元组/标签上限/A–D 白名单）。
export {
  annotationTagDictSchema as l3AnnotationTagDictSchema,
  questionAnnotationInputSchema as l3QuestionAnnotationCreateSchema,
  questionAnnotationPatchSchema as l3QuestionAnnotationPatchSchema,
} from "../../domain/l3-annotations";

/** POST /l3/question-annotations/:id/withdraw：sheetId 可选（缺省借原纸作用域幂等开纸）。 */
export const l3QuestionAnnotationWithdrawSchema = z.object({
  sheetId: z.string().uuid().optional(),
}).strict();

/** GET /l3/question-annotations?questionIds=<uuid,uuid,...>：1–200 个 uuid。 */
export const l3QuestionAnnotationListQuerySchema = z.object({
  questionIds: z.string().trim().min(1).max(12_000)
    .transform((raw) => raw.split(",").map((value) => value.trim()).filter(Boolean))
    .refine((ids) => ids.length >= 1 && ids.length <= 200, { message: "questionIds 需为 1–200 个 uuid" })
    .refine((ids) => ids.every((id) => uuidSchema.safeParse(id).success), { message: "questionIds 含非法 uuid" }),
});

// ── 批次二：题纸与作答历史（2026-09-17）────────────────────────────────
// body 契约直接复用 domain zod（单一真源：幂等开纸 / 逐题 merge / 三档定格）。
export {
  sheetOpenInputSchema as l3SheetOpenSchema,
  sheetPatchInputSchema as l3SheetPatchSchema,
  sheetSealInputSchema as l3SheetSealSchema,
} from "../../domain/l3-sheets";

/** PUT /l3/questions/:id/assessment：评析区 upsert body（增补批 0035）。 */
export { assessmentUpsertInputSchema as l3AssessmentUpsertSchema } from "../../domain/l3-assessments";

/** POST /l3/sheets/:id/grading：评卷提交 body（批次三① 0036，ADR-0035 §3）。 */
export { gradingSubmitInputSchema as l3GradingSubmitSchema } from "../../domain/l3-grading";

// ── 作文子空间 v1（W6，ADR《writing-workspace》§6）──────────────────────
// body 契约复用 domain zod（单一真源）；查询契约就地定义。
export {
  writingTaskCreateInputSchema as l3WritingTaskCreateSchema,
  writingTaskRenameInputSchema as l3WritingTaskRenameSchema,
  writingDraftInputSchema as l3WritingDraftSaveSchema,
  writingSubmitInputSchema as l3WritingSubmitSchema,
  writingDraftCreateInputSchema as l3WritingDraftCreateSchema,
  writingFeedbackPutInputSchema as l3WritingFeedbackPutSchema,
} from "../../domain/l3-writing";

/** GET /l3/writing/tasks?q&status&limit&cursor（列表 keyset；标题/题面搜索）。 */
export const l3WritingTaskListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["active", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().max(500).optional(),
});

/** GET /l3/writing/tasks/:taskId/revisions?limit&cursor（稿次历史 keyset）。 */
export const l3WritingRevisionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().max(500).optional(),
});

/** GET /l3/sheets：题纸档案列表 query（F-1 回看闭环；owner-only，新→旧）。 */
export const l3SheetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /l3/sheets/:id/export?withAnswers=0|1 的 query 契约（v2 §6；文档登记用）。 */
export const l3SheetExportQuerySchema = z.object({
  withAnswers: z.enum(["0", "1"]).optional(),
});

/**
 * GET /l3/sheets/:id/export?withAnswers=0|1（v2 §6）：缺省按状态（draft=0 /
 * sealed=1）；非法值抛校验错误（由全局 handleError 转 422，勿宽容吞掉）。
 */
export function parseSheetExportWithAnswers(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new ValidationError("withAnswers must be 0 or 1", "withAnswers");
}

/** GET /l3/attempts?questionIds=<uuid,uuid,...>：1–200 个 uuid（对齐注记批量口径）。 */
export const l3AttemptListQuerySchema = z.object({
  questionIds: z.string().trim().min(1).max(12_000)
    .transform((raw) => raw.split(",").map((value) => value.trim()).filter(Boolean))
    .refine((ids) => ids.length >= 1 && ids.length <= 200, { message: "questionIds 需为 1–200 个 uuid" })
    .refine((ids) => ids.every((id) => uuidSchema.safeParse(id).success), { message: "questionIds 含非法 uuid" }),
});
