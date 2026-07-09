/**
 * Service-layer DTO types — derived from HTTP schemas but without coercion.
 *
 * These are the strong-typed contracts that Service methods accept.
 * The Route layer parses HTTP input with the http schemas, then passes
 * the inferred type to the Service.
 */

import { z } from "zod";
import type { Json } from "@/domain";
import {
  reviewAnswerSchema,
  reviewSkipSchema,
  reviewSuspendSchema,
  reviewUndoSchema,
  reviewSettingsSchema,
  noteSchema,
  wordbookCreateSchema,
  wordsQuerySchema,
  batchAddFromContentSchema,
} from "../http";

// ── Word service ────────────────────────────────────────────────────────
export type WordsQuery = z.infer<typeof wordsQuerySchema>;

// ── Review service ──────────────────────────────────────────────────────
export type SubmitAnswerInput = z.infer<typeof reviewAnswerSchema>;
export type SkipReviewInput = z.infer<typeof reviewSkipSchema>;
export type SuspendReviewInput = z.infer<typeof reviewSuspendSchema>;
export type UndoReviewInput = z.infer<typeof reviewUndoSchema>;
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

export interface SubmitAnswerResult {
  ok: boolean;
  idempotent?: boolean;
  reviewLogId: string;
  nextDueAt?: string;
  state?: string;
}

// ── Note service ────────────────────────────────────────────────────────
export type UpsertNoteInput = z.infer<typeof noteSchema>;

export interface UpsertNoteResult {
  ok: boolean;
  updatedAt: string;
  version: number;
}

// ── Wordbook service ────────────────────────────────────────────────────
export type CreateWordbookInput = z.infer<typeof wordbookCreateSchema>;

// ── Import service ──────────────────────────────────────────────────────
export type BatchAddFromContentInput = z.infer<typeof batchAddFromContentSchema>;

// ── L2 enrichment content ───────────────────────────────────────────────
//
// Field-specific shapes for the four L2 enrichment fields. These mirror the
// JSON arrays the LLM prompt templates ask for (see src/llm/prompts/*.ts):
//   collocation → [{ phrase, gloss, tone, example, exampleTranslation }]
//   corpus      → [{ text, translation, source }]
//   synonym     → [{ word, semanticDiff, tone, usage, delta, object }]
//   antonym     → same shape as synonym (buildAntonymPrompt asks for it)
//
// `tone`/`source` are enums constrained to the prompt-declared vocabularies.
// Unknown keys are stripped (zod v4 default for objects) so stray LLM fields
// never reach the DB; required keys are enforced so malformed drafts are
// rejected before insert.
export const L2_FIELDS = ["collocation", "corpus", "synonym", "antonym"] as const;
export type L2Field = (typeof L2_FIELDS)[number];

export const l2FieldSchema = z.enum(L2_FIELDS);

// ── L2 composer field mapping (example ⇄ corpus) ───────────────────────
//
// The "composer" surface (UI / API consumers) exposes `example` as a field
// name, while the storage layer persists it as `corpus`. These helpers bridge
// the two vocabularies so routes can accept composer field names while the
// service/DB layer keeps its canonical `L2Field` names.
export const L2_COMPOSER_FIELDS = ["collocation", "example"] as const;
export type L2ComposerField = (typeof L2_COMPOSER_FIELDS)[number];
export type L2RouteField = L2Field | L2ComposerField;

/**
 * Map a route/composer field name to its canonical storage field name.
 *
 * `example` → `corpus`; any other valid `L2Field` passes through unchanged.
 * Returns `null` for unknown values — the caller (route layer) is responsible
 * for translating that into a 400. This module deliberately does NOT throw a
 * ValidationError so it can be reused from non-HTTP contexts.
 */
export function mapToStorageField(field: unknown): L2Field | null {
  if (field === "example") return "corpus";
  if (typeof field === "string" && (L2_FIELDS as readonly string[]).includes(field)) {
    return field as L2Field;
  }
  return null;
}

/**
 * Inverse of `mapToStorageField`: render a storage field name back to its
 * composer-facing label. `corpus` → `example`; everything else is unchanged.
 */
export function toComposerField(field: L2Field): L2ComposerField | "synonym" | "antonym" {
  return field === "corpus" ? "example" : field;
}

const toneSchema = z.enum(["formal", "neutral", "informal"]);

/** A single collocation entry — matches buildCollocationPrompt output. */
export const l2CollocationItemSchema = z.object({
  phrase: z.string().min(1),
  gloss: z.string(),
  tone: toneSchema,
  example: z.string(),
  exampleTranslation: z.string(),
});

/** A single corpus/example entry — matches buildExamplePrompt output. */
export const l2CorpusItemSchema = z.object({
  text: z.string().min(1),
  translation: z.string(),
  source: z.string(),
});

/** A single synonym/antonym entry — matches buildSynonymPrompt / buildAntonymPrompt output. */
export const l2SynonymItemSchema = z.object({
  word: z.string().min(1),
  semanticDiff: z.string(),
  tone: toneSchema,
  usage: z.string(),
  delta: z.string(),
  object: z.string(),
});

/** Map each L2 field to its content schema (always a JSON array of entries). */
export const L2_CONTENT_SCHEMAS: Record<L2Field, z.ZodType> = {
  collocation: z.array(l2CollocationItemSchema),
  corpus: z.array(l2CorpusItemSchema),
  synonym: z.array(l2SynonymItemSchema),
  antonym: z.array(l2SynonymItemSchema),
};

export type L2Content = unknown;

// ── L2 content v1 wrapper (Phase 2D) ────────────────────────────────────
//
// The v1 wrapper carries item-level provenance/evidence alongside the content
// items, so each entry can record where it came from (manual / llm / dictionary
// / external_chat) and what dictionary evidence grounds it. Legacy content is
// still a bare JSON array; `parseL2Content()` accepts both shapes.

/** Origin of an L2 content item. */
export const l2ContentSourceSchema = z.enum([
  "manual",
  "llm",
  "llm_edited",
  "external_chat",
  "dictionary",
  "dictionary_llm_refined",
]);

/**
 * Provenance record attached to every v1 item. `passthrough()` keeps unknown
 * keys so future fields don't need a schema bump to round-trip.
 */
export const l2ProvenanceSchema = z
  .object({
    source: l2ContentSourceSchema,
    provider: z.string().optional(),
    model: z.string().optional(),
    styleProfileId: z.string().optional(),
    styleProfileVersion: z.string().optional(),
    promptVersion: z.string().optional(),
    promptHash: z.string().optional(),
    dictionaryName: z.string().optional(),
    dictionaryEntryId: z.string().optional(),
    dictionaryUrl: z.string().optional(),
    externalTool: z.string().optional(),
    generatedAt: z.string().optional(),
    confirmedAt: z.string().optional(),
    userEdited: z.boolean().optional(),
    confidence: z.number().optional(),
    note: z.string().optional(),
  })
  .passthrough();

/** Dictionary evidence grounding an item (phrase / example / entry link). */
export const l2EvidenceSchema = z
  .object({
    dictionaryName: z.string().optional(),
    dictionaryEntryId: z.string().optional(),
    dictionaryUrl: z.string().optional(),
    rawPhrase: z.string().optional(),
    rawExample: z.string().optional(),
  })
  .passthrough();

/**
 * A single v1 collocation entry. `phrase` is the only hard-required content
 * field; `provenance` is always mandatory so the origin is never lost.
 *
 * `superRefine` enforces that dictionary-sourced collocations carry a
 * `dictionaryName` (either in provenance or in evidence) — a dictionary claim
 * without a dictionary name is not actionable.
 */
export const l2CollocationV1ItemSchema = z
  .object({
    phrase: z.string().trim().min(1),
    meaning: z.string().optional(),
    gloss: z.string().optional(),
    translation: z.string().optional(),
    example: z.string().optional(),
    exampleTranslation: z.string().optional(),
    pattern: z.string().optional(),
    tone: z.string().optional(),
    register: z.string().optional(),
    tags: z.array(z.string()).optional(),
    note: z.string().optional(),
    evidence: l2EvidenceSchema.optional(),
    provenance: l2ProvenanceSchema,
  })
  .passthrough()
  .superRefine((item, ctx) => {
    const source = item.provenance.source;
    const isMachineGenerated = source !== "manual";
    if (isMachineGenerated && !item.provenance.dictionaryName && !item.evidence?.dictionaryName) {
      ctx.addIssue({
        code: "custom",
        message: "machine-generated collocation requires dictionaryName in provenance or evidence",
        path: ["evidence", "dictionaryName"],
      });
    }
    if (source === "external_chat" && !item.evidence?.rawPhrase) {
      ctx.addIssue({
        code: "custom",
        message: "external_chat collocation requires evidence.rawPhrase",
        path: ["evidence", "rawPhrase"],
      });
    }
  });

/**
 * A single v1 corpus/example entry. Either `sentence` (new v1 name) or `text`
 * (legacy name) is required; both are accepted so legacy corpus items can be
 * re-wrapped without rewriting their content.
 */
export const l2CorpusV1ItemSchema = z
  .object({
    sentence: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    translation: z.string().optional(),
    usageNote: z.string().optional(),
    pattern: z.string().optional(),
    register: z.string().optional(),
    difficulty: z.string().optional(),
    source: z.string().optional(),
    styleProfileId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    provenance: l2ProvenanceSchema,
  })
  .passthrough()
  .refine((item) => Boolean(item.sentence || item.text), {
    message: "Either sentence or text is required",
  });

/**
 * Per-storage-field v1 item schemas. `synonym`/`antonym` reuse the v1
 * collocation shape is NOT appropriate; for Phase 2D they are not part of the
 * v1 wrapper contract, so they are intentionally absent. Only `collocation`
 * and `corpus` have v1 item schemas; other fields fall back to legacy arrays.
 */
export const L2_CONTENT_V1_ITEM_SCHEMAS: Partial<Record<L2Field, z.ZodType>> = {
  collocation: z.array(l2CollocationV1ItemSchema),
  corpus: z.array(l2CorpusV1ItemSchema),
};

/**
 * Structural v1 wrapper. `field` accepts composer names (`example`) as well as
 * storage names; the parser maps `example` → `corpus` before item validation.
 * `items` is intentionally `z.array(z.unknown())` here — the per-field item
 * schema is applied during `parseL2Content()`.
 */
export const l2ContentV1Schema = z
  .object({
    schemaVersion: z.literal("l2-content-v1"),
    field: z.enum(["collocation", "corpus", "example", "synonym", "antonym"]),
    items: z.array(z.unknown()).min(1),
  })
  .passthrough();

/** True when `content` looks like a v1 wrapper (has the literal version tag). */
function isV1Wrapper(content: unknown): content is {
  schemaVersion: "l2-content-v1";
  field: string;
  items: unknown[];
} & Record<string, unknown> {
  if (!content || typeof content !== "object") return false;
  const maybe = content as { schemaVersion?: unknown; items?: unknown };
  return maybe.schemaVersion === "l2-content-v1" && Array.isArray(maybe.items);
}

/**
 * Validate L2 enrichment `content` against the schema for `field`.
 *
 * Returns the parsed (schema-typed) content on success, or `null` when the
 * content does not conform. Used by both the HTTP layer (→ 400) and the
 * service layer (→ throws AppError) so malformed structures can never be
 * written to the DB, regardless of entry point.
 *
 * Accepts two shapes:
 *   - legacy JSON array → validated against `L2_CONTENT_SCHEMAS[field]`
 *   - v1 wrapper (`{ schemaVersion: "l2-content-v1", field, items }`) →
 *     `field=example` is mapped to `corpus`, the wrapper `field` must match the
 *     requested storage field after mapping, and `items` are validated against
 *     the per-field v1 item schema (falling back to the legacy item schema when
 *     no v1 schema is registered for that field). The parsed wrapper is
 *     returned, preserving `schemaVersion`, `field`, `items`, and any
 *     provenance/evidence.
 */
export function parseL2Content(field: L2Field, content: unknown): unknown {
  if (isV1Wrapper(content)) {
    // Validate the wrapper structure (schemaVersion literal, field enum, items
    // array with min(1)) so structural problems surface as ZodErrors just like
    // item-level problems do. `.passthrough()` keeps extra keys (provenance
    // metadata, etc.) intact.
    const wrapper = l2ContentV1Schema.parse(content) as {
      schemaVersion: "l2-content-v1";
      field: string;
      items: unknown[];
    } & Record<string, unknown>;

    const wrapperField = mapToStorageField(wrapper.field);
    if (wrapperField === null || wrapperField !== field) {
      throw new z.ZodError([
        {
          code: "custom",
          message: `v1 wrapper field "${wrapper.field}" does not match requested field "${field}"`,
          path: ["field"],
        },
      ]);
    }

    const itemSchema =
      L2_CONTENT_V1_ITEM_SCHEMAS[field] ?? L2_CONTENT_SCHEMAS[field];
    const parsedItems = itemSchema.parse(wrapper.items);

    // Preserve the wrapper shape, normalizing `field` to the storage field so
    // downstream consumers see canonical names.
    return {
      ...wrapper,
      schemaVersion: "l2-content-v1",
      field,
      items: parsedItems,
    };
  }

  return L2_CONTENT_SCHEMAS[field].parse(content);
}

/** True when `content` conforms to the schema for `field`. */
export function isValidL2Content(field: L2Field, content: unknown): boolean {
  return safeParseL2Content(field, content).success;
}

/**
 * Non-throwing variant of `parseL2Content()`. Returns a discriminated union so
 * route/test code can branch on `success` without a try/catch.
 */
export function safeParseL2Content(
  field: L2Field,
  content: unknown,
): { success: true; data: unknown } | { success: false; error: unknown } {
  try {
    return { success: true, data: parseL2Content(field, content) };
  } catch (error) {
    return { success: false, error };
  }
}

// ── L3 context space ───────────────────────────────────────────────────
export const L3_SOURCE_TYPES = ["article", "book", "video", "audio", "chat", "manual", "web", "other"] as const;
export const L3_CONTEXT_TYPES = ["sentence", "paragraph", "excerpt", "dialogue", "note"] as const;
export const L3_CONTEXT_LINK_TYPES = [
  "supports",
  "illustrates",
  "contrasts",
  "collocates_with",
  "synonym_of",
  "antonym_of",
  "derived_from",
  "topic_related",
  "manual_link",
] as const;
export const L3_CONTEXT_LINK_TARGET_TYPES = ["word", "l2_item", "context", "source", "topic", "external"] as const;
export const L3_IMPORT_JOB_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export const L3_PROPOSAL_SOURCE_TYPES = ["agent", "import", "external_tool", "manual_draft", "mcp_future", "other"] as const;
export const L3_PROPOSAL_STATUSES = ["pending", "confirmed", "rejected", "canceled"] as const;
export const L3_PROPOSAL_ITEM_TYPES = ["source", "context", "occurrence", "context_link"] as const;
export const L3_PROPOSAL_ITEM_STATUSES = ["pending", "confirmed", "rejected"] as const;
export const L3_RECOMMENDATION_TYPES = [
  "review_pack",
  "learn_next",
  "link_gap",
  "context_gap",
  "l2_gap",
  "weak_word",
  "related_word",
] as const;
export const L3_RECOMMENDATION_STATUSES = ["pending", "accepted", "rejected", "dismissed", "expired"] as const;
export const L3_RECOMMENDATION_RUN_MODES = ["review_pack", "learn_next", "gap_scan", "link_suggestions"] as const;
export const L3_RECOMMENDATION_EVIDENCE_TYPES = [
  "graph_edge",
  "occurrence_count",
  "fsrs_due",
  "fsrs_weak",
  "l2_missing_field",
  "l3_context_missing",
  "wordbook_neighbor",
  "recent_import",
  "manual_seed",
] as const;

export type L3ServiceSourceType = (typeof L3_SOURCE_TYPES)[number];
export type L3ServiceContextType = (typeof L3_CONTEXT_TYPES)[number];
export type L3ServiceContextLinkType = (typeof L3_CONTEXT_LINK_TYPES)[number];
export type L3ServiceContextLinkTargetType = (typeof L3_CONTEXT_LINK_TARGET_TYPES)[number];
export type L3ServiceImportJobStatus = (typeof L3_IMPORT_JOB_STATUSES)[number];
export type L3ServiceProposalSourceType = (typeof L3_PROPOSAL_SOURCE_TYPES)[number];
export type L3ServiceProposalStatus = (typeof L3_PROPOSAL_STATUSES)[number];
export type L3ServiceProposalItemType = (typeof L3_PROPOSAL_ITEM_TYPES)[number];
export type L3ServiceRecommendationType = (typeof L3_RECOMMENDATION_TYPES)[number];
export type L3ServiceRecommendationStatus = (typeof L3_RECOMMENDATION_STATUSES)[number];
export type L3ServiceRecommendationRunMode = (typeof L3_RECOMMENDATION_RUN_MODES)[number];

export interface CreateL3SourceInput {
  userId: string;
  wordbookId?: string | null;
  sourceType: L3ServiceSourceType;
  title: string;
  author?: string | null;
  url?: string | null;
  language?: string | null;
  metadata?: Json;
}

export interface CreateL3ContextInput {
  userId: string;
  sourceId: string;
  contextType: L3ServiceContextType;
  text: string;
  normalizedText?: string | null;
  language?: string | null;
  position?: Json;
  metadata?: Json;
}

export interface CreateL3OccurrenceInput {
  userId: string;
  contextId: string;
  wordId?: string;
  slug?: string;
  surface: string;
  lemma?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
  confidence?: number | null;
  evidence?: Json;
}

export interface CreateL3ContextLinkInput {
  userId: string;
  contextId?: string | null;
  wordId?: string | null;
  linkType: L3ServiceContextLinkType;
  targetType: L3ServiceContextLinkTargetType;
  targetId?: string | null;
  targetRef?: Json;
  confidence?: number | null;
  provenance?: Json;
}

export interface DeleteL3OccurrenceInput {
  userId: string;
  occurrenceId: string;
}

export interface DeleteL3ContextLinkInput {
  userId: string;
  contextLinkId: string;
}

export interface L3DeleteResult {
  deleted: {
    entityType: "occurrence" | "context_link";
    id: string;
  };
  activeReadInvalidation: true;
}

export interface CreateL3ImportJobInput {
  userId: string;
  sourceId?: string | null;
  status: L3ServiceImportJobStatus;
  inputHash: string;
  inputSummary?: string | null;
  stats?: Json;
  error?: string | null;
}

export interface CreateL3ProposalItemInput {
  itemType: L3ServiceProposalItemType;
  clientRef?: string | null;
  payload: Json;
}

export interface CreateL3ProposalInput {
  userId: string;
  wordbookId?: string | null;
  sourceType: L3ServiceProposalSourceType;
  title?: string | null;
  summary?: string | null;
  inputHash?: string | null;
  proposedBy?: string | null;
  provenance?: Json;
  items: CreateL3ProposalItemInput[];
}

export interface ListL3ProposalsInput {
  userId: string;
  status?: L3ServiceProposalStatus | null;
  limit: number;
  cursor?: string | null;
}

export interface L3ProposalIdInput {
  userId: string;
  proposalId: string;
}

export interface RejectL3ProposalInput extends L3ProposalIdInput {
  reviewNote?: string | null;
}

export interface L3ImportSourceInput {
  sourceType: L3ServiceSourceType;
  title: string;
  author?: string | null;
  url?: string | null;
  language?: string | null;
  metadata?: Json;
}

export interface L3ImportTargetWordInput {
  wordId?: string;
  slug?: string;
}

export interface L3RawTextImportOptionsInput {
  contextType?: "sentence" | "paragraph";
  maxContexts?: number;
  minContextLength?: number;
  maxOccurrencesPerWordPerContext?: number;
}

export interface CreateL3RawTextImportProposalInput {
  userId: string;
  wordbookId?: string | null;
  source: L3ImportSourceInput;
  text: string;
  targetWords?: L3ImportTargetWordInput[];
  options?: L3RawTextImportOptionsInput;
  provenance?: Json;
}

export interface L3StructuredImportOccurrenceInput {
  wordId?: string;
  slug?: string;
  surface: string;
  lemma?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
  confidence?: number | null;
  evidence?: Json;
}

export interface L3StructuredImportLinkInput {
  wordId?: string | null;
  linkType: L3ServiceContextLinkType;
  targetType: L3ServiceContextLinkTargetType;
  targetId?: string | null;
  targetRef?: Json;
  confidence?: number | null;
  provenance?: Json;
}

export interface L3StructuredImportContextInput {
  clientRef?: string | null;
  contextType: L3ServiceContextType;
  text: string;
  normalizedText?: string | null;
  language?: string | null;
  position?: Json;
  metadata?: Json;
  occurrences?: L3StructuredImportOccurrenceInput[];
  links?: L3StructuredImportLinkInput[];
}

export interface CreateL3StructuredImportProposalInput {
  userId: string;
  wordbookId?: string | null;
  source: L3ImportSourceInput;
  contexts: L3StructuredImportContextInput[];
  provenance?: Json;
}

export interface GenerateL3RecommendationsInput {
  userId: string;
  wordbookId?: string | null;
  mode: L3ServiceRecommendationRunMode;
  seedSlug?: string | null;
  limit?: number | null;
  horizonDays?: number | null;
  dryRun?: boolean | null;
}

export interface ListL3RecommendationsInput {
  userId: string;
  status?: L3ServiceRecommendationStatus | null;
  recommendationType?: L3ServiceRecommendationType | null;
  limit: number;
  cursor?: string | null;
}

export interface L3RecommendationIdInput {
  userId: string;
  recommendationId: string;
}

export interface RejectL3RecommendationInput extends L3RecommendationIdInput {
  reviewNote?: string | null;
}
