/**
 * 学习笔记（N1）·笔记路由（薄；挂 /api/l3/study-notes）。
 *
 * POST /            创建（幂等 requestId；201 新建 / 200 复用）
 * GET  /            列表（venue 必填；keyset 分页；cursor 绑定过滤指纹）
 * GET  /:noteId     详情（GET 零写入；含引用预览与状态）
 * PUT  /:noteId     完整状态保存（CAS + 最后一次请求幂等；原子）
 *
 * 固定路径组（reference-targets / reference-preview / backlinks）由
 * study-references.ts 独立注册并在 server.ts 先于本路由挂载——不误入详情路由；
 * 非法 UUID 由 PG 22P02 全局映射为 400（含详情/保存路径）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3StudyNoteCreateSchema,
  l3StudyNoteListQuerySchema,
  l3StudyNoteSaveSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function studyNotesRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/study-notes", async (c) => {
    const parsed = l3StudyNoteCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.studyNotes.create(c.get("userId"), parsed.data);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/study-notes", async (c) => {
    const parsed = l3StudyNoteListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyNotes.list(c.get("userId"), parsed.data));
  });

  app.get("/study-notes/:noteId", async (c) => {
    return c.json(await services.studyNotes.get(c.get("userId"), c.req.param("noteId")));
  });

  app.put("/study-notes/:noteId", async (c) => {
    const parsed = l3StudyNoteSaveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyNotes.save(c.get("userId"), c.req.param("noteId"), parsed.data));
  });

  return app;
}
