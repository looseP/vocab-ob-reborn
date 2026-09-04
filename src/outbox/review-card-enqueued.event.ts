import { z } from "zod";
import type { Json } from "../domain";

export const REVIEW_CARD_ENQUEUED = "review.card.enqueued.v1" as const;

export const reviewCardEnqueuedPayloadSchema = z.object({
  version: z.literal(1),
  progressId: z.string().uuid(),
  userId: z.string().uuid(),
  wordbookId: z.string().uuid(),
  wordId: z.string().uuid(),
});

export type ReviewCardEnqueuedPayload = z.infer<typeof reviewCardEnqueuedPayloadSchema>;

export function buildReviewCardEnqueuedPayload(input: ReviewCardEnqueuedPayload): ReviewCardEnqueuedPayload {
  return input;
}

export function reviewCardEnqueuedDedupeKey(progressId: string): string {
  return `${REVIEW_CARD_ENQUEUED}:${progressId}`;
}

export function enqueuePayloadAsJson(payload: ReviewCardEnqueuedPayload): Json {
  return payload as unknown as Json;
}
