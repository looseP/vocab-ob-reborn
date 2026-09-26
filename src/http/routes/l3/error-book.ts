/**
 * 错题库统一投影路由（2026-09-26）—— `GET /api/l3/error-book`。
 *
 * 与 `routes/l3-practice.ts` 的 `/error-book`（句级单腿）并存：后者进入退役
 * 窗口（DEPRECATED(句级错题)，见 schemas/http/index.ts 注释）。本端点是错题库
 * 的**唯一口径入口**：句级 wrong + 题级 wrong/partial 合并，消费方按 `kind` 分区。
 *
 * 薄路由：不做归属判断以外的业务；越权/枚举错误由 service 转 422，
 * 契约由 operations 注册表中间件按 l3UnifiedErrorBookResponseSchema 校验。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3ErrorBookQuerySchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function errorBookRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/error-book", async (c) => {
    const parsed = l3ErrorBookQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    return c.json(await services.l3ErrorBook.list({
      userId: c.get("userId"),
      kind: parsed.data.kind ?? null,
      space: parsed.data.space ?? null,
      direction: parsed.data.direction ?? null,
      limit: parsed.data.limit ?? null,
      offset: parsed.data.offset ?? null,
    }));
  });

  return app;
}
