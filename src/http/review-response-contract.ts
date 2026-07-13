import { z } from "zod";

const reviewStateSchema = z.enum([
  "new",
  "learning",
  "review",
  "relearning",
]);

export const reviewAnswerResponseSchema = z.object({
  ok: z.literal(true),
  idempotent: z.literal(true).optional(),
  reviewLogId: z.string().uuid(),
  nextDueAt: z.iso.datetime({ offset: true }).optional(),
  state: reviewStateSchema.optional(),
}).strict();

export const reviewSimpleResponseSchema = z.object({
  ok: z.literal(true),
  idempotent: z.literal(true).optional(),
}).strict();
