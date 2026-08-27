/**
 * ReviewService — the most complex service.
 *
 * H1 fix: submitAnswer uses createRepositories(tx) inside withTransaction,
 * ensuring all queries share the same transaction connection.
 *
 * H4 fix: Repository methods call requireTx() to enforce transaction context.
 *
 * H5 fix: skip/suspend/undo methods added.
 *
 * M7 fix: ReviewCard constructed with real word data from findProgressForUpdate.
 *
 * Transaction boundary: submitAnswer/skip/suspend/undo each run in one tx.
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { ReviewCard as ReviewCardEntity } from "../domain/review.entity";
import type { SubmitAnswerInput, SubmitAnswerResult, SkipReviewInput, SuspendReviewInput, UndoReviewInput } from "../schemas/service";
import {
  NotFoundError,
  BusinessRuleError,
  ConflictError,
} from "../errors";
import type { Json, ReviewRating, ReviewState, UserWordProgressRow } from "../domain";
import type { ProgressWithContentHash } from "../repositories/interfaces";
import {
  REVIEW_ANSWER_RECORDED,
  asJson,
  buildReviewAnswerRecordedPayload,
  reviewOutboxDedupeKey,
} from "../outbox/review-answer.event";
import {
  REVIEW_CARD_ENQUEUED,
  buildReviewCardEnqueuedPayload,
  enqueuePayloadAsJson,
  reviewCardEnqueuedDedupeKey,
} from "../outbox/review-card-enqueued.event";
import {
  REVIEW_QUEUE_CANDIDATE_LIMIT,
  buildReviewQueueBatch,
} from "./review-queue";
import type { ReviewQueueCandidate, ReviewQueuePriorityBucket } from "./review-queue";
import { findClozeFromExamples } from "./drill-engine";
import type { DrillCard } from "./drill-engine";

/** L1 track default until per-user settings are wired (R0 hardcode decision). */
export const L1_DEFAULT_DESIRED_RETENTION = "0.850";

export interface EnqueueCardInput {
  wordId: string;
  wordbookId: string;
}

export interface EnqueueCardResult {
  ok: true;
  progressId: string;
}

/** 复习队列项 DTO —— review/zen 模式携带优先级元数据（P1）。 */
export interface ReviewQueueItemDto {
  progressId: string;
  word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null };
  state: ReviewState;
  dueAt: string | null;
  lastRating: ReviewRating | null;
  reviewCount: number;
  l1WeakSignal: boolean;
  queueBucket?: ReviewQueuePriorityBucket;
  queueLabel?: string;
  queueReason?: string;
  retrievability?: number | null;
}

export interface ReviewQueueDto {
  items: ReviewQueueItemDto[];
  session: { id: string; mode: string; cardsSeen: number };
  stats: { total: number; remaining: number; deferredNewCards?: number };
}

export interface EnqueueCardsInput {
  wordIds: string[];
  wordbookId: string;
}

export interface EnqueueCardsResult {
  ok: true;
  added: number;
  skipped: number;
  progressIds: string[];
}

export interface ClearL1WeakSignalInput {
  wordId: string;
  wordbookId: string;
}

export interface FsrsScheduling {
  difficulty: number | null;
  dueAt: string;
  logDueAt: string | null;
  elapsedDays: number;
  scheduledDays: number;
  retrievability: number | null;
  stability: number | null;
  state: ReviewState;
  nextPayload: Json;
}

/**
 * FSRS adapter function type — the Route layer provides this.
 * Decouples ReviewService from the ts-fsrs library.
 */
export type FsrsAdapterFn = (
  schedulerPayload: Json | null,
  rating: ReviewRating,
  now: Date,
  desiredRetention: number,
  weights: number[] | null,
) => FsrsScheduling;

export interface ReviewServiceDeps {
  /** FSRS computation — M6 fix: required, not optional */
  fsrsAdapter: FsrsAdapterFn;
  /** Load wordbook-level FSRS weights (returns null if not configured) */
  loadWeights: (wordbookId: string) => Promise<number[] | null>;
  /** Find due cards for a user in a wordbook (optional: tests may omit) */
  findDueCards?: (userId: string, wordbookId: string, limit: number) => Promise<Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }>>;
  /**
   * Due candidate pool (P1): a larger pool that the queue-priority builder
   * buckets/sorts and applies the new-card quota to before returning the
   * final batch for review/zen modes. Carries needs_recheck.
   */
  findDueCandidates?: (userId: string, wordbookId: string, limit: number) => Promise<Array<{ progress: UserWordProgressRow & { needs_recheck: boolean }; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }>>;
  /** Find all active cards regardless of due_at — used by cram/preview practice modes. */
  findPracticeCards?: (userId: string, wordbookId: string, limit: number) => Promise<Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }>>;
  /** Free-review selection: fetch words by ids (published only), independent of review progress. */
  findWordsByIds?: (userId: string, wordIds: string[]) => Promise<Array<{ id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null }>>;
  /** Drill candidates: already-reviewed words joined with examples for cloze resolution. */
  findDrillCandidates?: (userId: string, wordbookId: string, limit: number) => Promise<Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; examples: Json } }>>;
  /** Get or create today's session (optional: tests may omit) */
  getOrCreateTodaySession?: (userId: string, wordbookId: string, mode?: string) => Promise<{ id: string; user_id: string; wordbook_id: string; mode: string; cards_seen: number; started_at: string; ended_at: string | null }>;
  /** Get review stats (optional) */
  getReviewStats?: (userId: string, wordbookId: string) => Promise<{ todayCount: number; totalCount: number; ratingDist: { again: number; hard: number; good: number; easy: number } }>;
  /** Find leeches (optional) */
  findLeeches?: (userId: string, wordbookId: string, limit: number) => Promise<Array<UserWordProgressRow & { slug: string; title: string; lemma: string; w_id: string; short_definition: string | null }>>;
  getTimeline?: (userId: string, wordbookId: string, limit: number) => Promise<Array<{ id: string; rating: string; created_at: string; word_slug: string; word_lemma: string }>>;
  getHeatmap?: (userId: string, wordbookId: string, days: number) => Promise<Array<{ date: string; count: string }>>;
  /**
   * Clear the L1 weak-signal flag for a single progress row (P1-4).
   * Calls markL1WeakSignal(userId, wordbookId, wordId, false) inside an
   * RLS-scoped transaction. Returns the number of rows updated.
   */
  clearL1WeakSignal?: (userId: string, wordbookId: string, wordId: string) => Promise<number>;
}

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /**
   * Get the review queue for a user: due cards + today's session.
   * Mode split:
   * - cram/preview are practice modes → full active deck (findPracticeCards),
   *   no scheduling side-effects, no priority metadata.
   * - review (and zen, which maps to review) uses the P1 queue-priority
   *   builder: a candidate pool is bucketed/sorted by predicted recall,
   *   overdue window and state tier, and a new-card quota is applied
   *   (deferredNewCards in stats).
   */
  async getQueue(userId: string, wordbookId: string, limit = 20, mode = "review", wordIds?: string[]): Promise<ReviewQueueDto> {
    if (!this.deps.findDueCards || !this.deps.getOrCreateTodaySession) {
      throw new Error("Review queue dependencies not configured");
    }
    const isPractice = mode === "cram" || mode === "preview";
    const session = await this.deps.getOrCreateTodaySession(userId, wordbookId, mode);

    if (isPractice) {
      // 自由复习勾选入口（P2）：传入 wordIds 时按选定词直接浏览（保序、无 DB 写）
      if (wordIds && wordIds.length > 0) {
        const words = (await this.deps.findWordsByIds?.(userId, wordIds)) ?? [];
        const orderMap = new Map(wordIds.map((id, i) => [id, i]));
        const ordered = words.sort(
          (a, b) => (orderMap.get(a.id) ?? Number.POSITIVE_INFINITY) - (orderMap.get(b.id) ?? Number.POSITIVE_INFINITY),
        );
        return {
          items: ordered.map((word) => ({
            progressId: word.id,
            word,
            state: "new" as const,
            dueAt: null,
            lastRating: null,
            reviewCount: 0,
            l1WeakSignal: false,
          })),
          session: {
            id: session.id,
            mode: "preview",
            cardsSeen: 0,
          },
          stats: {
            total: ordered.length,
            remaining: ordered.length,
          },
        };
      }

      const deck = this.deps.findPracticeCards ?? this.deps.findDueCards;
      const practiceCards = await deck(userId, wordbookId, limit);
      return {
        items: practiceCards.map((card) => this.toQueueItem(card)),
        session: {
          id: session.id,
          mode: session.mode,
          cardsSeen: session.cards_seen,
        },
        stats: {
          total: practiceCards.length,
          remaining: practiceCards.length,
        },
      };
    }

    // review / zen：候选池 → 优先级分桶 + 新卡配额（P1）
    const candidates = this.deps.findDueCandidates
      ? await this.deps.findDueCandidates(userId, wordbookId, REVIEW_QUEUE_CANDIDATE_LIMIT)
      : null;
    if (!candidates || candidates.length === 0) {
      // 依赖缺失或无到期候选时退回 findDueCards 直出，保持向后兼容
      const dueCards = await this.deps.findDueCards(userId, wordbookId, limit);
      return {
        items: dueCards.map((card) => this.toQueueItem(card)),
        session: {
          id: session.id,
          mode: session.mode,
          cardsSeen: session.cards_seen,
        },
        stats: {
          total: dueCards.length,
          remaining: dueCards.length,
        },
      };
    }

    let weights: number[] | null = null;
    try {
      weights = await this.deps.loadWeights(wordbookId);
    } catch {
      // 权重加载失败时回退默认权重
    }

    const batch = buildReviewQueueBatch(
      candidates.map((card) => this.toQueueCandidate(card)),
      new Date(),
      limit,
      weights,
    );

    return {
      items: batch.items.map(({ item, priority }) => ({
        progressId: item.progressId,
        word: item.word,
        state: item.state,
        dueAt: item.due_at,
        lastRating: item.lastRating,
        reviewCount: item.review_count,
        l1WeakSignal: item.l1WeakSignal,
        queueBucket: priority.bucket,
        queueLabel: priority.label,
        queueReason: priority.reason,
        retrievability: priority.retrievability,
      })),
      session: {
        id: session.id,
        mode: session.mode,
        cardsSeen: session.cards_seen,
      },
      stats: {
        total: batch.items.length,
        remaining: batch.items.length,
        deferredNewCards: batch.deferredNewCards,
      },
    };
  }

  /** 练习模式（cram/preview）的队列项 —— 无优先级元数据。 */
  private toQueueItem(card: { progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } }): ReviewQueueItemDto {
    return {
      progressId: card.progress.id,
      word: card.word,
      state: card.progress.state,
      dueAt: card.progress.due_at,
      lastRating: card.progress.last_rating,
      reviewCount: card.progress.review_count,
      l1WeakSignal: card.progress.l1_weak_signal,
    };
  }

  /** 把候选行转换成队列优先级构建器可消费的候选（携带 word/进度数据）。 */
  private toQueueCandidate(
    card: { progress: UserWordProgressRow & { needs_recheck: boolean }; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null } },
  ): ReviewQueueCandidate & { progressId: string; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null }; lastRating: ReviewRating | null; l1WeakSignal: boolean } {
    return {
      progressId: card.progress.id,
      state: card.progress.state,
      due_at: card.progress.due_at,
      review_count: card.progress.review_count,
      desired_retention: card.progress.desired_retention,
      scheduler_payload: card.progress.scheduler_payload,
      needs_recheck: card.progress.needs_recheck,
      word: card.word,
      lastRating: card.progress.last_rating,
      l1WeakSignal: card.progress.l1_weak_signal,
    };
  }

  /**
   * Get drill candidates for the cram 练习变体 (cloze/definition).
   * Pure read: resolves a cloze from each candidate's examples and filters
   * out words with no redactable sentence. No scheduling side-effects.
   */
  async getDrillCandidates(userId: string, wordbookId: string, limit = 20): Promise<DrillCard[]> {
    if (!this.deps.findDrillCandidates) {
      throw new Error("findDrillCandidates not configured");
    }
    const rows = await this.deps.findDrillCandidates(userId, wordbookId, limit);
    const items: DrillCard[] = [];
    for (const row of rows) {
      const cloze = findClozeFromExamples(
        row.word.examples as Array<{ text?: string | null }> | null,
        row.word.lemma,
      );
      if (!cloze) continue;
      items.push({
        progressId: row.progress.id,
        wordId: row.word.id,
        lemma: row.word.lemma,
        title: row.word.title,
        slug: row.word.slug,
        shortDefinition: row.word.short_definition,
        state: row.progress.state,
        clozeText: cloze.text,
        clozeLength: cloze.matchedLength,
        clozeSource: cloze.source,
      });
    }
    return items;
  }

  async getStats(userId: string, wordbookId: string) {
    if (!this.deps.getReviewStats) throw new Error("getReviewStats not configured");
    return this.deps.getReviewStats(userId, wordbookId);
  }

  async getLeeches(userId: string, wordbookId: string, limit = 20) {
    if (!this.deps.findLeeches) throw new Error("findLeeches not configured");
    const rows = await this.deps.findLeeches(userId, wordbookId, limit);
    return rows.map((r) => {
      const { slug, title, lemma, w_id, short_definition, ...progress } = r;
      return {
        progressId: progress.id,
        word: { id: w_id, slug, title, lemma, short_definition },
        lapseCount: progress.lapse_count,
        state: progress.state,
        dueAt: progress.due_at,
      };
    });
  }

  async getTimeline(userId: string, wordbookId: string, limit = 50) {
    if (!this.deps.getTimeline) throw new Error("getTimeline not configured");
    return this.deps.getTimeline(userId, wordbookId, limit);
  }

  async getHeatmap(userId: string, wordbookId: string, days = 365) {
    if (!this.deps.getHeatmap) throw new Error("getHeatmap not configured");
    return this.deps.getHeatmap(userId, wordbookId, days);
  }

  /**
   * Submit a review answer. Runs in a single transaction.
   * H1 fix: uses createRepositories(tx) so all queries share the tx connection.
   */
  async submitAnswer(input: SubmitAnswerInput, userId: string): Promise<SubmitAnswerResult> {
    // P0: cram is a no-persistence self-test (original v1 Drill semantics).
    // It must NOT write review_logs or scheduler_payload — the rating is
    // purely for in-session feedback. Return a synthetic result, mirroring
    // the original "free" mode's synthetic reviewLogId.
    if (input.mode === "cram") {
      return {
        ok: true,
        reviewLogId: `cram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nextDueAt: new Date().toISOString(),
        state: "practice",
      };
    }

    const transactionResult = await withTransaction(async (tx) => {
      // H1 fix: create repos bound to this transaction connection
      const repos = createRepositories(tx);

      // 1. Idempotency check (advisory lock + duplicate detection)
      if (input.idempotencyKey) {
        const existingLogId = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
        if (existingLogId) {
          return {
            result: { ok: true, idempotent: true, reviewLogId: existingLogId } as SubmitAnswerResult,
          };
        }
      }

      // 2. Lock progress row (SELECT FOR UPDATE with word join)
      const progress = await repos.reviews.findProgressForUpdate(input.progressId, userId);
      if (!progress) {
        throw new NotFoundError("Progress", input.progressId);
      }

      // 3. Bind the untrusted sessionId to the authenticated actor and progress wordbook.
      await repos.sessions.assertActiveOwned(input.sessionId, userId, progress.wordbook_id);

      // 4. Domain validation using real word data (M7 fix)
      const card = new ReviewCardEntity(
        progress as unknown as UserWordProgressRow,
        {
          id: progress.word_id,
          slug: progress.word_slug,
          title: progress.word_title,
          lemma: progress.word_lemma,
        },
      );
      if (card.isSuspended) {
        throw new BusinessRuleError("Cannot answer a suspended card");
      }

      // 4. Load FSRS weights (non-critical)
      let weights: number[] | null = null;
      try {
        weights = await this.deps.loadWeights(progress.wordbook_id);
      } catch {
        // Fall back to default weights
      }

      // 5. FSRS scheduling computation
      const scheduling = this.deps.fsrsAdapter(
        progress.scheduler_payload,
        input.rating,
        new Date(),
        progress.desired_retention,
        weights,
      );

      // 6. Build previous snapshot for undo
      const previousSnapshot = this.buildPreviousSnapshot(progress);
      const logMetadata: Record<string, unknown> = {
        desired_retention: progress.desired_retention,
        progress_id: progress.id,
        retrievability: scheduling.retrievability,
      };

      // 7. Persist (UPDATE progress + INSERT review_log in same tx)
      const result = await repos.reviews.saveAnswer({
        progressId: input.progressId,
        userId,
        wordId: progress.word_id,
        wordbookId: progress.wordbook_id,
        sessionId: input.sessionId,
        rating: input.rating,
        contentHash: progress.content_hash,  // M-NEW-4: refresh snapshot
        scheduling,
        idempotencyKey: input.idempotencyKey ?? null,
        previousSnapshot,
        logMetadata,
      });

      const eventPayload = buildReviewAnswerRecordedPayload({
        version: 1,
        reviewLogId: result.reviewLogId,
        progressId: input.progressId,
        sessionId: input.sessionId,
        userId,
        wordbookId: progress.wordbook_id,
        wordId: progress.word_id,
        track: "l1",
      });
      await repos.outbox.enqueue({
        aggregateType: "review_log",
        aggregateId: result.reviewLogId,
        eventType: REVIEW_ANSWER_RECORDED,
        payload: asJson(eventPayload),
        dedupeKey: reviewOutboxDedupeKey(result.reviewLogId),
      });

      return {
        result: {
          ok: true,
          reviewLogId: result.reviewLogId,
          nextDueAt: scheduling.dueAt,
          state: scheduling.state,
        } as SubmitAnswerResult,
      };
    }, { actorId: userId });

    return transactionResult.result;
  }

  /**
   * Enqueue a single word as a brand-new L1 card. One transaction.
   * Duplicate (user, word, wordbook) raises ConflictError (409).
   */
  async enqueueCard(input: EnqueueCardInput, userId: string): Promise<EnqueueCardResult> {
    const transactionResult = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      const outcome = await repos.reviews.insertNewCard({
        userId,
        wordId: input.wordId,
        wordbookId: input.wordbookId,
        desiredRetention: L1_DEFAULT_DESIRED_RETENTION,
      });
      if (outcome.status === "word_not_found") {
        throw new NotFoundError("Word", input.wordId);
      }
      if (outcome.status === "wordbook_invalid") {
        throw new NotFoundError("Wordbook", input.wordbookId);
      }
      if (outcome.status === "duplicate" || !outcome.progressId) {
        throw new ConflictError("Word is already in the review queue for this wordbook");
      }
      await repos.outbox.enqueue({
        aggregateType: "user_word_progress",
        aggregateId: outcome.progressId,
        eventType: REVIEW_CARD_ENQUEUED,
        payload: enqueuePayloadAsJson(
          buildReviewCardEnqueuedPayload({
            version: 1,
            progressId: outcome.progressId,
            userId,
            wordbookId: input.wordbookId,
            wordId: input.wordId,
          }),
        ),
        dedupeKey: reviewCardEnqueuedDedupeKey(outcome.progressId),
      });
      return {
        result: { ok: true, progressId: outcome.progressId } as EnqueueCardResult,
      };
    }, { actorId: userId });

    return transactionResult.result;
  }

  /**
   * Enqueue multiple words as new L1 cards in one transaction.
   * Duplicates are counted as skipped; any unknown word or unowned wordbook
   * aborts the whole batch with NotFoundError (all-or-nothing).
   */
  async enqueueCards(input: EnqueueCardsInput, userId: string): Promise<EnqueueCardsResult> {
    if (input.wordIds.length === 0) {
      throw new BusinessRuleError("wordIds must not be empty");
    }

    const transactionResult = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      const progressIds: string[] = [];
      let skipped = 0;
      let missingWordId: string | null = null;
      let invalidWordbook = false;

      for (const wordId of input.wordIds) {
        const outcome = await repos.reviews.insertNewCard({
          userId,
          wordId,
          wordbookId: input.wordbookId,
          desiredRetention: L1_DEFAULT_DESIRED_RETENTION,
        });
        if (outcome.status === "inserted" && outcome.progressId) {
          progressIds.push(outcome.progressId);
          await repos.outbox.enqueue({
            aggregateType: "user_word_progress",
            aggregateId: outcome.progressId,
            eventType: REVIEW_CARD_ENQUEUED,
            payload: enqueuePayloadAsJson(
              buildReviewCardEnqueuedPayload({
                version: 1,
                progressId: outcome.progressId,
                userId,
                wordbookId: input.wordbookId,
                wordId,
              }),
            ),
            dedupeKey: reviewCardEnqueuedDedupeKey(outcome.progressId),
          });
        } else if (outcome.status === "duplicate") {
          skipped += 1;
        } else if (outcome.status === "word_not_found") {
          missingWordId ??= wordId;
        } else {
          invalidWordbook = true;
        }
      }

      if (missingWordId) throw new NotFoundError("Word", missingWordId);
      if (invalidWordbook) throw new NotFoundError("Wordbook", input.wordbookId);

      return {
        result: { ok: true, added: progressIds.length, skipped, progressIds } as EnqueueCardsResult,
      };
    }, { actorId: userId });

    return transactionResult.result;
  }

  /**
   * Build the previous-state snapshot for undo support.
   * Captures all FSRS-relevant fields before they're overwritten by saveAnswer.
   */
  private buildPreviousSnapshot(progress: ProgressWithContentHash): Json {
    return {
      scheduler_payload: progress.scheduler_payload,
      difficulty: progress.difficulty,
      due_at: progress.due_at,
      interval_days: progress.interval_days,
      lapse_count: progress.lapse_count,
      last_rating: progress.last_rating,
      last_reviewed_at: progress.last_reviewed_at,
      retrievability: progress.retrievability,
      review_count: progress.review_count,
      stability: progress.stability,
      state: progress.state,
      again_count: progress.again_count,
      hard_count: progress.hard_count,
      good_count: progress.good_count,
      easy_count: progress.easy_count,
      content_hash_snapshot: progress.content_hash_snapshot,
      l1_content_hash_snapshot: progress.l1_content_hash_snapshot,
      recent_ratings: progress.recent_ratings,
      l1_weak_signal: progress.l1_weak_signal,
    } as Json;
  }

  /**
   * Skip a review card. Runs in a single transaction.
   */
  async skip(input: SkipReviewInput, userId: string): Promise<{ ok: boolean; idempotent?: boolean }> {
    return withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      if (input.idempotencyKey) {
        const existing = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
        if (existing) {
          return { ok: true, idempotent: true };
        }
      }

      const progress = await repos.reviews.findProgressForSkip(input.progressId, userId);
      if (!progress) {
        throw new NotFoundError("Progress", input.progressId);
      }

      await repos.sessions.assertActiveOwned(input.sessionId, userId, progress.wordbook_id);

      await repos.reviews.skipCard(
        progress,
        userId,
        input.sessionId,
        input.idempotencyKey ?? null,
      );

      return { ok: true };
    }, { actorId: userId });
  }

  /**
   * Suspend a review card. Runs in a single transaction.
   */
  async suspend(input: SuspendReviewInput, userId: string): Promise<{ ok: boolean; idempotent?: boolean }> {
    return withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      if (input.idempotencyKey) {
        const existing = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
        if (existing) {
          return { ok: true, idempotent: true };
        }
      }

      const progress = await repos.reviews.findProgressForSuspend(input.progressId, userId);
      if (!progress) {
        throw new NotFoundError("Progress", input.progressId);
      }

      if (input.sessionId) {
        await repos.sessions.assertActiveOwned(input.sessionId, userId, progress.wordbook_id);
      }

      await repos.reviews.suspendCard(
        progress,
        userId,
        input.sessionId ?? null,
        input.idempotencyKey ?? null,
      );

      return { ok: true };
    }, { actorId: userId });
  }

  /**
   * Undo the last review log. Runs in a single transaction.
   */
  async undo(input: UndoReviewInput, userId: string): Promise<{ ok: boolean; idempotent?: boolean }> {
    return withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      if (input.idempotencyKey) {
        const existing = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
        if (existing) {
          return { ok: true, idempotent: true };
        }
      }

      const wordbookId = await repos.reviews.findReviewLogWordbookForUndo(input.reviewLogId, userId);
      if (!wordbookId) {
        throw new NotFoundError("ReviewLog", input.reviewLogId);
      }
      await repos.sessions.assertActiveOwned(input.sessionId, userId, wordbookId);

      const result = await repos.reviews.undoReviewLog(
        input.reviewLogId,
        userId,
        wordbookId,
        input.sessionId,
        input.idempotencyKey ?? null,
      );

      if (!result.success) {
        throw new BusinessRuleError(result.errorMessage ?? "Undo failed");
      }

      return { ok: true };
    }, { actorId: userId });
  }

  /**
   * Clear the L1 weak-signal flag for a single progress row (P1-4).
   *
   * Phase 2C decision-2: markL1WeakSignal only *marks* — it never re-cards
   * or touches due_at/needs_recheck. The user decides whether to re-grind
   * L1 after seeing the flag in the UI. This endpoint lets the user manually
   * dismiss the flag once they've acknowledged it (e.g. after re-reviewing
   * the word or deciding it's a false positive).
   */
  async clearL1WeakSignal(input: ClearL1WeakSignalInput, userId: string): Promise<{ ok: boolean }> {
    if (!this.deps.clearL1WeakSignal) {
      throw new Error("clearL1WeakSignal dependency not configured");
    }
    const updated = await this.deps.clearL1WeakSignal(userId, input.wordbookId, input.wordId);
    if (updated === 0) {
      throw new NotFoundError("WordProgress", input.wordId);
    }
    return { ok: true };
  }
}
