/**
 * Plaza HTTP routes — 词汇广场（P4）。
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.plaza` service.
 *
 * Routes:
 *   GET  /                 广场总览（语义场集合分组，支持 q 过滤）
 *   GET  /collections/:slug 单个集合详情（关联词卡）
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AuthRole, Principal } from "@/http/middleware/auth";
import { plazaQuerySchema, plazaRootsQuerySchema } from "@/schemas/http";
import { validationError } from "../error-response";

export type PlazaAppEnv = {
  Variables: {
    role: AuthRole;
    userId: string;
    principal: Principal;
    requestId: string;
  };
};

export function plazaRoutes(services: Services) {
  const app = new Hono<PlazaAppEnv>();

  // GET / — overview（语义场；q 可选：按语义场名过滤）
  app.get("/", async (c) => {
    const parsed = plazaQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.plaza.getOverview({
      userId: c.get("userId"),
      q: parsed.data.q,
    });
    return c.json(result);
  });

  // GET /roots — 词根词缀广场（minCount/q/letter 深度筛选）
  app.get("/roots", async (c) => {
    const parsed = plazaRootsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.plaza.getRootsOverview({
      userId: c.get("userId"),
      minCount: parsed.data.minCount,
      q: parsed.data.q,
      letter: parsed.data.letter,
    });
    return c.json(result);
  });

  // GET /roots/:slug — 词根家族详情（NotFoundError → 404）
  app.get("/roots/:slug", async (c) => {
    const detail = await services.plaza.getRootCollection({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
    });
    return c.json(detail);
  });

  // GET /collections/:slug — 语义场集合详情（NotFoundError → 404 由全局中间件映射）
  app.get("/collections/:slug", async (c) => {
    const detail = await services.plaza.getCollection({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
    });
    return c.json(detail);
  });

  return app;
}
