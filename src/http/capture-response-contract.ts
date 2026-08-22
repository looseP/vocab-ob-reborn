import { z } from "zod";

export const captureResponseSchema = z.object({
  ok: z.literal(true),
  existed: z.boolean(),
  word: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    lemma: z.string(),
    shortDefinition: z.string().nullable(),
  }).strict(),
  noteContentMd: z.string().nullable(),
  /** Fixed to "deferred" until L3 capture ships (product decision 2026-08-22). */
  l3Status: z.literal("deferred"),
  sourceId: z.string().uuid().nullable(),
  contextId: z.string().uuid().nullable(),
  occurrenceId: z.string().uuid().nullable(),
}).strict();
