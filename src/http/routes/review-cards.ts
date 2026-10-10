/**
 * 复习队列编辑（P1，2026-10-10）—— 独立薄路由文件，`server.ts` 直挂 `/api/review`。
 *
 * 为什么不塞进 `review.ts`：该文件受**路由棘轮**按基线冻结（行数也不许净增），
 * 仓库既有惯例是「新端点另立薄文件」（同 `review-calendar.ts`、`review-l3-contexts.ts`、
 * `l3/capabilities.ts` 先例）。
 *
 * 两条写端点（owner-only，sessionMutation；与 enqueue 系列同授权口径）：
 *  - `POST /cards/remove` —— 移出复习队列（物理删行 + `card_removed` 审计；幂等）。
 *  - `POST /cards/expire` —— 提前到期（候选池排序获得优先位置；只提前、从不延后）。
 *
 * 单卡是批量的特例（`wordIds: [id]`），不另设单数端点。`wordbookId` 缺省回退
 * 默认词书（与 `review.ts` 的 cards 端点同款）；body 复用 `batchAddToReviewSchema`
 * （wordIds 1..100 + wordbookId 可选）。
 */
import { Hono } from "hono";
import type { Services } from "../../services";
import type { AppEnv } from "./words";
import { batchAddToReviewSchema } from "../../schemas/http";
import { validationError } from "../error-response";

export function reviewCardsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  const resolveWordbookId = async (userId: string, requested: string | undefined) =>
    requested ?? (await services.wordbooks.getOrCreateDefault(userId)).id;

  // POST /cards/remove —— 移出复习队列（删除进度行 + 审计；未命中零行）
  app.post("/cards/remove", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = batchAddToReviewSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = await resolveWordbookId(userId, parsed.data.wordbookId);
    const result = await services.reviewCards.removeCards({
      userId,
      wordbookId,
      wordIds: parsed.data.wordIds,
    });
    return c.json(result);
  });

  // POST /cards/expire —— 提前到期（只提前从不延后；挂起词不动）
  app.post("/cards/expire", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = batchAddToReviewSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = await resolveWordbookId(userId, parsed.data.wordbookId);
    const result = await services.reviewCards.expireCards({
      userId,
      wordbookId,
      wordIds: parsed.data.wordIds,
    });
    return c.json(result);
  });

  return app;
}
