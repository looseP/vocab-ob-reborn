import { z } from "zod";

/**
 * 复习队列全景（P1，2026-10-10）响应契约。
 *
 * 此前用户**没有任何入口能看到「队列里到底有哪些词」**——只有仪表盘的数字、
 * 集合页的计数、以及复习日历未来侧按天点开。本端点补上这块：一次给出
 * 桶计数（可分 tab 展示）+ 当前桶/搜索下的分页清单。
 *
 * 桶互斥且完备（suspended → new → learning → due → review），见
 * `ReviewRepository.countQueueBuckets` 的 JSDoc。
 * - `counts.dueNow`：非挂起、非新卡、已到期的张数（= learning + due），即「现在就该复习」。
 * - `counts.total`：词书内全部进度行（含挂起）。
 * - `total`/`limit`/`offset`/`hasMore`：清单自身的分页信息（`total` 是**过滤后**的行数）。
 */
const queueListStateSchema = z.enum(["new", "learning", "review", "relearning", "suspended"]);

export const reviewQueueListResponseSchema = z
  .object({
    counts: z
      .object({
        due: z.number().int().nonnegative(),
        learning: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        new: z.number().int().nonnegative(),
        suspended: z.number().int().nonnegative(),
        dueNow: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            wordId: z.string(),
            slug: z.string(),
            title: z.string(),
            lemma: z.string(),
            shortDefinition: z.string().nullable(),
            pos: z.string().nullable(),
            cefr: z.string().nullable(),
            state: queueListStateSchema,
            dueAt: z.string().nullable(),
            reviewCount: z.number().int().nonnegative(),
            lapseCount: z.number().int().nonnegative(),
            stability: z.number().nullable(),
            intervalDays: z.number().nullable(),
            lastReviewedAt: z.string().nullable(),
            lastRating: z.enum(["again", "hard", "good", "easy"]).nullable(),
            /** ADR-0021 读时派生的「内容已更新，需重看」。 */
            needsRecheck: z.boolean(),
          })
          .strict(),
      ),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();
