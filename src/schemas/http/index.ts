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
} from "../resource-budget";

// ── Primitives ──────────────────────────────────────────────────────────
export const reviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export const uuidSchema = z.string().uuid();

// ── Words ───────────────────────────────────────────────────────────────
export const wordsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(60),
  offset: z.coerce.number().int().min(0).optional().default(0),
  freq: z.string().max(50).optional(),
  q: z.string().max(200).optional(),
  semantic: z.string().max(100).optional(),
  review: z.enum(["all", "tracked", "due", "untracked"]).optional().default("all"),
  wordbookId: uuidSchema.optional(),
});

// ── Review ──────────────────────────────────────────────────────────────
export const reviewAnswerSchema = z.object({
  progressId: uuidSchema,
  rating: reviewRatingSchema,
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
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

export const batchAddFromContentSchema = z.object({
  content: z.string().min(1).max(200_000),
  wordbookId: uuidSchema.optional(),
  dryRun: z.boolean().optional(),
  autoEnqueue: z.boolean().optional().default(true),
});

// ── Notes ───────────────────────────────────────────────────────────────
export const noteSchema = z.object({
  contentMd: z.string().max(20_000),
  wordbookId: uuidSchema.optional(),
});

export const noteRestoreSchema = z.object({
  revisionId: uuidSchema,
  wordbookId: uuidSchema.optional(),
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

export const l3ContextLinkCreateSchema = z.object({
  contextId: uuidSchema.nullish(),
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
}).refine((value) => Boolean(value.contextId || value.wordId), {
  message: "contextId or wordId is required",
  path: ["contextId"],
});

export const l3LimitCursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
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
