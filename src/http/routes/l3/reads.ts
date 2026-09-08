/**
 * L3 只读空间路由：词空间、词语境列表、关系图。
 * 自 2026-09-08 起 l3.ts 按资源域拆分（499/500 复杂度门禁触顶），路径与语义不变。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3GraphQuerySchema,
  l3LimitCursorQuerySchema,
  l3WordSpaceQuerySchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function readsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/words/:slug/space", async (c) => {
    const parsed = l3WordSpaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Read.getWordSpace({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
      wordbookId: parsed.data.wordbookId ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/words/:slug/contexts", async (c) => {
    const parsed = l3LimitCursorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listContextsForWord({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/graph", async (c) => {
    const parsed = l3GraphQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Read.getGraph({
      userId: c.get("userId"),
      wordbookId: parsed.data.wordbookId ?? null,
      slug: parsed.data.slug ?? null,
      sourceId: parsed.data.sourceId ?? null,
      depth: parsed.data.depth,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  return app;
}
