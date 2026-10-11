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
  /**
   * 入本即记流水（设计稿 2026-10-11 §4.1）：捕获成功后 best-effort 追加的当日
   * 流水条目 seq；追加失败为 null —— 记流水不阻塞入本（与 L3 三件套同哲学）。
   * optional + nullable 保持非 breaking（openapi 下为纯增 property）。
   */
  entrySeq: z.number().int().min(1).nullable().optional(),
  sourceId: z.string().uuid().nullable(),
  contextId: z.string().uuid().nullable(),
  occurrenceId: z.string().uuid().nullable(),
}).strict();
