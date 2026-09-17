/**
 * L3 列表读路由（ADR-0029 §6 读面补缺 ②/①，2026-09-12）。
 *
 * 独立薄路由先例：sources.ts / reads.ts 受复杂度棘轮约束不可再加行（同
 * server.ts 中 l2 系列的 llm-status / promotion / candidates 薄路由），
 * 故"带 space/direction 两轴过滤的列表读"统一收口在本模块：
 * - GET /sources              ← 自 sources.ts 迁入并补两轴过滤（§6②）
 * - GET /words/:slug/contexts ← 自 reads.ts 迁入并补两轴过滤（§6②）
 * - GET /occurrences / GET /context-links ← 新增（§6①）
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3ContextLinkListQuerySchema,
  l3OccurrenceListQuerySchema,
  l3SourceListQuerySchema,
  l3WordContextListQuerySchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function l3ListsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/sources", async (c) => {
    const parsed = l3SourceListQuerySchema.safeParse({
      sourceType: c.req.query("sourceType") || undefined,
      q: c.req.query("q") || undefined,
      sort: c.req.query("sort") || undefined,
      direction: c.req.query("direction") || undefined,
      space: c.req.query("space") || undefined,
      limit: c.req.query("limit") || undefined,
      offset: c.req.query("offset") || undefined,
    });
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listSources({ userId: c.get("userId"), ...parsed.data });
    return c.json(result);
  });

  app.get("/words/:slug/contexts", async (c) => {
    const parsed = l3WordContextListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listContextsForWord({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
      direction: parsed.data.direction ?? null,
      space: parsed.data.space ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/occurrences", async (c) => {
    const parsed = l3OccurrenceListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listOccurrences({
      userId: c.get("userId"),
      slug: parsed.data.slug,
      wordId: parsed.data.wordId,
      contextId: parsed.data.contextId,
      direction: parsed.data.direction ?? null,
      space: parsed.data.space ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/context-links", async (c) => {
    const parsed = l3ContextLinkListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listContextLinks({
      userId: c.get("userId"),
      slug: parsed.data.slug,
      wordId: parsed.data.wordId,
      contextId: parsed.data.contextId,
      linkType: parsed.data.linkType,
      targetType: parsed.data.targetType,
      direction: parsed.data.direction ?? null,
      space: parsed.data.space ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  return app;
}
