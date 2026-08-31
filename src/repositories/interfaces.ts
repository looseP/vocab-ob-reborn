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
  UserWordL2ProgressRow,
  L2DrillStepRow,
  L2ContentRow,
  L3ContextLinkRow,
  L3ContextRow,
  L3ContextDetail,
  L3GraphReadModel,
  L3ImportJobRow,
  L3OccurrenceRow,
  L3PaginatedList,
  L3ProposalBundle,
  L3ProposalItemRow,
  L3ProposalRow,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
  L3SourceContextListItem,
  L3SourceRow,
  L3SourceSpace,
  L3WordSpace,
  L3WordContextListItem,
  NoteRow,
  NoteRevisionRow,
  WordbookRow,
  HighlightRow,
  AnnotationRow,
  SessionRow,
  ReviewState,
  ReviewRating,
  SemanticFieldGroupRow,
  PlazaWordRow,
  Json,
} from "../domain";

// ── Word ────────────────────────────────────────────────────────────────
export interface IWordRepository {
  findById(id: string): Promise<WordRow | null>;
  findBySlug(slug: string): Promise<WordRow | null>;
  findPublic(options: GetPublicWordsOptions): Promise<PaginatedResult<WordSummary>>;
  /** 输入联想：按 lemma / 拼音前缀返回 top-N 建议（L1-2）。 */
  suggest(q: string, limit?: number): Promise<WordSummary[]>;
  /**
   * 词汇广场（P4）：按 L1 语义场 source_path 前缀实时聚合分组（自生长集合）。
   * q 非空时在 SQL 层按语义场名过滤。
   */
  findSemanticFieldGroups(q?: string): Promise<SemanticFieldGroupRow[]>;
  /** 词汇广场（P4）：取某语义场 source_path 前缀下的全部已发布词（含 updated_at）。 */
  findBySourcePathPrefix(prefix: string): Promise<PlazaWordRow[]>;
  count(): Promise<number>;
  findSlugs(limit?: number): Promise<string[]>;
  insertMany?(words: Array<{
    slug: string; title: string; lemma: string; pos: string | null;
    cefr: string | null; ipa: string | null; short_definition: string | null;
  }>): Promise<number>;
  /**
   * Full-note upsert through the dedicated batch-import role. Hash-guarded:
   * when the stored content_hash already equals the incoming one the update
   * is skipped ("unchanged"). Writes definition/body/metadata/etc. beyond the
   * minimal stub fields handled by insertMany. MUST be called outside an app
   * transaction (uses its own pool); each call is atomic on its own.
   */
  upsertFullWord?(input: UpsertFullWordInput): Promise<"imported" | "unchanged">;
}

/** Payload for the rich-note import upsert (all words-table content fields). */
export interface UpsertFullWordInput {
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  aliases: string[];
  shortDefinition: string | null;
  definitionMd: string;
  bodyMd: string;
  /** JSON.stringify-ready payload for the examples jsonb column. */
  examplesJson: unknown;
  metadataJson: unknown;
  coreDefinitionsJson: unknown;
  prototypeText: string | null;
  contentHash: string;
  sourcePath: string;
  sourceUpdatedAt: string | null;
  isPublished: boolean;
  qualityStatus: "ok" | "needs_supplement";
  qualityIssuesJson: unknown;
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

/** Input for creating a brand-new L1 card (state='new'). */
export interface InsertNewCardInput {
  userId: string;
  wordId: string;
  wordbookId: string;
  /** Numeric string written to desired_retention, e.g. "0.850". */
  desiredRetention: string;
}

/** Result status of an atomic new-card insert attempt. */
export type InsertNewCardStatus =
  | { status: "inserted"; progressId: string }
  | { status: "duplicate"; progressId: null }
  | { status: "word_not_found"; progressId: null }
  | { status: "wordbook_invalid"; progressId: null };

export interface SaveAnswerInput {
  progressId: string;
  userId: string;
  wordId: string;
  wordbookId: string;
  sessionId: string | null;
  rating: ReviewRating;
  /** M-NEW-4 fix: current word content_hash to refresh snapshot */
  contentHash: string;
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
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }>
  >;

  /** Due candidate pool (with needs_recheck) consumed by the P1 queue-priority builder. */
  findDueCandidates(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow & { needs_recheck: boolean }; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }>
  >;

  /** All active (non-suspended) cards regardless of due_at — used by cram/preview practice modes. */
  findPracticeCards(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }>
  >;

  /** Free-review selection: fetch words by ids directly (published only), independent of review progress. */
  findWordsByIds(wordIds: string[]): Promise<
    Array<{ id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null }>
  >;

  /** Drill candidates: already-reviewed words joined with examples for cloze resolution. */
  findDrillCandidates(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; examples: Json } }>
  >;

  getStats?(userId: string, wordbookId: string): Promise<{
    todayCount: number;
    totalCount: number;
    ratingDist: { again: number; hard: number; good: number; easy: number };
  }>;

  findLeeches?(userId: string, wordbookId: string, limit: number): Promise<Array<UserWordProgressRow & { slug: string; title: string; lemma: string; w_id: string; short_definition: string | null }>>;

  getTimeline?(userId: string, wordbookId: string, limit: number): Promise<Array<{ id: string; rating: string; created_at: string; word_slug: string; word_lemma: string }>>;

  getHeatmap?(userId: string, wordbookId: string, days: number): Promise<Array<{ date: string; count: string }>>;

  /** User-scoped advisory lock + idempotency check. MUST be in a transaction. */
  checkIdempotency(userId: string, idempotencyKey: string): Promise<string | null>;

  /** Owner-scoped SELECT FOR UPDATE with word join. MUST be in a transaction. */
  findProgressForUpdate(progressId: string, userId: string): Promise<ProgressWithContentHash | null>;

  /** SELECT FOR UPDATE minimal fields for skip. MUST be in a transaction. */
  findProgressForSkip(progressId: string, userId: string): Promise<ProgressForAction | null>;

  /** SELECT FOR UPDATE minimal fields for suspend. MUST be in a transaction. */
  findProgressForSuspend(progressId: string, userId: string): Promise<ProgressForAction | null>;

  /** Load the current authoritative progress for outbox convergence. MUST be in a transaction. */
  findProgressForOutbox(progressId: string, userId: string, wordbookId: string): Promise<UserWordProgressRow | null>;

  /**
   * Atomically create a new L1 card (state='new', algo='fsrs'). Guards word
   * existence and wordbook ownership in the same transaction; duplicate
   * (user_id, word_id, wordbook_id) resolves to 'duplicate' instead of throwing.
   * MUST be in a transaction.
   */
  insertNewCard(input: InsertNewCardInput): Promise<InsertNewCardStatus>;

  /** UPDATE progress + INSERT review_log. MUST be in a transaction. */
  saveAnswer(input: SaveAnswerInput): Promise<{ reviewLogId: string }>;

  /** UPDATE skip_count + INSERT review_log (action=skip). MUST be in a transaction. */
  skipCard(progress: ProgressForAction, userId: string, sessionId: string | null, idempotencyKey: string | null): Promise<{ reviewLogId: string }>;

  /** UPDATE state=suspended + INSERT review_log (action=suspend). MUST be in a transaction. */
  suspendCard(progress: ProgressForAction, userId: string, sessionId: string | null, idempotencyKey: string | null): Promise<{ reviewLogId: string }>;

  /** Resolve the owner-scoped wordbook for an undoable review log. MUST be in a transaction. */
  findReviewLogWordbookForUndo(reviewLogId: string, userId: string): Promise<string | null>;

  /** Call owner/wordbook-scoped undo_review_log RPC + insert idempotency log. MUST be in a transaction. */
  undoReviewLog(
    reviewLogId: string,
    userId: string,
    wordbookId: string,
    sessionId: string,
    idempotencyKey: string | null,
  ): Promise<UndoRpcResult>;

  findStaleCards(wordId: string): Promise<UserWordProgressRow[]>;

  /** @deprecated Use {@link markL1StaleForRecheck} — tracks the L1 hash
   *  snapshot separately. Kept for backward compatibility. */
  markStaleForRecheck(wordId: string, newHash: string): Promise<number>;

  /** Mark stale cards for recheck using the L1 content hash snapshot. */
  markL1StaleForRecheck(wordId: string, newL1Hash: string): Promise<number>;

  /**
   * Set the L1 weak-signal flag for a single progress row, scoped to
   * (user, wordbook, word). Phase 2C decision-2: L2→L1 only *marks* — it
   * never re-cards or touches due_at/needs_recheck. The user decides whether
   * to re-grind L1 after seeing the flag in the UI.
   *
   * Returns the number of rows updated (0 if no progress row exists).
   */
  markL1WeakSignal(
    userId: string,
    wordbookId: string,
    wordId: string,
    value: boolean,
  ): Promise<number>;
}

// ── Transactional Outbox ───────────────────────────────────────────────
export type OutboxStatus = "pending" | "retry" | "processing" | "processed" | "dead_letter";

export interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Json;
  dedupe_key: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  locked_until: string | null;
  locked_by: string | null;
  last_error: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueOutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Json;
  dedupeKey: string;
  maxAttempts?: number;
}

export interface OutboxMetrics {
  pending: number;
  processing: number;
  deadLetter: number;
  oldestPendingAgeSeconds: number | null;
}

export interface IOutboxRepository {
  /** Insert an event in the caller's authoritative transaction. */
  enqueue(input: EnqueueOutboxEventInput): Promise<{ id: string; inserted: boolean }>;
  /** Requeue expired leases, or dead-letter them when attempts are exhausted. */
  recoverExpiredLeases(): Promise<number>;
  /** Atomically claim an ordered batch using FOR UPDATE SKIP LOCKED. */
  claimBatch(workerId: string, limit: number, leaseSeconds: number): Promise<OutboxEventRow[]>;
  /** Lock the claimed event and return false when this effect already has a receipt. */
  beginEffect(eventId: string, effectName: string, workerId: string): Promise<boolean>;
  /** Record a completed effect in the same transaction as the effect write. */
  completeEffect(eventId: string, effectName: string): Promise<void>;
  markProcessed(eventId: string, workerId: string): Promise<void>;
  markFailed(eventId: string, workerId: string, errorMessage: string, retryDelaySeconds: number): Promise<OutboxStatus>;
  replayDeadLetter(eventId: string): Promise<boolean>;
  getMetrics(): Promise<OutboxMetrics>;
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
  listByUser?(userId: string, limit: number, offset: number): Promise<Array<NoteRow & { word_slug: string; word_lemma: string; word_title: string }>>;
}

// ── Wordbook ────────────────────────────────────────────────────────────
export interface IWordbookRepository {
  findById(id: string): Promise<WordbookRow | null>;
  findDefaultByUser(userId: string): Promise<WordbookRow | null>;
  findAllByUser(userId: string): Promise<WordbookRow[]>;
  create(userId: string, name: string, isDefault?: boolean, description?: string | null): Promise<WordbookRow>;
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
  /** Lock and verify an active Session belongs to the actor and wordbook. MUST be in a transaction. */
  assertActiveOwned(sessionId: string, userId: string, wordbookId: string): Promise<void>;
  incrementCardsSeen(sessionId: string, userId: string, wordbookId: string): Promise<void>;
  /** Apply a previously authorized review event even if the Session ended after commit. MUST be in a transaction. */
  incrementCardsSeenFromOutbox(sessionId: string, userId: string, wordbookId: string): Promise<void>;
  endSession(sessionId: string, userId: string, wordbookId: string): Promise<void>;
}

// ── L2 Progress ─────────────────────────────────────────────────────────
/** Input for creating a new L2 progress row (inherited from L1 FSRS state). */
export interface NewL2Progress {
  user_id: string;
  wordbook_id: string;
  word_id: string;
  l2_stability: number;
  l2_difficulty: number;
  l2_state: string;
  l2_desired_retention: number;
  l2_due_at: string;
  l2_inherited_from_l1: boolean;
  l2_weights_source: string;
  /**
   * Initial StoredSchedulerCard (2026-08-24 l2-drill spec §四 payload 断路修复).
   * Inherited rows are born in ts-fsrs Review state with the inherited
   * S/D — without this, toCard({}) degrades the card to a fresh New card.
   */
  l2_scheduler_payload?: Json;
}

/** Word content caches joined for L2 drill queue/task generation (spec §五). */
export interface L2WordContent {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  ipa: string | null;
  cefr: string | null;
  short_definition: string | null;
  corpus_items: Json;
  synonym_items: Json;
  antonym_items: Json;
}

/** SELECT FOR UPDATE result for the L2 answer path (spec §八 step 2). */
export interface L2ProgressForUpdate {
  progress: UserWordL2ProgressRow;
  word: L2WordContent;
}

/** Persist one L2 review: full l2_* reschedule + track='l2' review log. */
export interface SaveL2AnswerInput {
  progressId: string;
  userId: string;
  wordbookId: string;
  wordId: string;
  rating: ReviewRating;
  state: string;
  stability: number | string | null;
  difficulty: number | string | null;
  retrievability: number | string | null;
  dueAt: string;
  lastReviewedAt: string;
  intervalDays: number | null;
  scheduledDays: number | null;
  /** H3 修复：距上次复习的流逝天数（来自 FSRS scheduling.elapsedDays）。
   * 之前 INSERT 把 scheduledDays 错填到 elapsed_days 列、scheduled_days 恒为 null，
   *  导致 L2 track 的 review_logs 审计数据错乱。 */
  elapsedDays: number | null;
  nextPayload: Json;
  contentHashSnapshot: string;
  previousSnapshot: Json;
  logMetadata: Json;
  sessionId: string | null;
  idempotencyKey: string | null;
}

export interface NewL2DrillStep {
  session_id: string;
  user_id: string;
  wordbook_id: string;
  word_id: string;
  progress_id: string;
  step_index: number;
  step_type: "l2_discrimination" | "l2_production";
  task_id?: string | null;
  task_type?: string | null;
  task_payload?: Json;
}

export interface IL2ProgressRepository {
  /**
   * Find a single L2 progress row scoped to (user, wordbook, word).
   * Wordbook scoping is mandatory: the same user reviewing the same word in
   * two different wordbooks must have independent L2 progress rows.
   */
  findByWordbookWordAndUser(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<UserWordL2ProgressRow | null>;
    insert(data: NewL2Progress): Promise<UserWordL2ProgressRow>;
    /** L2 到期口径队列（l2_drill spec §一）：未暂停且 l2_due_at <= now，按到期升序。 */
    findDueCards(
      userId: string,
      wordbookId: string,
      limit: number,
    ): Promise<Array<{ progress: UserWordL2ProgressRow; word: L2WordContent }>>;
    /** SELECT FOR UPDATE + JOIN words 缓存（spec §八 step 2）。MUST be in a transaction. */
    findForUpdate(progressId: string, userId: string): Promise<L2ProgressForUpdate | null>;
    /**
     * Atomically persist one L2 review: reschedule every l2_* field, append
     * recent_ratings, bump the rating counter + lapse counter, refresh the
     * content-hash snapshot, and INSERT the track='l2' review log.
     * MUST be in a transaction. Returns the new log id for outbox wiring.
     */
    saveL2Answer(input: SaveL2AnswerInput): Promise<{ reviewLogId: string }>;
    /** Capability-stage marker for the production step (spec §〇½ D6'). NULL = 未做过产出。 */
    updateProductionStatus(
      userId: string,
      wordbookId: string,
      wordId: string,
      status: "passed" | "weak" | null,
    ): Promise<void>;
    /** 幂等建步（UNIQUE(session,word,step_index) 冲突时静默返回既有行）。 */
    insertDrillStepIfAbsent(data: NewL2DrillStep): Promise<L2DrillStepRow>;
    /** SELECT FOR UPDATE。MUST be in a transaction. */
    findDrillStepForUpdate(stepId: string, userId: string): Promise<L2DrillStepRow | null>;
    findLastDrillStep(sessionId: string, userId: string): Promise<L2DrillStepRow | null>;
    /**
     * M5 修复：幂等重放查找同会话同词的指定 step_index 行。
     * 用于辨析步重放命中已结算记录后，重新找回产出步入口。
     * 不上锁（SELECT 不带 FOR UPDATE），调用方仅在已确认幂等重放时使用。
     */
    findDrillStepBySessionWordStep(
      sessionId: string,
      userId: string,
      wordId: string,
      stepIndex: number,
    ): Promise<L2DrillStepRow | null>;
    /**
     * M8 修复：取本会话所有 pending 产出步（含 progress + word JOIN）。
     * getQueue 在常规到期卡之外追加这些半截会话步，让前端刷新后能继续走产出。
     * 不上锁：调用方在写路径（INSERT 已完成，仅做读侧补集）。
     */
    findPendingProductionStepsForResume(
      sessionId: string,
      userId: string,
    ): Promise<
      Array<{
        step: L2DrillStepRow;
        progress: UserWordL2ProgressRow;
        word: L2WordContent;
      }>
    >;
    /**
     * M7 修复：L2 辨析步撤销所需的 review_log 行读取。
     * 返回 review_logs.undone / previous_progress_snapshot / word_id / wordbook_id；
     * 必须是 track='l2'、未撤销、且 snapshot 非空。MUST be in a transaction.
     */
    findReviewLogForL2Undo(
      reviewLogId: string,
      userId: string,
    ): Promise<{
      wordId: string;
      wordbookId: string;
      undone: boolean;
      previousSnapshot: Json;
    } | null>;
    /**
     * M7 修复：把 previous_progress_snapshot 回写到 user_word_l2_progress 行。
     * 与 L1 undo_review_log RPC 对 L1 表的等价动作，但作用于 L2 表。
     * MUST be in a transaction. 返回受影响行数（0 表示 progress 已不存在/不属该用户）。
     */
    applyL2UndoSnapshot(
      progressId: string,
      userId: string,
      previousSnapshot: Json,
    ): Promise<number>;
    /**
     * M7 修复：标记 review_logs 行 undone=true + undone_at=now()。
     * MUST be in a transaction. 返回受影响行数。
     */
    markL2ReviewLogUndone(reviewLogId: string, userId: string): Promise<number>;
    /**
     * M7 修复：插入撤销幂等审计行到 review_logs（track='l2'、rating=NULL、
     * metadata={action:'undo', undone_log_id}）。与 L1 undoReviewLog 的
     * 幂等日志结构对齐，复用 checkIdempotency 的检测路径。MUST be in a transaction.
     */
    insertL2UndoAuditLog(input: {
      userId: string;
      wordId: string;
      wordbookId: string;
      progressId: string;
      sessionId: string;
      reviewLogId: string;
      restoredState: string;
      idempotencyKey: string | null;
    }): Promise<void>;
    completeDrillStep(
      stepId: string,
      userId: string,
      patch: {
        outcome: NonNullable<L2DrillStepRow["outcome"]>;
        mappedRating?: L2DrillStepRow["mapped_rating"];
        reviewLogId?: string | null;
      },
    ): Promise<void>;
    /** 竞态降级：步标 skipped（不产生 outcome/计数）。 */
    skipDrillStep(stepId: string, userId: string): Promise<void>;
    deleteDrillStep(stepId: string, userId: string): Promise<void>;
    /**
     * Atomically persist the canonical L2/full hashes and schedule stale,
     * non-paused L2 progress rows for recheck. L2 content is global per word,
     * so every user/wordbook snapshot for that word is considered.
     */
  finalizeL2ContentHash(wordId: string, newL2Hash: string, newContentHash: string): Promise<number>;
  /** Pause L2 progress scoped to (user, wordbook, word). */
  pause(userId: string, wordbookId: string, wordId: string, reason: string): Promise<void>;
  /** Unpause L2 progress scoped to (user, wordbook, word) by reason. */
  unpauseByReason(userId: string, wordbookId: string, wordId: string, reason: string): Promise<void>;
}

// ── L2 Content ─────────────────────────────────────────────────────────
/** Input for inserting a new L2 content row (multi-source enrichment). */
export interface NewL2Content {
  word_id: string;
  field: string;
  content: Json;
  source: string;
  source_ref?: string | null;
  approved_by?: string | null;
}

export interface IL2ContentRepository {
  insert(data: NewL2Content): Promise<L2ContentRow>;
  findByWord(wordId: string, field?: string): Promise<L2ContentRow[]>;
  softDelete(id: string): Promise<void>;
  /** Aggregate active L2 content rows into the words JSONB cache columns. */
  refreshL2Cache(wordId: string): Promise<void>;
}

// ── L3 Context Space ───────────────────────────────────────────────────
export interface NewL3Source {
  user_id: string;
  wordbook_id?: string | null;
  source_type: string;
  title: string;
  author?: string | null;
  url?: string | null;
  language?: string | null;
  metadata?: Json;
}

export interface NewL3Context {
  user_id: string;
  source_id: string;
  context_type: string;
  text: string;
  normalized_text?: string | null;
  language?: string | null;
  position?: Json;
  metadata?: Json;
}

export interface NewL3Occurrence {
  user_id: string;
  context_id: string;
  word_id: string;
  surface: string;
  lemma?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  confidence?: number | null;
  evidence?: Json;
}

export interface NewL3ContextLink {
  user_id: string;
  context_id?: string | null;
  word_id?: string | null;
  link_type: string;
  target_type: string;
  target_id?: string | null;
  target_ref?: Json;
  confidence?: number | null;
  provenance?: Json;
}

export interface NewL3ImportJob {
  user_id: string;
  source_id?: string | null;
  status: string;
  input_hash: string;
  input_summary?: string | null;
  stats?: Json;
  error?: string | null;
}

export interface L3WordLookup {
  userId: string;
  wordId?: string;
  slug?: string;
  limit: number;
  cursor?: string | null;
}

export interface L3SourceLookup {
  userId: string;
  sourceId: string;
  limit: number;
  cursor?: string | null;
}

export interface L3WordSpaceLookup {
  userId: string;
  slug: string;
  wordbookId?: string | null;
  limit: number;
  cursor?: string | null;
}

export interface L3SourceSpaceLookup {
  userId: string;
  sourceId: string;
  limit: number;
  cursor?: string | null;
}

export interface L3GraphLookup {
  userId: string;
  wordbookId?: string | null;
  slug?: string | null;
  sourceId?: string | null;
  depth: number;
  limit: number;
  cursor?: string | null;
}

export interface L3SourceDeleteBlockers {
  contextCount: number;
  inboundContextLinkCount: number;
  importJobCount: number;
}

export interface L3ContextDeleteBlockers {
  occurrenceCount: number;
  contextLinkCount: number;
  inboundContextLinkCount: number;
}

export interface IL3ContextRepository {
  createSource(input: NewL3Source): Promise<L3SourceRow>;
  createContext(input: NewL3Context): Promise<L3ContextRow>;
  createOccurrence(input: NewL3Occurrence): Promise<L3OccurrenceRow>;
  createContextLink(input: NewL3ContextLink): Promise<L3ContextLinkRow>;
  deleteOccurrence(userId: string, occurrenceId: string): Promise<L3OccurrenceRow | null>;
  deleteContextLink(userId: string, contextLinkId: string): Promise<L3ContextLinkRow | null>;
  lockSourceByIdForUser(userId: string, sourceId: string): Promise<L3SourceRow | null>;
  lockContextByIdForUser(userId: string, contextId: string): Promise<L3ContextRow | null>;
  lockActiveL3TargetReference(userId: string, targetType: "source" | "context", targetId: string): Promise<void>;
  getSourceDeleteBlockers(userId: string, sourceId: string): Promise<L3SourceDeleteBlockers>;
  getContextDeleteBlockers(userId: string, contextId: string): Promise<L3ContextDeleteBlockers>;
  deleteSource(userId: string, sourceId: string): Promise<L3SourceRow | null>;
  deleteContext(userId: string, contextId: string): Promise<L3ContextRow | null>;
  createImportJob(input: NewL3ImportJob): Promise<L3ImportJobRow>;
  /** Find a completed import job by (userId, inputHash) for idempotent re-submission. */
  findImportJobByInputHash(userId: string, inputHash: string): Promise<L3ImportJobRow | null>;
  updateImportJobStatus(
    importJobId: string,
    userId: string,
    status: string,
    stats?: Json,
    error?: string | null,
  ): Promise<L3ImportJobRow>;
  findWordbookByIdForUser(userId: string, wordbookId: string): Promise<WordbookRow | null>;
  findSourceById(userId: string, sourceId: string): Promise<L3SourceRow | null>;
  findContextById(userId: string, contextId: string): Promise<L3ContextRow | null>;
  findContextWithSourceById(
    userId: string,
    contextId: string,
  ): Promise<{ context: L3ContextRow; source: L3SourceRow } | null>;
  findWordById(wordId: string): Promise<WordRow | null>;
  findWordBySlug(slug: string): Promise<WordRow | null>;
  findWordInWordbookById(wordbookId: string, wordId: string): Promise<WordRow | null>;
  findWordInWordbookBySlug(wordbookId: string, slug: string): Promise<WordRow | null>;
  listContextsForWord(input: L3WordLookup): Promise<L3PaginatedList<L3WordContextListItem>>;
  listContextsForSource(input: L3SourceLookup): Promise<L3PaginatedList<L3SourceContextListItem>>;
  getContextDetail(userId: string, contextId: string): Promise<L3ContextDetail | null>;
  getWordSpace(input: L3WordSpaceLookup): Promise<L3WordSpace | null>;
  getSourceSpace(input: L3SourceSpaceLookup): Promise<L3SourceSpace | null>;
  getGraph(input: L3GraphLookup): Promise<L3GraphReadModel>;
}

export interface NewL3Proposal {
  user_id: string;
  wordbook_id?: string | null;
  source_type: string;
  status?: string;
  title?: string | null;
  summary?: string | null;
  input_hash?: string | null;
  proposed_by?: string | null;
  provenance?: Json;
  review_note?: string | null;
}

export interface NewL3ProposalItem {
  proposal_id: string;
  user_id: string;
  item_type: string;
  ordinal: number;
  payload: Json;
  status?: string;
  validation_errors?: Json;
}

export interface L3ProposalLookup {
  userId: string;
  status?: string | null;
  limit: number;
  cursor?: string | null;
}

export interface IL3ProposalRepository {
  createProposal(input: NewL3Proposal): Promise<L3ProposalRow>;
  createProposalItem(input: NewL3ProposalItem): Promise<L3ProposalItemRow>;
  findProposalByIdForUser(userId: string, proposalId: string): Promise<L3ProposalRow | null>;
  /** Find a proposal by (userId, inputHash) for idempotent import dedup. */
  findProposalByInputHash(userId: string, inputHash: string): Promise<L3ProposalRow | null>;
  lockProposalByIdForUser(userId: string, proposalId: string): Promise<L3ProposalRow | null>;
  findProposalItems(userId: string, proposalId: string): Promise<L3ProposalItemRow[]>;
  getProposalBundle(userId: string, proposalId: string): Promise<L3ProposalBundle | null>;
  listProposals(input: L3ProposalLookup): Promise<L3PaginatedList<L3ProposalRow>>;
  updateProposalItemValidation(itemId: string, userId: string, validationErrors: Json): Promise<L3ProposalItemRow>;
  markProposalItemConfirmed(
    itemId: string,
    userId: string,
    activeEntityType: string,
    activeEntityId: string,
  ): Promise<L3ProposalItemRow>;
  markProposalItemsRejected(proposalId: string, userId: string): Promise<void>;
  markProposalConfirmed(proposalId: string, userId: string, reviewNote?: string | null): Promise<L3ProposalRow>;
  markProposalRejected(proposalId: string, userId: string, reviewNote?: string | null): Promise<L3ProposalRow>;
}

export interface NewL3RecommendationRun {
  user_id: string;
  wordbook_id?: string | null;
  mode: string;
  status?: string;
  input_hash?: string | null;
  stats?: Json;
}

export interface NewL3RecommendationItem {
  run_id: string;
  user_id: string;
  wordbook_id?: string | null;
  recommendation_type: string;
  status?: string;
  title: string;
  summary: string;
  priority_score: number;
  confidence: number;
  reason_codes: Json;
  evidence: Json;
  payload: Json;
  expires_at?: string | null;
}

export interface L3RecommendationLookup {
  userId: string;
  status?: string | null;
  recommendationType?: string | null;
  limit: number;
  cursor?: string | null;
}

export interface L3RecommendationSignalLookup {
  userId: string;
  wordbookId?: string | null;
  seedSlug?: string | null;
  horizonDays: number;
  limit: number;
}

export interface L3RecommendationSignal {
  word_id: string;
  slug: string;
  title: string;
  due_at: string | null;
  state: string | null;
  retrievability: number | string | null;
  l1_weak_signal: boolean | null;
  review_count: number | null;
  l2_retrievability: number | string | null;
  l2_due_at: string | null;
  l2_review_count: number | null;
  l2_paused: boolean | null;
  l2_fields: string[] | null;
  l3_context_count: number | string | null;
  l3_occurrence_count: number | string | null;
  l3_link_count: number | string | null;
  graph_neighbor_count: number | string | null;
}

export interface L3RecommendationLinkGapCandidate {
  context_id: string;
  source_id: string;
  word_id: string;
  word_slug: string;
  target_word_id: string;
  target_word_slug: string;
  cooccurrence_count: number | string;
}

export interface IL3RecommendationRepository {
  createRun(input: NewL3RecommendationRun): Promise<L3RecommendationRunRow>;
  createItem(input: NewL3RecommendationItem): Promise<L3RecommendationItemRow>;
  listItems(input: L3RecommendationLookup): Promise<L3PaginatedList<L3RecommendationItemRow>>;
  findItemByIdForUser(userId: string, itemId: string): Promise<L3RecommendationItemRow | null>;
  lockItemByIdForUser(userId: string, itemId: string): Promise<L3RecommendationItemRow | null>;
  markItemStatus(
    itemId: string,
    userId: string,
    status: string,
    acceptedProposalId?: string | null,
  ): Promise<L3RecommendationItemRow>;
  findSignals(input: L3RecommendationSignalLookup): Promise<L3RecommendationSignal[]>;
  findLinkGapCandidates(input: L3RecommendationSignalLookup): Promise<L3RecommendationLinkGapCandidate[]>;
}

// ── LLM Usage ──────────────────────────────────────────────────────────
/**
 * LLM token usage persistence — backs the UsageTracker budget enforcement.
 *
 * Lives at the repository boundary so src/llm never touches the DB directly
 * (Phase 2B architecture cleanup). `dayKey` is an ISO date string (YYYY-MM-DD);
 * when omitted, the repository sums usage for the current UTC day.
 */
export interface LlmReservationReaperMetrics {
  pendingCount: number;
  expiredPendingCount: number;
  oldestPendingAgeSeconds: number;
}

export interface ILlmUsageRepository {
  /** Total active budget (settled usage + non-expired reservations) for a UTC day. */
  getDailyUsage(dayKey?: string): Promise<number>;
  /** Atomically reserve tokens against the shared daily counter. */
  reserveDailyTokens(
    dayKey: string,
    tokens: number,
    dailyBudget: number,
    ttlSeconds?: number,
  ): Promise<string | null>;
  /** Extend the lease of a live reservation while its provider call is still active. */
  renewDailyTokens(reservationId: string, ttlSeconds: number): Promise<boolean>;
  /** Replace a pending or reaped reservation with actual usage; supports late provider settlement. */
  settleDailyTokens(
    reservationId: string,
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void>;
  /** Idempotently release a live reservation when the provider call fails. */
  releaseDailyTokens(reservationId: string): Promise<void>;
  /** Atomically mark up to `limit` expired pending reservations as expired. */
  expireReservations(limit: number): Promise<number>;
  /** Reservation backlog metrics for dashboards and alerts. */
  getReservationMetrics(): Promise<LlmReservationReaperMetrics>;
  /** Persist a single settled LLM call's token usage. */
  record(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void>;
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
  l2Progress: IL2ProgressRepository;
  l2Content: IL2ContentRepository;
  l3Context: IL3ContextRepository;
  l3Proposal: IL3ProposalRepository;
  l3Recommendation: IL3RecommendationRepository;
  llmUsage: ILlmUsageRepository;
  outbox: IOutboxRepository;
}
