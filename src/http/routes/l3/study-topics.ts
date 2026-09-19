/**
 * 学习笔记（N1）·专题路由（薄；挂 /api/l3/study-topics）。
 *
 * POST   /                              创建（幂等 requestId；201/200）
 * GET    /                              列表（venue 必填；keyset 分页）
 * PUT    /:topicId                      元数据保存（title/status 共享版本）
 * PUT    /:topicId/members/:noteId      加入或移动（beforeNoteId=null 移末尾）
 * DELETE /:topicId/members/:noteId      移出（JSON body：requestId + expectedVersion）
 *
 * 全部 owner-only；成员操作锁序 topic → note（防与笔记保存的竞态）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3StudyTopicCreateSchema,
  l3StudyTopicListQuerySchema,
  l3StudyTopicMemberMoveSchema,
  l3StudyTopicMemberRemoveSchema,
  l3StudyTopicSaveSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function studyTopicsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/study-topics", async (c) => {
    const parsed = l3StudyTopicCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.studyNotes.createTopic(c.get("userId"), parsed.data);
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/study-topics", async (c) => {
    const parsed = l3StudyTopicListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyNotes.listTopics(c.get("userId"), parsed.data));
  });

  app.put("/study-topics/:topicId", async (c) => {
    const parsed = l3StudyTopicSaveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.studyNotes.saveTopic(c.get("userId"), c.req.param("topicId"), parsed.data));
  });

  app.put("/study-topics/:topicId/members/:noteId", async (c) => {
    const parsed = l3StudyTopicMemberMoveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(
      await services.studyNotes.moveTopicMember(
        c.get("userId"),
        c.req.param("topicId"),
        c.req.param("noteId"),
        parsed.data,
      ),
    );
  });

  app.delete("/study-topics/:topicId/members/:noteId", async (c) => {
    const parsed = l3StudyTopicMemberRemoveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(
      await services.studyNotes.removeTopicMember(
        c.get("userId"),
        c.req.param("topicId"),
        c.req.param("noteId"),
        parsed.data,
      ),
    );
  });

  return app;
}
