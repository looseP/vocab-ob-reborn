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
import {
  REVIEW_ANSWER_RECORDED,
  asJson,
  buildReviewAnswerRecordedPayload,
  reviewOutboxDedupeKey,
} from "../outbox/review-answer.event";

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
    });

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
