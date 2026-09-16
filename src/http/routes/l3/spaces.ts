/**
 * L3 能力域标签路由（V0 接通 l3_source_spaces 死轴）。
 *
 * PUT /sources/:id/spaces：全量替换来源的能力域标签（1–5 个固定枚举）。
 *
 * 独立薄路由：sources.ts 受复杂度棘轮冻结（同 capabilities/summary/papers
 * 的 server.ts 直挂先例），本文件不进 l3/index.ts 组合器。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3SourceSpacesReplaceSchema } from "@/schemas/http";
import { validationError } from "../../error-response";
import { parseRouteUuid } from "./shared";

export function l3SourceSpacesRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.put("/sources/:id/spaces", async (c) => {
    const sourceId = parseRouteUuid(c.req.param("id"));
    if (!sourceId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    const parsed = l3SourceSpacesReplaceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Context.replaceSourceSpaces({
      userId: c.get("userId"),
      sourceId,
      spaces: parsed.data.spaces,
    });
    return c.json(result);
  });

  return app;
}
