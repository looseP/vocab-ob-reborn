/**
 * Repository interfaces — contracts that concrete repositories implement.
 *
 * Parameter order convention: (userId, wordbookId, wordId, ...) —
 * wordbookId always precedes wordId for consistency.
 */

import type {
  WordRow,
  WordSummary,
  PaginatedResult,
  GetPublicWordsOptions,
  UserWordProgressRow,
  NoteRow,
  NoteRevisionRow,
  WordbookRow,
  HighlightRow,
  AnnotationRow,
  SessionRow,
  ReviewState,
  ReviewRating,
  Json,
} from "../domain";

// ── Word ────────────────────────────────────────────────────────────────
export interface IWordRepository {
  findById(id: string): Promise<WordRow | null>;
  findBySlug(slug: string): Promise<WordRow | null>;
  findPublic(options: GetPublicWordsOptions): Promise<PaginatedResult<WordSummary>>;
  count(): Promise<number>;
  findSlugs(limit?: number): Promise<string[]>;
}

// ── Review ──────────────────────────────────────────────────────────────
/** Progress row joined with words for FOR UPDATE locking. */
export interface ProgressWithContentHash extends UserWordProgressRow {
  content_hash: string;
  word_slug: string;
  word_title: string;
  word_lemma: string;
}

/** Minimal progress fields needed for skip/suspend (not full row). */
export interface ProgressForAction {
  id: string;
  word_id: string;
  wordbook_id: string;
  state: ReviewState;
  skip_count: number;
}

export interface SaveAnswerInput {
  progressId: string;
  userId: string;
  wordId: string;
  wordbookId: string;
  sessionId: string | null;
  rating: ReviewRating;
  scheduling: {
    difficulty: number | null;
    dueAt: string;
    logDueAt: string | null;
    elapsedDays: number;
    scheduledDays: number;
    retrievability: number | null;
    stability: number | null;
    state: ReviewState;
    nextPayload: Json;
  };
  idempotencyKey: string | null;
  previousSnapshot: Json;
  logMetadata: Record<string, unknown>;
}

/** Result of an undo RPC call. */
export interface UndoRpcResult {
  success: boolean;
  progressId: string | null;
  wordId: string | null;
  errorMessage: string | null;
}

export interface IReviewRepository {
  findDueCards(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string } }>
  >;

  /** Advisory lock + idempotency check. MUST be in a transaction. */
  checkIdempotency(idempotencyKey: string): Promise<string | null>;

  /** SELECT FOR UPDATE with word join. MUST be in a transaction. */
  findProgressForUpdate(progressId: string): Promise<ProgressWithContentHash | null>;

  /** SELECT FOR UPDATE minimal fields for skip. MUST be in a transaction. */
  findProgressForSkip(progressId: string, userId: string): Promise<ProgressForAction | null>;

  /** SELECT FOR UPDATE minimal fields for suspend. MUST be in a transaction. */
  findProgressForSuspend(progressId: string, userId: string): Promise<ProgressForAction | null>;

  /** UPDATE progress + INSERT review_log. MUST be in a transaction. */
  saveAnswer(input: SaveAnswerInput): Promise<{ reviewLogId: string }>;

  /** UPDATE skip_count + INSERT review_log (action=skip). MUST be in a transaction. */
  skipCard(progress: ProgressForAction, userId: string, sessionId: string | null, idempotencyKey: string | null): Promise<{ reviewLogId: string }>;

  /** UPDATE state=suspended + INSERT review_log (action=suspend). MUST be in a transaction. */
  suspendCard(progress: ProgressForAction, userId: string, sessionId: string | null, idempotencyKey: string | null): Promise<{ reviewLogId: string }>;

  /** Call undo_review_log RPC + insert idempotency log. MUST be in a transaction. */
  undoReviewLog(reviewLogId: string, userId: string, sessionId: string, idempotencyKey: string | null): Promise<UndoRpcResult>;

  findStaleCards(wordId: string): Promise<UserWordProgressRow[]>;
  markStaleForRecheck(wordId: string, newHash: string): Promise<number>;
}

// ── Note ────────────────────────────────────────────────────────────────
export interface INoteRepository {
  findByWord(userId: string, wordbookId: string, wordId: string): Promise<NoteRow | null>;
  upsert(
    userId: string,
    wordbookId: string,
    wordId: string,
    contentMd: string,
  ): Promise<{ note: NoteRow; created: boolean }>;
  findRevisions(userId: string, wordbookId: string, wordId: string): Promise<NoteRevisionRow[]>;
}

// ── Wordbook ────────────────────────────────────────────────────────────
export interface IWordbookRepository {
  findById(id: string): Promise<WordbookRow | null>;
  findDefaultByUser(userId: string): Promise<WordbookRow | null>;
  findAllByUser(userId: string): Promise<WordbookRow[]>;
  create(userId: string, name: string, isDefault?: boolean): Promise<WordbookRow>;
  getOrCreateDefault(userId: string): Promise<WordbookRow>;
  countWords(wordbookId: string): Promise<number>;
  getWordIds(wordbookId: string): Promise<string[]>;
  addWords(wordbookId: string, wordIds: string[]): Promise<void>;
}

// ── Highlight ───────────────────────────────────────────────────────────
export interface IHighlightRepository {
  findByWords(userId: string, wordbookId: string, wordIds: string[]): Promise<HighlightRow[]>;
  create(
    userId: string,
    wordId: string,
    wordbookId: string,
    sourceField: string | null,
    textSnippet: string,
    color: string,
  ): Promise<HighlightRow>;
  delete(userId: string, wordbookId: string, highlightId: string): Promise<void>;
}

// ── Annotation ──────────────────────────────────────────────────────────
export interface IAnnotationRepository {
  findByWord(userId: string, wordbookId: string, wordId: string): Promise<AnnotationRow | null>;
  upsert(userId: string, wordbookId: string, wordId: string, content: string): Promise<AnnotationRow>;
  delete(userId: string, wordbookId: string, annotationId: string): Promise<void>;
}

// ── Session ─────────────────────────────────────────────────────────────
export interface ISessionRepository {
  findActiveByUser(userId: string, wordbookId: string, mode?: string): Promise<SessionRow | null>;
  getOrCreateToday(userId: string, wordbookId: string, mode?: string): Promise<SessionRow>;
  create(userId: string, wordbookId: string, mode?: string): Promise<SessionRow>;
  incrementCardsSeen(sessionId: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;
}

// ── Stats ───────────────────────────────────────────────────────────────
export interface DashboardSummary {
  totalWords: number;
  trackedWords: number;
  dueToday: number;
  reviewedToday: number;
  reviewed7d: number;
  reviewed30d: number;
  streakDays: number;
  notesCount: number;
}

export interface RatingDistribution {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface IStatsRepository {
  getDashboardSummary(userId: string, wordbookId: string): Promise<DashboardSummary>;
  getRatingDistribution(userId: string, wordbookId: string, days?: number): Promise<RatingDistribution>;
}

// ── Aggregate ───────────────────────────────────────────────────────────
export interface IRepositories {
  words: IWordRepository;
  reviews: IReviewRepository;
  notes: INoteRepository;
  wordbooks: IWordbookRepository;
  highlights: IHighlightRepository;
  annotations: IAnnotationRepository;
  sessions: ISessionRepository;
  stats: IStatsRepository;
}
