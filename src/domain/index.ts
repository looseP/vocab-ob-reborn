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
