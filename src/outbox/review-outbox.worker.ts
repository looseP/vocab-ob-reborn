import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/transaction";
import { logger } from "../observability/logger";
import { createRepositories } from "../repositories/factory";
import type { IOutboxRepository, OutboxEventRow } from "../repositories/interfaces";
import { OutboxRepository } from "../repositories/outbox.repository";
import { CrossTrackService } from "../services/cross-track.service";
import { L2TransitionService } from "../services/l2-transition.service";
import {
  REVIEW_ANSWER_RECORDED,
  reviewAnswerRecordedPayloadSchema,
  type ReviewAnswerRecordedPayload,
} from "./review-answer.event";

export interface ReviewOutboxWorkerOptions {
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxRetryDelaySeconds?: number;
}

export class ReviewOutboxWorker {
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly maxRetryDelaySeconds: number;

  constructor(
    private readonly outbox: IOutboxRepository = new OutboxRepository(),
    options: ReviewOutboxWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `review-outbox-${randomUUID()}`;
    this.batchSize = options.batchSize ?? 20;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.maxRetryDelaySeconds = options.maxRetryDelaySeconds ?? 900;
  }

  async processBatch(shouldContinue: () => boolean = () => true): Promise<number> {
    if (!shouldContinue()) return 0;
    const recovered = await this.outbox.recoverExpiredLeases();
    if (recovered > 0) {
      logger.warn("review-outbox", "Recovered expired worker leases", { recovered });
    }

    let processed = 0;
    while (processed < this.batchSize && shouldContinue()) {
      const [event] = await this.outbox.claimBatch(this.workerId, 1, this.leaseSeconds);
      if (!event) break;
      await this.processClaimedEvent(event);
      processed += 1;
    }
    return processed;
  }

  private async processClaimedEvent(event: OutboxEventRow): Promise<void> {
    try {
      if (event.event_type !== REVIEW_ANSWER_RECORDED) {
        throw new Error(`Unsupported outbox event type: ${event.event_type}`);
      }
      const payload = reviewAnswerRecordedPayloadSchema.parse(event.payload);
      await this.applyReviewAnswerEffects(event.id, payload);
      logger.info("review-outbox", "Processed review outbox event", {
        eventId: event.id,
        attempts: event.attempts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryDelaySeconds = this.retryDelaySeconds(event.attempts);
      const status = await this.outbox.markFailed(event.id, this.workerId, message, retryDelaySeconds);
      const meta = { eventId: event.id, attempts: event.attempts, status, error: message };
      if (status === "dead_letter") {
        logger.error("review-outbox", "Review outbox event moved to dead letter", meta);
      } else {
        logger.warn("review-outbox", "Review outbox event scheduled for retry", {
          ...meta,
          retryDelaySeconds,
        });
      }
    }
  }

  private async applyReviewAnswerEffects(eventId: string, payload: ReviewAnswerRecordedPayload): Promise<void> {
    await withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      const progress = await repos.reviews.findProgressForOutbox(
        payload.progressId,
        payload.userId,
        payload.wordbookId,
      );
      if (!progress || progress.word_id !== payload.wordId) {
        throw new Error(`Authoritative review progress not found for outbox event ${eventId}`);
      }
      const transition = {
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        stability: progress.stability ?? 0,
        difficulty: progress.difficulty,
        review_count: progress.review_count,
        last_rating: progress.last_rating,
      };
      const cascade = {
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        recent_ratings: progress.recent_ratings ?? [],
      };
      const l2Transition = new L2TransitionService(repos.l2Progress);
      const crossTrack = new CrossTrackService(repos.l2Progress, repos.reviews);

      if (await repos.outbox.beginEffect(eventId, "l2_transition", this.workerId)) {
        await l2Transition.checkAndTransition(transition);
        await repos.outbox.completeEffect(eventId, "l2_transition");
      }
      if (await repos.outbox.beginEffect(eventId, "l1_cascade", this.workerId)) {
        await crossTrack.checkL1Cascade(cascade);
        await repos.outbox.completeEffect(eventId, "l1_cascade");
      }
      if (await repos.outbox.beginEffect(eventId, "session_cards_seen", this.workerId)) {
        await repos.sessions.incrementCardsSeenFromOutbox(payload.sessionId, payload.userId, payload.wordbookId);
        await repos.outbox.completeEffect(eventId, "session_cards_seen");
      }
      await repos.outbox.markProcessed(eventId, this.workerId);
    });
  }

  private retryDelaySeconds(attempts: number): number {
    return Math.min(2 ** Math.max(0, attempts - 1), this.maxRetryDelaySeconds);
  }
}
