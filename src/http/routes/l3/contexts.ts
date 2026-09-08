/**
 * L3 语境域路由：语境 CRUD、golden 快记三件套、occurrence 与 context-link 写路径。
 * 自 2026-09-08 起 l3.ts 按资源域拆分（499/500 复杂度门禁触顶），路径与语义不变。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3ContextCreateSchema,
  l3ContextLinkCreateSchema,
  l3OccurrenceCreateSchema,
  quickL3ContextSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import { asJson, invalidIdResponse, parseRouteUuid } from "./shared";

export function contextsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/contexts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ContextCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.createContext({
      userId: c.get("userId"),
      ...parsed.data,
      normalizedText: parsed.data.normalizedText ?? null,
      language: parsed.data.language ?? null,
      position: asJson(parsed.data.position ?? {}),
      metadata: asJson(parsed.data.metadata ?? {}),
    });
    return c.json(result, 201);
  });

  app.post("/quick-context", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = quickL3ContextSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.createWordContextTrio({ userId: c.get("userId"), ...parsed.data });
    return c.json({ ok: true, ...result }, 201);
  });

  app.post("/occurrences", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3OccurrenceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.createOccurrence({
      userId: c.get("userId"),
      ...parsed.data,
      lemma: parsed.data.lemma ?? null,
      startOffset: parsed.data.startOffset ?? null,
      endOffset: parsed.data.endOffset ?? null,
      confidence: parsed.data.confidence ?? null,
      evidence: asJson(parsed.data.evidence ?? {}),
    });
    return c.json(result, 201);
  });

  app.delete("/occurrences/:id", async (c) => {
    const occurrenceId = parseRouteUuid(c.req.param("id"));
    if (!occurrenceId) return invalidIdResponse(c);
    const result = await services.l3Context.deleteOccurrence({
      userId: c.get("userId"),
      occurrenceId,
    });
    return c.json(result);
  });

  app.post("/context-links", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ContextLinkCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Context.createContextLink({
      userId: c.get("userId"),
      ...parsed.data,
      contextId: parsed.data.contextId ?? null,
      wordId: parsed.data.wordId ?? null,
      targetId: parsed.data.targetId ?? null,
      targetRef: asJson(parsed.data.targetRef ?? {}),
      confidence: parsed.data.confidence ?? null,
      provenance: asJson(parsed.data.provenance ?? {}),
    });
    return c.json(result, 201);
  });

  app.delete("/context-links/:id", async (c) => {
    const contextLinkId = parseRouteUuid(c.req.param("id"));
    if (!contextLinkId) return invalidIdResponse(c);
    const result = await services.l3Context.deleteContextLink({
      userId: c.get("userId"),
      contextLinkId,
    });
    return c.json(result);
  });

  app.delete("/contexts/:id", async (c) => {
    const contextId = parseRouteUuid(c.req.param("id"));
    if (!contextId) return invalidIdResponse(c);
    const result = await services.l3Context.deleteContext({
      userId: c.get("userId"),
      contextId,
    });
    return c.json(result);
  });

  app.get("/contexts/:id", async (c) => {
    const result = await services.l3Read.getContextDetail({
      userId: c.get("userId"),
      contextId: c.req.param("id"),
    });
    return c.json(result);
  });

  return app;
}
