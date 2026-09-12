/**
 * L3 空间汇总路由（B1 素材宇宙）：四类实体全量计数 + 近 N 天生长趋势（只读）。
 *
 * 独立薄路由先例：l3/index.ts 受复杂度棘轮冻结，沿 l3/lists.ts /
 * l3/capabilities.ts 的 server.ts 直挂模式（本文件零业务逻辑）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3SpaceSummaryQuerySchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function l3SummaryRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/space-summary", async (c) => {
    const parsed = l3SpaceSummaryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.getSpaceSummary({
      userId: c.get("userId"),
      windowDays: parsed.data.days,
    });
    return c.json(result);
  });

  return app;
}
