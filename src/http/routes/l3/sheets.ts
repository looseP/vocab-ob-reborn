/**
 * 题纸（l3_submissions）与作答历史（l3_question_attempts）路由（批次二，0034）。
 *
 * 独立薄路由：l3/index.ts 组合器受复杂度棘轮冻结（同 papers/annotations 先例），
 * 由 http/server.ts 直挂。:id 不做 uuid 预校验，不存在/非属主统一由 service 转
 * 404。开纸幂等：复用 200 / 新建 201；PATCH 非 draft → 409；seal 未答软确认
 * → 409（details.unansweredCount）；DELETE 软删 204、再删 404。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3AttemptListQuerySchema,
  l3SheetOpenSchema,
  l3SheetPatchSchema,
  l3SheetSealSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function sheetsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/sheets", async (c) => {
    const parsed = l3SheetOpenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Sheets.openSheet({ userId: c.get("userId"), ...parsed.data });
    return c.json({ sheet: result.sheet }, result.created ? 201 : 200);
  });

  app.get("/sheets/:id", async (c) => {
    return c.json(await services.l3Sheets.getSheet(c.get("userId"), c.req.param("id")));
  });

  app.patch("/sheets/:id", async (c) => {
    const parsed = l3SheetPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Sheets.patchSheet({
      userId: c.get("userId"), sheetId: c.req.param("id"),
      expectedVersion: parsed.data.expectedVersion, answers: parsed.data.answers,
    }));
  });

  app.post("/sheets/:id/seal", async (c) => {
    const parsed = l3SheetSealSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Sheets.sealSheet({
      userId: c.get("userId"),
      sheetId: c.req.param("id"),
      ...parsed.data,
    }));
  });

  app.get("/attempts", async (c) => {
    const parsed = l3AttemptListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Sheets.listAttempts(c.get("userId"), parsed.data.questionIds));
  });

  app.delete("/attempts/:id", async (c) => {
    await services.l3Sheets.deleteAttempt(c.get("userId"), c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
