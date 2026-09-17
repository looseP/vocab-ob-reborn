/**
 * Upgrade work order HTTP routes (ADR-0018) — 用户主动提前升级（升级工单）.
 *
 * Mounted at /api/upgrade-work-orders by http/server.ts（独立薄路由，不受既有
 * 路由文件复杂度棘轮约束）。HTTP 保持薄层：解析 body/query、附加 auth userId、
 * 只调用 service；service 抛出的 NotFound/BusinessRule 由全局 onError 统一映射。
 *
 * mark/list 的 wordbookId 要求显式传入（不像 /cards 回退默认词书）：
 * 工单归属错书是脏写。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import {
  upgradeWorkOrderCreateSchema,
  upgradeWorkOrderListQuerySchema,
} from "@/schemas/http";
import { validationError } from "../error-response";
import { invalidIdResponse, parseRouteUuid } from "./l3/shared";

export function upgradeWorkOrdersRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST / — 标记升级：写工单 + 采集三档建议快照（零 FSRS 写入）。
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = upgradeWorkOrderCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.upgradeWorkOrders.mark(
      c.get("userId"),
      parsed.data.wordbookId,
      parsed.data.wordId,
      parsed.data.direction,
    );
    return c.json(result, 201);
  });

  // GET / — 待升级清单（wordbookId 必填，limit 可选）。
  // 响应 item = 行字段 + `word`（词面）+ `suggestion`（档位）；
  // 契约见 upgrade-work-order-response-contract.ts（只扩 list，不动行契约）。
  app.get("/", async (c) => {
    const parsed = upgradeWorkOrderListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const items = await services.upgradeWorkOrders.list(
      c.get("userId"),
      parsed.data.wordbookId,
      parsed.data.limit,
    );
    return c.json({
      items: items.map((item) => {
        const { wordSlug, wordText, suggestion, ...workOrder } = item;
        return { ...workOrder, word: { slug: wordSlug, text: wordText }, suggestion };
      }),
    });
  });

  // POST /:id/start — 标记中 → 升级中（幂等）。
  app.post("/:id/start", async (c) => {
    const workOrderId = parseRouteUuid(c.req.param("id"));
    if (!workOrderId) return invalidIdResponse(c);
    const result = await services.upgradeWorkOrders.start(c.get("userId"), workOrderId);
    return c.json(result);
  });

  // POST /:id/cancel — 任意进行中态 → 已取消（幂等）。
  app.post("/:id/cancel", async (c) => {
    const workOrderId = parseRouteUuid(c.req.param("id"));
    if (!workOrderId) return invalidIdResponse(c);
    const result = await services.upgradeWorkOrders.cancel(c.get("userId"), workOrderId);
    return c.json(result);
  });

  // POST /:id/complete — seed 一次性继承入 L2 + 工单置已完成（幂等）。
  app.post("/:id/complete", async (c) => {
    const workOrderId = parseRouteUuid(c.req.param("id"));
    if (!workOrderId) return invalidIdResponse(c);
    const result = await services.upgradeWorkOrders.complete(c.get("userId"), workOrderId);
    return c.json(result);
  });

  return app;
}
