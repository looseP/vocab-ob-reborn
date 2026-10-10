import { z } from "zod";

/**
 * 复习队列编辑（P1，2026-10-10）响应契约：移出 / 提前到期共用一个形状。
 *
 * `count` = **实际生效行数**（remove：被删行数；expire：被提前的行数——已到期的词
 * 不在此内）；`wordIds` = 实际生效的 id（未命中/无需变更的 id 不返回）——两个端点
 * 都因此天然幂等，重复调用收敛到零行。
 */
export const reviewCardsMutationResponseSchema = z.object({
  ok: z.literal(true),
  count: z.number().int().nonnegative(),
  wordIds: z.array(z.string()),
}).strict();
