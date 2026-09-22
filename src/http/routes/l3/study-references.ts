/**
 * 学习笔记（N1）·引用路由（薄；/api/l3/study-notes 下的固定路径组）。
 *
 * GET  /study-notes/reference-targets  目标搜索（每次只查一个 kind；摘要不含答案）
 * POST /study-notes/reference-preview  只读预览（POST 但零写不持久化；沿用 session CSRF 保护）
 * GET  /study-notes/backlinks          反向引用（按 note 去重聚合，默认不含归档）
 *
 * 本组在 server.ts 先于 study-notes.ts 挂载：固定路径不得误入 /:noteId 详情路由。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3StudyBacklinkQuerySchema,
  l3StudyReferenceTargetQuerySchema,
  l3StudyReferenceTargetSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function studyReferencesRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/study-notes/reference-targets", async (c) => {
    const parsed = l3StudyReferenceTargetQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyReferences.search(c.get("userId"), parsed.data));
  });

  // POST 语义（body 承载 ReferenceTarget），但只读：独立 actor 事务、零写、不持久化。
  app.post("/study-notes/reference-preview", async (c) => {
    const parsed = l3StudyReferenceTargetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyReferences.preview(c.get("userId"), parsed.data));
  });

  app.get("/study-notes/backlinks", async (c) => {
    const parsed = l3StudyBacklinkQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyReferences.backlinks(c.get("userId"), parsed.data));
  });

  return app;
}
