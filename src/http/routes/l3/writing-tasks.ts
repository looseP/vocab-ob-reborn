/**
 * 作文子空间 · 任务路由（W6，ADR《writing-workspace》§6）——独立薄路由直挂 server.ts
 * （sheets.ts 受复杂度棘轮约束不许增长，同 grading/assessments 先例）。
 *
 * POST /tasks                创建（幂等 requestId；201 新建 / 200 复用）
 * GET  /tasks                列表（keyset；q/status/limit/cursor）
 * GET  /tasks/:taskId        详情（GET 零写入）
 * PATCH /tasks/:taskId       重命名（题面不开放编辑）
 * POST /tasks/:taskId/archive  归档（有 draft 409）
 * POST /tasks/:taskId/restore  恢复（不自动开纸）
 * GET  /tasks/:taskId/revisions 稿次历史（sealed/discarded）
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3WritingRevisionListQuerySchema,
  l3WritingTaskCreateSchema,
  l3WritingTaskListQuerySchema,
  l3WritingTaskRenameSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function writingTasksRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/tasks", async (c) => {
    const parsed = l3WritingTaskCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3WritingTasks.create(c.get("userId"), parsed.data);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/tasks", async (c) => {
    const parsed = l3WritingTaskListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3WritingTasks.list(c.get("userId"), parsed.data));
  });

  app.get("/tasks/:taskId", async (c) => {
    return c.json(await services.l3WritingTasks.get(c.get("userId"), c.req.param("taskId")));
  });

  app.patch("/tasks/:taskId", async (c) => {
    const parsed = l3WritingTaskRenameSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3WritingTasks.rename(c.get("userId"), c.req.param("taskId"), parsed.data));
  });

  app.post("/tasks/:taskId/archive", async (c) => {
    return c.json(await services.l3WritingTasks.archive(c.get("userId"), c.req.param("taskId")));
  });

  app.post("/tasks/:taskId/restore", async (c) => {
    return c.json(await services.l3WritingTasks.restore(c.get("userId"), c.req.param("taskId")));
  });

  app.get("/tasks/:taskId/revisions", async (c) => {
    const parsed = l3WritingRevisionListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3WritingSheets.listRevisions(c.get("userId"), c.req.param("taskId"), parsed.data));
  });

  return app;
}
