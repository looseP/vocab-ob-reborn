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
} from "../errors";
import type { Json, ReviewRating, ReviewState, UserWordProgressRow } from "../domain";
import type { ProgressWithContentHash } from "../repositories/interfaces";
import { logger } from "../observability/logger";

/**
 * Snapshot of L1 progress handed to the L2 transition check.
 * Matches L2TransitionService.checkAndTransition's L1ProgressSnapshot.
 * wordbook_id is mandatory: L2 progress is wordbook-scoped in V2.
 */
export interface ReviewL1Snapshot {
  user_id: string;
  wordbook_id: string;
  word_id: string;
  stability: number | string;
  difficulty: number | string | null;
  review_count: number;
  last_rating: string | null;
}

/**
 * Post-save L1 snapshot handed to the L1→L2 cross-track cascade (Phase 2C).
 * `recent_ratings` is the array AFTER the just-submitted rating was appended
 * and sliced to the last 5 — i.e. exactly what saveAnswer persists. The
 * cascade reads the trailing window to decide pause vs. resume.
 */
export interface ReviewL1CascadeSnapshot {
  user_id: string;
  wordbook_id: string;
  word_id: string;
  recent_ratings: ReviewRating[];
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
  /** Increment the owner/wordbook-scoped session counter after L1 commit. */
  incrementSessionCardsSeen?: (sessionId: string, userId: string, wordbookId: string) => Promise<void>;
  /**
   * Optional L2 transition hook. When provided, submitAnswer calls it after
   * persisting the L1 answer so an L2 progress row can be promoted.
   * Failures are logged but never roll back the L1 transaction — L2 is a
   * best-effort second-pass loop and must not endanger L1 durability.
   */
  checkAndTransition?: (progress: ReviewL1Snapshot) => Promise<void>;
  /**
   * Optional L1→L2 cross-track cascade hook (Phase 2C). When provided,
   * submitAnswer calls it after the L2 transition check with the post-save
   * recent_ratings so L2 progress can be paused (L1 collapsing: last 2
   * again) or resumed (L1 recovering: last 2 good/easy, cascade reason only).
   * Best-effort: failures are logged and never roll back L1.
   */
  checkL1Cascade?: (snapshot: ReviewL1CascadeSnapshot) => Promise<void>;
}

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /**
   * Submit a review answer. Runs in a single transaction.
   * H1 fix: uses createRepositories(tx) so all queries share the tx connection.
   */
  async submitAnswer(input: SubmitAnswerInput, userId: string): Promise<SubmitAnswerResult> {
    const transactionResult = await withTransaction(async (tx) => {
      // H1 fix: create repos bound to this transaction connection
      const repos = createRepositories(tx);

      // 1. Idempotency check (advisory lock + duplicate detection)
      if (input.idempotencyKey) {
        const existingLogId = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
        if (existingLogId) {
          return {
            result: { ok: true, idempotent: true, reviewLogId: existingLogId } as SubmitAnswerResult,
            postCommit: null,
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

      return {
        result: {
          ok: true,
          reviewLogId: result.reviewLogId,
          nextDueAt: scheduling.dueAt,
          state: scheduling.state,
        } as SubmitAnswerResult,
        postCommit: { progress, scheduling, rating: input.rating, sessionId: input.sessionId, userId },
      };
    });

    // These writes intentionally start only after withTransaction has committed
    // the authoritative L1 answer. Each is best-effort and uses dependencies
    // backed by the global pool rather than the completed transaction client.
    if (transactionResult.postCommit) {
      const { progress, scheduling, rating, sessionId, userId: actorId } = transactionResult.postCommit;
      await this.tryL2Transition(progress, scheduling, rating);
      await this.tryL1Cascade(progress, rating);
      await this.tryIncrementSession(sessionId, actorId, progress.wordbook_id);
    }

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
   * Best-effort L2 transition check. Fire-and-forget — failures are logged
   * but never roll back the L1 transaction. The snapshot reflects
   * post-saveAnswer state: stability/difficulty from FSRS scheduling,
   * review_count +1, last_rating is the rating just submitted.
   */
  private async tryL2Transition(
    progress: ProgressWithContentHash,
    scheduling: FsrsScheduling,
    rating: ReviewRating,
  ): Promise<void> {
    if (!this.deps.checkAndTransition) return;
    try {
      await this.deps.checkAndTransition({
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        // scheduling.stability/difficulty may be null (e.g. for a card that
        // has no FSRS history yet). Coerce to 0 / null — L2TransitionService
        // requires stability ≥ 21, so 0 simply means "no transition".
        stability: scheduling.stability ?? 0,
        difficulty: scheduling.difficulty,
        review_count: progress.review_count + 1,
        last_rating: rating,
      });
    } catch (err) {
      logger.warn("review", "L2 transition failed", {
        userId: progress.user_id,
        wordId: progress.word_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Best-effort L1→L2 cross-track cascade (Phase 2C). Computes the post-save
   * recent_ratings (pre-save array + the rating just submitted, sliced to the
   * last 5 — exactly mirroring saveAnswer's SQL) and hands it to the injected
   * checkL1Cascade hook. Failures are logged but never roll back L1.
   *
   * The array is computed in-app rather than re-queried so the cascade runs
   * outside the L1 transaction without a second round-trip and stays
   * decoupled from the saveAnswer SQL internals.
   */
  private async tryL1Cascade(
    progress: ProgressWithContentHash,
    rating: ReviewRating,
  ): Promise<void> {
    if (!this.deps.checkL1Cascade) return;
    try {
      const postSaveRatings = [...(progress.recent_ratings ?? []), rating].slice(-5);
      await this.deps.checkL1Cascade({
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        recent_ratings: postSaveRatings,
      });
    } catch (err) {
      logger.warn("review", "L1→L2 cascade failed", {
        userId: progress.user_id,
        wordId: progress.word_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Best-effort session counter increment on an independent connection.
   * It runs only after the L1 transaction commits, so a SQL error cannot leave
   * that transaction aborted or make the committed answer look unsuccessful.
   */
  private async tryIncrementSession(sessionId: string, userId: string, wordbookId: string): Promise<void> {
    if (!this.deps.incrementSessionCardsSeen) return;
    try {
      await this.deps.incrementSessionCardsSeen(sessionId, userId, wordbookId);
    } catch (err) {
      logger.warn("review", "Session counter increment failed", {
        sessionId,
        userId,
        wordbookId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    });
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
    });
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
    });
  }
}
