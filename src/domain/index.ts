/** Domain types — pure, zero DB/runtime dependencies. */

// ── Common ──────────────────────────────────────────────────────────────
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ── Word ────────────────────────────────────────────────────────────────
export type ReviewRating = "again" | "hard" | "good" | "easy";

export interface WordRow {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  aliases: string[];
  short_definition: string | null;
  definition_md: string;
  body_md: string;
  examples: Json;
  metadata: Json;
  source_path: string;
  source_updated_at: string | null;
  content_hash: string;
  is_published: boolean;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface WordSummary {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
  metadata: Json;
}

export interface WordFilters {
  q?: string;
  freq?: string;
  semantic?: string;
  review?: string;
}

export interface GetPublicWordsOptions {
  filters?: WordFilters;
  pagination: { limit: number; offset: number };
  wordbookId?: string;
}

// ── Review / Progress ───────────────────────────────────────────────────
export type ReviewState = "new" | "learning" | "review" | "relearning" | "suspended";

export interface UserWordProgressRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  state: ReviewState;
  stability: number | null;
  difficulty: number | null;
  retrievability: number | null;
  desired_retention: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_rating: ReviewRating | null;
  review_count: number;
  lapse_count: number;
  again_count: number;
  hard_count: number;
  good_count: number;
  easy_count: number;
  interval_days: number | null;
  scheduler_payload: Json;
  content_hash_snapshot: string | null;
  skip_count: number;
  created_at: string;
  updated_at: string;
  /**
   * Sliding window of the most recent L1 ratings (chronological order, max 5).
   * Backs the Phase 2C cross-track cascade: the last N entries drive L1→L2
   * pause/unpause. Stored as jsonb in the DB.
   */
  recent_ratings: ReviewRating[];
  /**
   * Weak-signal flag set when L2辨析 fails repeatedly (3× again). Phase 2C
   * decision-2: L2→L1 only marks, never auto-re-cards — the user decides
   * whether to re-grind L1 after seeing the flag in the UI.
   */
  l1_weak_signal: boolean;
}

export interface ReviewLogRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  progress_id: string;
  session_id: string | null;
  rating: ReviewRating | null;
  state: ReviewState;
  stability: number | null;
  difficulty: number | null;
  due_at: string | null;
  reviewed_at: string;
  elapsed_days: number;
  scheduled_days: number;
  metadata: Json;
  previous_progress_snapshot: Json;
  idempotency_key: string | null;
  created_at: string;
}

export interface ReviewQueueItem {
  progress: UserWordProgressRow;
  word: { id: string; slug: string; title: string; lemma: string };
}

// ── Note ────────────────────────────────────────────────────────────────
export interface NoteRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  content_md: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NoteRevisionRow {
  id: string;
  note_id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  content_md: string;
  version: number;
  created_at: string;
}

// ── Wordbook ────────────────────────────────────────────────────────────
export interface WordbookRow {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  settings: Json;
  created_at: string;
  updated_at: string;
}

// ── Session ─────────────────────────────────────────────────────────────
export interface SessionRow {
  id: string;
  user_id: string;
  wordbook_id: string;
  mode: string;
  cards_seen: number;
  started_at: string;
  ended_at: string | null;
}

// ── Highlight / Annotation ──────────────────────────────────────────────
export interface HighlightRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  source_field: string | null;
  text_snippet: string;
  color: string;
  created_at: string;
}

export interface AnnotationRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  content: string;
  updated_at: string;
}

// ── L2 Progress ──────────────────────────────────────────────────────────────

export interface UserWordL2ProgressRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  l2_stability: number | null;
  l2_difficulty: number | null;
  l2_retrievability: number | null;
  l2_state: string;
  l2_desired_retention: number;
  l2_due_at: string | null;
  l2_last_reviewed_at: string | null;
  l2_last_rating: string | null;
  l2_review_count: number;
  l2_lapse_count: number;
  l2_interval_days: number | null;
  l2_scheduler_payload: unknown;
  l2_again_count: number;
  l2_hard_count: number;
  l2_good_count: number;
  l2_easy_count: number;
  l2_content_hash_snapshot: string | null;
  recent_ratings: string[];
  l2_paused: boolean;
  l2_paused_at: string | null;
  l2_paused_reason: string | null;
  l2_inherited_from_l1: boolean;
  l2_weights_source: string;
  l2_predicted_retrievability: number | null;
  // ⚠️ NOT the L3 main model — see ADR-0005. Unused placeholder flags on the L2 row;
  // real L3 context space will be an independent l3_ table family in Phase 3, not in FSRS.
  l3_pending: boolean;
  l3_self_assessments: unknown[];
  created_at: string;
}

// ── L2 Content ───────────────────────────────────────────────────────────
// Multi-source L2 enrichment content for a word (collocations / corpus /
// synonym / antonym). `content` is opaque JSONB; `field` discriminates the
// kind so refreshL2Cache can group rows back into the words JSONB columns.

export interface L2ContentRow {
  id: string;
  word_id: string;
  field: string;
  content: Json;
  source: string;
  source_ref: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  is_active: boolean;
}

// ── L3 Context Space ────────────────────────────────────────────────────

export type L3SourceType = "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
export type L3ContextType = "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
export type L3ContextLinkType =
  | "supports"
  | "illustrates"
  | "contrasts"
  | "collocates_with"
  | "synonym_of"
  | "antonym_of"
  | "derived_from"
  | "topic_related"
  | "manual_link";
export type L3ContextLinkTargetType = "word" | "l2_item" | "context" | "source" | "topic" | "external";
export type L3ImportJobStatus = "pending" | "processing" | "completed" | "failed";

export interface L3SourceRow {
  id: string;
  user_id: string;
  wordbook_id: string | null;
  source_type: L3SourceType;
  title: string;
  author: string | null;
  url: string | null;
  language: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface L3ContextRow {
  id: string;
  source_id: string;
  user_id: string;
  context_type: L3ContextType;
  text: string;
  normalized_text: string | null;
  language: string | null;
  position: Json;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface L3OccurrenceRow {
  id: string;
  context_id: string;
  word_id: string;
  user_id: string;
  surface: string;
  lemma: string | null;
  start_offset: number | null;
  end_offset: number | null;
  confidence: number | string | null;
  evidence: Json;
  created_at: string;
}

export interface L3ContextLinkRow {
  id: string;
  user_id: string;
  context_id: string | null;
  word_id: string | null;
  link_type: L3ContextLinkType;
  target_type: L3ContextLinkTargetType;
  target_id: string | null;
  target_ref: Json;
  confidence: number | string | null;
  provenance: Json;
  created_at: string;
}

export interface L3ImportJobRow {
  id: string;
  user_id: string;
  source_id: string | null;
  status: L3ImportJobStatus;
  input_hash: string;
  input_summary: string | null;
  stats: Json;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3WordContextListItem {
  context: L3ContextRow;
  source: L3SourceRow;
  occurrence: L3OccurrenceRow | null;
  links: L3ContextLinkRow[];
}

export interface L3SourceContextListItem {
  context: L3ContextRow;
  source: L3SourceRow;
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
}

export interface L3PaginatedList<T> {
  items: T[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface L3ContextDetail {
  context: L3ContextRow;
  source: L3SourceRow;
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
}

export interface L3ReadStats {
  sourceCount: number;
  contextCount: number;
  occurrenceCount: number;
  linkCount: number;
}

export interface L3WordSpace {
  word: WordRow;
  contexts: L3ContextRow[];
  sources: L3SourceRow[];
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
  stats: L3ReadStats;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface L3SourceSpace {
  source: L3SourceRow;
  contexts: L3ContextRow[];
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
  stats: L3ReadStats;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export type L3GraphNodeType = "word" | "context" | "source" | "l2_item" | "topic" | "external";

export interface L3GraphNode {
  id: string;
  type: L3GraphNodeType;
  label: string;
  ref: Json;
  metadata?: Json;
}

export interface L3GraphEdge {
  id: string;
  type: L3ContextLinkType | "occurs_in" | "belongs_to";
  sourceNodeId: string;
  targetNodeId: string;
  confidence?: number | string | null;
  provenance?: Json;
  evidence?: Json;
}

export interface L3GraphReadModel {
  nodes: L3GraphNode[];
  edges: L3GraphEdge[];
  stats: L3ReadStats & {
    nodeCount: number;
    edgeCount: number;
  };
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  metadata?: Json;
}

export type L3ProposalSourceType = "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
export type L3ProposalStatus = "pending" | "confirmed" | "rejected" | "canceled";
export type L3ProposalItemType = "source" | "context" | "occurrence" | "context_link";
export type L3ProposalItemStatus = "pending" | "confirmed" | "rejected";
export type L3ProposalActiveEntityType = "source" | "context" | "occurrence" | "context_link";

export interface L3ProposalRow {
  id: string;
  user_id: string;
  wordbook_id: string | null;
  source_type: L3ProposalSourceType;
  status: L3ProposalStatus;
  title: string | null;
  summary: string | null;
  input_hash: string | null;
  proposed_by: string | null;
  provenance: Json;
  review_note: string | null;
  confirmed_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3ProposalItemRow {
  id: string;
  proposal_id: string;
  user_id: string;
  item_type: L3ProposalItemType;
  ordinal: number;
  payload: Json;
  status: L3ProposalItemStatus;
  validation_errors: Json;
  active_entity_type: L3ProposalActiveEntityType | null;
  active_entity_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3ProposalBundle {
  proposal: L3ProposalRow;
  items: L3ProposalItemRow[];
}

export interface L3ProposalValidationIssue {
  itemId: string;
  ordinal: number;
  itemType: L3ProposalItemType;
  field: string;
  message: string;
}

export interface L3ProposalValidationResult extends L3ProposalBundle {
  valid: boolean;
  errors: L3ProposalValidationIssue[];
}

export interface L3ProposalConfirmResult extends L3ProposalBundle {
  activeEntities: Array<{
    itemId: string;
    itemType: L3ProposalItemType;
    activeEntityType: L3ProposalActiveEntityType;
    activeEntityId: string;
  }>;
}

export type L3RecommendationType =
  | "review_pack"
  | "learn_next"
  | "link_gap"
  | "context_gap"
  | "l2_gap"
  | "weak_word"
  | "related_word";
export type L3RecommendationStatus = "pending" | "accepted" | "rejected" | "dismissed" | "expired";
export type L3RecommendationRunMode = "review_pack" | "learn_next" | "gap_scan" | "link_suggestions";
export type L3RecommendationRunStatus = "completed" | "failed";
export type L3RecommendationEvidenceType =
  | "graph_edge"
  | "occurrence_count"
  | "fsrs_due"
  | "fsrs_weak"
  | "l2_missing_field"
  | "l3_context_missing"
  | "wordbook_neighbor"
  | "recent_import"
  | "manual_seed";

export interface L3RecommendationEvidence {
  type: L3RecommendationEvidenceType;
  ref: Json;
  weight?: number;
  note?: string;
}

export interface L3RecommendationRunRow {
  id: string;
  user_id: string;
  wordbook_id: string | null;
  mode: L3RecommendationRunMode;
  status: L3RecommendationRunStatus;
  input_hash: string | null;
  stats: Json;
  created_at: string;
  completed_at: string | null;
}

export interface L3RecommendationItemRow {
  id: string;
  run_id: string;
  user_id: string;
  wordbook_id: string | null;
  recommendation_type: L3RecommendationType;
  status: L3RecommendationStatus;
  title: string;
  summary: string;
  priority_score: number | string;
  confidence: number | string;
  reason_codes: Json;
  evidence: Json;
  payload: Json;
  accepted_proposal_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  dismissed_at: string | null;
}

export interface L3RecommendationBundle {
  run: L3RecommendationRunRow;
  items: L3RecommendationItemRow[];
  stats: Json;
}

export interface L3RecommendationAcceptResult {
  item: L3RecommendationItemRow;
  proposal?: L3ProposalBundle;
  actionPayload?: Json;
}
