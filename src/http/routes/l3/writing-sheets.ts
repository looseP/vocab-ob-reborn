/**
 * 作文子空间 · 稿件路由（W6，ADR《writing-workspace》§6）。
 *
 * GET  /tasks/:taskId/sheets/:sheetId          稿详情（含反馈组合；GET 零创建）
 * POST /tasks/:taskId/drafts                   新稿/修改稿（显式创建；201/200）
 * PATCH /tasks/:taskId/sheets/:sheetId         CAS 保存（专用契约；expectedVersion）
 * POST /tasks/:taskId/sheets/:sheetId/submit   提交（幂等；物化 attempt）
 * POST /tasks/:taskId/sheets/:sheetId/discard  丢弃草稿
 *
 * GET 稿详情的 feedback 组合：sealed 且正文未清理时读 W5 反馈服务（读取失败
 * 为对应非 2xx）；draft / cleared 组合为 null（占位语义，不冒充 pending）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3WritingDraftCreateSchema,
  l3WritingDraftSaveSchema,
  l3WritingSubmitSchema,
} from "@/schemas/http";
import type { WritingFeedbackRecord } from "@/domain";
import { validationError } from "../../error-response";

export function writingSheetsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/tasks/:taskId/sheets/:sheetId", async (c) => {
    const userId = c.get("userId");
    const taskId = c.req.param("taskId");
    const sheetId = c.req.param("sheetId");
    const detail = await services.l3WritingSheets.getSheet(userId, taskId, sheetId);
    let feedback: WritingFeedbackRecord | null = null;
    if (detail.sheet.status === "sealed" && detail.contentStatus === "available") {
      const result = await services.l3WritingFeedback.getFeedback(userId, taskId, sheetId);
      feedback = result.feedback;
    }
    return c.json({ ...detail, feedback });
  });

  app.post("/tasks/:taskId/drafts", async (c) => {
    const parsed = l3WritingDraftCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3WritingSheets.createDraft(
      c.get("userId"),
      c.req.param("taskId"),
      parsed.data,
    );
    return c.json(result, result.created ? 201 : 200);
  });

  app.patch("/tasks/:taskId/sheets/:sheetId", async (c) => {
    const parsed = l3WritingDraftSaveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3WritingSheets.saveDraft(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
      parsed.data,
    ));
  });

  app.post("/tasks/:taskId/sheets/:sheetId/submit", async (c) => {
    const parsed = l3WritingSubmitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3WritingSheets.submit(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
      parsed.data,
    ));
  });

  app.post("/tasks/:taskId/sheets/:sheetId/discard", async (c) => {
    const parsed = l3WritingSubmitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3WritingSheets.discard(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
      parsed.data,
    ));
  });

  return app;
}
