import { z } from "zod";
import type {
  Json,
  L3ContextDetail,
  L3ContextLinkRow,
  L3ContextRow,
  L3GraphReadModel,
  L3ImportJobRow,
  L3OccurrenceRow,
  L3PaginatedList,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalItemRow,
  L3ProposalRow,
  L3ProposalValidationResult,
  L3ReadStats,
  L3RecommendationAcceptResult,
  L3RecommendationBundle,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
  L3SourceRow,
  L3SourceSpace,
  L3WordSpace,
  WordRow,
} from "../domain";
import type { L3ImportProposalResult, L3ImportParseStats } from "../services/l3-import.service";

export const jsonValueSchema: z.ZodType<Json> = z.json();

export const l3ProposalRowResponseSchema: z.ZodType<L3ProposalRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  wordbook_id: z.string().nullable(),
  source_type: z.enum(["agent", "import", "external_tool", "manual_draft", "mcp_future", "other"]),
  status: z.enum(["pending", "confirmed", "rejected", "canceled"]),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  input_hash: z.string().nullable(),
  proposed_by: z.string().nullable(),
  provenance: jsonValueSchema,
  review_note: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  rejected_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3ProposalItemRowResponseSchema: z.ZodType<L3ProposalItemRow> = z.object({
  id: z.string(),
  proposal_id: z.string(),
  user_id: z.string(),
  item_type: z.enum(["source", "context", "occurrence", "context_link"]),
  ordinal: z.number().int().nonnegative(),
  payload: jsonValueSchema,
  status: z.enum(["pending", "confirmed", "rejected"]),
  validation_errors: jsonValueSchema,
  active_entity_type: z.enum(["source", "context", "occurrence", "context_link"]).nullable(),
  active_entity_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3ProposalBundleResponseSchema: z.ZodType<L3ProposalBundle> = z.object({
  proposal: l3ProposalRowResponseSchema,
  items: z.array(l3ProposalItemRowResponseSchema),
}).strict();

export const l3RecommendationItemResponseSchema: z.ZodType<L3RecommendationItemRow> = z.object({
  id: z.string(),
  run_id: z.string(),
  user_id: z.string(),
  wordbook_id: z.string().nullable(),
  recommendation_type: z.enum(["review_pack", "learn_next", "link_gap", "context_gap", "l2_gap", "weak_word", "related_word"]),
  status: z.enum(["pending", "accepted", "rejected", "dismissed", "expired"]),
  title: z.string(),
  summary: z.string(),
  priority_score: z.union([z.number(), z.string()]),
  confidence: z.union([z.number(), z.string()]),
  reason_codes: jsonValueSchema,
  evidence: jsonValueSchema,
  payload: jsonValueSchema,
  accepted_proposal_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
  rejected_at: z.string().nullable(),
  dismissed_at: z.string().nullable(),
}).strict();

export const l3RecommendationDetailResponseSchema = l3RecommendationItemResponseSchema;

function cursorPageResponseSchema<T>(itemSchema: z.ZodType<T>): z.ZodType<L3PaginatedList<T>> {
  return z.object({
    items: z.array(itemSchema),
    limit: z.number().int().positive(),
    cursor: z.string().nullable(),
    nextCursor: z.string().nullable(),
  }).strict();
}

export const l3RecommendationListResponseSchema = cursorPageResponseSchema(l3RecommendationItemResponseSchema);

export const l3ProposalListResponseSchema = cursorPageResponseSchema(l3ProposalRowResponseSchema);

// ── L3 context-space row schemas ──────────────────────────────────────────

export const l3SourceRowResponseSchema: z.ZodType<L3SourceRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  wordbook_id: z.string().nullable(),
  source_type: z.enum(["article", "book", "video", "audio", "chat", "manual", "web", "other"]),
  title: z.string(),
  author: z.string().nullable(),
  url: z.string().nullable(),
  language: z.string().nullable(),
  metadata: jsonValueSchema,
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3ContextRowResponseSchema: z.ZodType<L3ContextRow> = z.object({
  id: z.string(),
  source_id: z.string(),
  user_id: z.string(),
  context_type: z.enum(["sentence", "paragraph", "excerpt", "dialogue", "note"]),
  text: z.string(),
  normalized_text: z.string().nullable(),
  language: z.string().nullable(),
  position: jsonValueSchema,
  metadata: jsonValueSchema,
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3OccurrenceRowResponseSchema: z.ZodType<L3OccurrenceRow> = z.object({
  id: z.string(),
  context_id: z.string(),
  word_id: z.string(),
  user_id: z.string(),
  surface: z.string(),
  lemma: z.string().nullable(),
  start_offset: z.number().int().nullable(),
  end_offset: z.number().int().nullable(),
  confidence: z.union([z.number(), z.string()]).nullable(),
  evidence: jsonValueSchema,
  created_at: z.string(),
}).strict();

export const l3ContextLinkRowResponseSchema: z.ZodType<L3ContextLinkRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  context_id: z.string().nullable(),
  word_id: z.string().nullable(),
  link_type: z.enum([
    "supports", "illustrates", "contrasts", "collocates_with",
    "synonym_of", "antonym_of", "derived_from", "topic_related", "manual_link",
  ]),
  target_type: z.enum(["word", "l2_item", "context", "source", "topic", "external"]),
  target_id: z.string().nullable(),
  target_ref: jsonValueSchema,
  confidence: z.union([z.number(), z.string()]).nullable(),
  provenance: jsonValueSchema,
  created_at: z.string(),
}).strict();

// ── L3 delete response ────────────────────────────────────────────────────

export const l3DeleteResponseSchema = z.object({
  deleted: z.object({
    entityType: z.enum(["source", "context", "occurrence", "context_link"]),
    id: z.string(),
  }).strict(),
  activeReadInvalidation: z.literal(true),
}).strict();

// ── L3 create responses ───────────────────────────────────────────────────

export const l3SourceCreateResponseSchema = z.object({
  source: l3SourceRowResponseSchema,
}).strict();

export const l3ContextCreateResponseSchema = z.object({
  context: l3ContextRowResponseSchema,
}).strict();

export const l3OccurrenceCreateResponseSchema = z.object({
  occurrence: l3OccurrenceRowResponseSchema,
}).strict();

export const l3ContextLinkCreateResponseSchema = z.object({
  link: l3ContextLinkRowResponseSchema,
}).strict();

export const l3ImportJobRowResponseSchema: z.ZodType<L3ImportJobRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  source_id: z.string().nullable(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  input_hash: z.string(),
  input_summary: z.string().nullable(),
  stats: jsonValueSchema,
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3ImportParseStatsResponseSchema: z.ZodType<L3ImportParseStats> = z.object({
  contextCount: z.number().int().nonnegative(),
  occurrenceCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  skippedContextCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
}).strict();

export const l3ImportProposalResponseSchema: z.ZodType<L3ImportProposalResult> = z.object({
  importJob: l3ImportJobRowResponseSchema,
  proposal: l3ProposalRowResponseSchema,
  items: z.array(l3ProposalItemRowResponseSchema),
  parseStats: l3ImportParseStatsResponseSchema,
}).strict();

export const l3RecommendationRunRowResponseSchema: z.ZodType<L3RecommendationRunRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  wordbook_id: z.string().nullable(),
  mode: z.enum(["review_pack", "learn_next", "gap_scan", "link_suggestions"]),
  status: z.enum(["completed", "failed"]),
  input_hash: z.string().nullable(),
  stats: jsonValueSchema,
  created_at: z.string(),
  completed_at: z.string().nullable(),
}).strict();

export const l3RecommendationBundleResponseSchema: z.ZodType<L3RecommendationBundle> = z.object({
  run: l3RecommendationRunRowResponseSchema,
  items: z.array(l3RecommendationItemResponseSchema),
  stats: jsonValueSchema,
}).strict();

// ── L3 read responses ─────────────────────────────────────────────────────

const l3ReadStatsResponseSchema: z.ZodType<L3ReadStats> = z.object({
  sourceCount: z.number().int().nonnegative(),
  contextCount: z.number().int().nonnegative(),
  occurrenceCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
}).strict();

export const l3ContextDetailResponseSchema: z.ZodType<L3ContextDetail> = z.object({
  context: l3ContextRowResponseSchema,
  source: l3SourceRowResponseSchema,
  occurrences: z.array(l3OccurrenceRowResponseSchema),
  links: z.array(l3ContextLinkRowResponseSchema),
}).strict();

const wordRowResponseSchema: z.ZodType<WordRow> = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  ipa: z.string().nullable(),
  aliases: z.array(z.string()),
  short_definition: z.string().nullable(),
  definition_md: z.string(),
  body_md: z.string(),
  examples: jsonValueSchema,
  metadata: jsonValueSchema,
  source_path: z.string(),
  source_updated_at: z.string().nullable(),
  content_hash: z.string(),
  is_published: z.boolean(),
  is_deleted: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3WordSpaceResponseSchema: z.ZodType<L3WordSpace> = z.object({
  word: wordRowResponseSchema,
  contexts: z.array(l3ContextRowResponseSchema),
  sources: z.array(l3SourceRowResponseSchema),
  occurrences: z.array(l3OccurrenceRowResponseSchema),
  links: z.array(l3ContextLinkRowResponseSchema),
  stats: l3ReadStatsResponseSchema,
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  nextCursor: z.string().nullable(),
}).strict();

export const l3SourceSpaceResponseSchema: z.ZodType<L3SourceSpace> = z.object({
  source: l3SourceRowResponseSchema,
  contexts: z.array(l3ContextRowResponseSchema),
  occurrences: z.array(l3OccurrenceRowResponseSchema),
  links: z.array(l3ContextLinkRowResponseSchema),
  stats: l3ReadStatsResponseSchema,
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  nextCursor: z.string().nullable(),
}).strict();

const l3GraphNodeResponseSchema = z.object({
  id: z.string(),
  type: z.enum(["word", "context", "source", "l2_item", "topic", "external"]),
  label: z.string(),
  ref: jsonValueSchema,
  metadata: jsonValueSchema.optional(),
}).strict();

const l3GraphEdgeResponseSchema = z.object({
  id: z.string(),
  type: z.enum([
    "supports", "illustrates", "contrasts", "collocates_with",
    "synonym_of", "antonym_of", "derived_from", "topic_related", "manual_link",
    "occurs_in", "belongs_to",
  ]),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  confidence: z.union([z.number(), z.string()]).nullable().optional(),
  provenance: jsonValueSchema.optional(),
  evidence: jsonValueSchema.optional(),
}).strict();

export const l3GraphResponseSchema: z.ZodType<L3GraphReadModel> = z.object({
  nodes: z.array(l3GraphNodeResponseSchema),
  edges: z.array(l3GraphEdgeResponseSchema),
  stats: z.object({
    sourceCount: z.number().int().nonnegative(),
    contextCount: z.number().int().nonnegative(),
    occurrenceCount: z.number().int().nonnegative(),
    linkCount: z.number().int().nonnegative(),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
  }).strict(),
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  nextCursor: z.string().nullable(),
  metadata: jsonValueSchema.optional(),
}).strict();

export const l3ContextListResponseSchema = cursorPageResponseSchema(l3ContextRowResponseSchema);

// ── L3 state-transition responses ─────────────────────────────────────────

export const l3RecommendationAcceptResponseSchema: z.ZodType<L3RecommendationAcceptResult> = z.object({
  item: l3RecommendationItemResponseSchema,
  proposal: l3ProposalBundleResponseSchema.optional(),
  actionPayload: jsonValueSchema.optional(),
}).strict();

const l3ProposalValidationIssueResponseSchema = z.object({
  itemId: z.string(),
  ordinal: z.number().int().nonnegative(),
  itemType: z.enum(["source", "context", "occurrence", "context_link"]),
  field: z.string(),
  message: z.string(),
}).strict();

export const l3ProposalValidationResponseSchema: z.ZodType<L3ProposalValidationResult> = z.object({
  proposal: l3ProposalRowResponseSchema,
  items: z.array(l3ProposalItemRowResponseSchema),
  valid: z.boolean(),
  errors: z.array(l3ProposalValidationIssueResponseSchema),
}).strict();

export const l3ProposalConfirmResponseSchema: z.ZodType<L3ProposalConfirmResult> = z.object({
  proposal: l3ProposalRowResponseSchema,
  items: z.array(l3ProposalItemRowResponseSchema),
  activeEntities: z.array(z.object({
    itemId: z.string(),
    itemType: z.enum(["source", "context", "occurrence", "context_link"]),
    activeEntityType: z.enum(["source", "context", "occurrence", "context_link"]),
    activeEntityId: z.string(),
  }).strict()),
}).strict();
