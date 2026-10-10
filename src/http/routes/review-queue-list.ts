/**
 * 复习队列全景（P1，2026-10-10）—— 独立薄路由文件，`server.ts` 直挂 `/api/review`。
 *
 * 为什么不塞进 `review.ts` / `review-cards.ts`：前者受**路由棘轮**按基线冻结（行数也
 * 不许净增），后者是写面（owner-only）。本端点是**读面**（owner 可读、agent 可读，
 * 与 `getReviewQueue` 同授权口径），另立文件符合仓库既有惯例。
 *
 * `GET /queue/list?bucket=&q=&limit=&offset=` —— 桶计数 + 分页清单。
 * 分桶与搜索都由 zod 先收敛（`reviewQueueListQuerySchema`），仓储层只按白名单挑 SQL
 * 谓词，用户输入永不进 SQL。`wordbookId` 缺省回退默认词书（与 cards 系列同款）。
 */
import { Hono } from "hono";
import type { Services } from "../../services";
import type { AppEnv } from "./words";
import { reviewQueueListQuerySchema } from "../../schemas/http";
import { validationError } from "../error-response";

export function reviewQueueListRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /queue/list —— 队列清单（到期/学习中/新卡/挂起 四个互斥桶 + 全量）
  app.get("/queue/list", async (c) => {
    const parsed = reviewQueueListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId =
      parsed.data.wordbookId ?? (await services.wordbooks.getOrCreateDefault(userId)).id;
    return c.json(
      await services.reviewCards.listQueue({
        userId,
        wordbookId,
        bucket: parsed.data.bucket,
        search: parsed.data.q ?? null,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      }),
    );
  });

  return app;
}
