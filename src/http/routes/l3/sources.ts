/**
 * L3 来源域路由：来源 CRUD、正文导入（书架）、选区圈记、来源读空间。
 * 自 2026-09-08 起 l3.ts 按资源域拆分（499/500 复杂度门禁触顶），路径与语义不变。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3LimitCursorQuerySchema,
  l3SelectionCaptureSchema,
  l3SourceCreateSchema,
  l3SourceListQuerySchema,
  l3SourceSpaceQuerySchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import { asJson, parseRouteUuid } from "./shared";

export function sourcesRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/sources", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3SourceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.createSource({
      userId: c.get("userId"),
      ...parsed.data,
      wordbookId: parsed.data.wordbookId ?? null,
      author: parsed.data.author ?? null,
      url: parsed.data.url ?? null,
      language: parsed.data.language ?? null,
      metadata: asJson(parsed.data.metadata ?? {}),
    });
    return c.json(result, 201);
  });

  app.post("/sources/:id/captures", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3SelectionCaptureSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const sourceId = parseRouteUuid(c.req.param("id"));
    if (!sourceId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    const result = await services.l3Context.createSelectionCapture({
      userId: c.get("userId"),
      sourceId,
      ...parsed.data,
    });
    return c.json(result, 201);
  });

  app.get("/sources", async (c) => {
    const parsed = l3SourceListQuerySchema.safeParse({
      sourceType: c.req.query("sourceType") || undefined,
      q: c.req.query("q") || undefined,
      sort: c.req.query("sort") || undefined,
      limit: c.req.query("limit") || undefined,
      offset: c.req.query("offset") || undefined,
    });
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listSources({ userId: c.get("userId"), ...parsed.data });
    return c.json(result);
  });

  app.get("/sources/:id/space", async (c) => {
    const parsed = l3SourceSpaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Read.getSourceSpace({
      userId: c.get("userId"),
      sourceId: c.req.param("id"),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/sources/:id/contexts", async (c) => {
    const parsed = l3LimitCursorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.listContextsForSource({
      userId: c.get("userId"),
      sourceId: c.req.param("id"),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.delete("/sources/:id", async (c) => {
    const sourceId = parseRouteUuid(c.req.param("id"));
    if (!sourceId) {
      return validationError(c, { fieldErrors: { id: ["Invalid uuid"] } });
    }
    const result = await services.l3Context.deleteSource({
      userId: c.get("userId"),
      sourceId,
    });
    return c.json(result);
  });

  return app;
}
