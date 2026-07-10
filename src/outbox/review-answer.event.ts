import { z } from "zod";
import type { Json } from "../domain";

export const REVIEW_ANSWER_RECORDED = "review.answer.recorded.v1" as const;

export const reviewAnswerRecordedPayloadSchema = z.object({
  version: z.literal(1),
  reviewLogId: z.string().uuid(),
  progressId: z.string().uuid(),
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  wordbookId: z.string().uuid(),
  wordId: z.string().uuid(),
});

export type ReviewAnswerRecordedPayload = z.infer<typeof reviewAnswerRecordedPayloadSchema>;

export function buildReviewAnswerRecordedPayload(input: ReviewAnswerRecordedPayload): ReviewAnswerRecordedPayload {
  return input;
}

export function reviewOutboxDedupeKey(reviewLogId: string): string {
  return `${REVIEW_ANSWER_RECORDED}:${reviewLogId}`;
}

export function asJson(payload: ReviewAnswerRecordedPayload): Json {
  return payload as unknown as Json;
}
