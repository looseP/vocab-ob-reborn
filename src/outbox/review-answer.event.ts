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
  /**
   * 加性演进（l2-drill spec §七，v1 兼容）：'l1' 事件走原有效应链，
   * 'l2' 事件走 l2_weak_signal 且不递增 cards_seen。
   * 存量事件无此字段 → 解析时缺省 'l1'。
   */
  track: z.enum(["l1", "l2"]).optional().default("l1"),
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
