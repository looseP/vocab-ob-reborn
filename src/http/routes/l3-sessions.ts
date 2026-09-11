/**
 * L3 session plan HTTP routes (ADR-0019 §2).
 *
 * 独立前缀 /api/l3-sessions，避开已挂载的 l3Routes（/api/l3）。HTTP 薄层：
 * 解析 body/query、附加 auth userId、只调 service；plan 只存 id 引用，渲染描述
 * 由 service 现拉现组（无 HTML 产物、零 FSRS）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { l3SessionCreateSchema, l3SessionEndSchema } from "@/schemas/http";
import { validationError } from "../error-response";
import { invalidIdResponse, parseRouteUuid } from "./l3/shared";

export function l3SessionsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST / — 建会话计划（确定性抽样 context id；无匹配素材 → 422）。
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3SessionCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Sessions.createPlan({
      userId: c.get("userId"),
      type: parsed.data.type,
      title: parsed.data.title ?? null,
      space: parsed.data.space ?? null,
      direction: parsed.data.direction ?? null,
      contextCount: parsed.data.contextCount ?? null,
      days: parsed.data.days ?? null,
      seed: parsed.data.seed ?? null,
    });
    return c.json(result, 201);
  });

  // GET /:id — 现拉现渲染的会话描述。
  app.get("/:id", async (c) => {
    const sessionId = parseRouteUuid(c.req.param("id"));
    if (!sessionId) return invalidIdResponse(c);
    const result = await services.l3Sessions.getSession({
      userId: c.get("userId"),
      sessionId,
    });
    return c.json(result);
  });

  // POST /:id/end — active → completed/abandoned（幂等）。
  app.post("/:id/end", async (c) => {
    const sessionId = parseRouteUuid(c.req.param("id"));
    if (!sessionId) return invalidIdResponse(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3SessionEndSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Sessions.endSession({
      userId: c.get("userId"),
      sessionId,
      status: parsed.data.status,
    });
    return c.json(result);
  });

  return app;
}
