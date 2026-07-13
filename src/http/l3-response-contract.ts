import { z } from "zod";
import type {
  Json,
  L3PaginatedList,
  L3ProposalBundle,
  L3ProposalItemRow,
  L3ProposalRow,
  L3RecommendationItemRow,
} from "../domain";

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
