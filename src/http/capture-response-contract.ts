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
  /**
   * L3 capture-first landed 2026-09-07 (grill decision, superseding the
   * 2026-08-22 gate): when a `sentence` is supplied the trio
   * (l3_sources / l3_contexts / l3_occurrences) is written in the same
   * transaction, so the runtime reports "captured". "deferred" remains
   * reachable when no sentence is supplied or the best-effort trio write
   * falls back. Hence a two-value enum rather than a frozen literal.
   */
  l3Status: z.enum(["captured", "deferred"]),
  sourceId: z.string().uuid().nullable(),
  contextId: z.string().uuid().nullable(),
  occurrenceId: z.string().uuid().nullable(),
}).strict();
