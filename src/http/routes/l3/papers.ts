/**
 * L3 题目/试卷域路由（ADR-0030，V1 owner 入库面）：
 * 建卷 / 散题录入 / 试卷列表与详情（现拉组装）/ 题型空间文件列表与文件详情 /
 * 删题（active 卷面引用走 409 护栏）。agent 双级写入在后续波次按角色分叉，
 * 端点不再新增（同一条代码路径）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3PaperCreateSchema,
  l3PaperListQuerySchema,
  l3PracticeFileDetailQuerySchema,
  l3PracticeFileListQuerySchema,
  l3QuestionCreateSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import type { Json } from "@/domain";
import { parseRouteUuid } from "./shared";

export function papersRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/papers", async (c) => {
    const parsed = l3PaperCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Paper.createPaper({
      userId: c.get("userId"),
      title: parsed.data.title,
      direction: parsed.data.direction ?? null,
      metadata: parsed.data.metadata as Json | undefined,
      sections: parsed.data.sections,
    });
    return c.json(result, 201);
  });

  app.get("/papers", async (c) => {
    const parsed = l3PaperListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.listPapers({ userId: c.get("userId"), ...parsed.data }));
  });

  app.get("/papers/:id", async (c) => {
    const paperId = parseRouteUuid(c.req.param("id"));
    if (!paperId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    return c.json(await services.l3Paper.getPaper(c.get("userId"), paperId));
  });

  app.post("/questions", async (c) => {
    const parsed = l3QuestionCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Paper.createQuestion({
      userId: c.get("userId"),
      ...parsed.data,
      sourceId: parsed.data.sourceId ?? null,
      fileKey: parsed.data.fileKey ?? null,
    });
    return c.json(result, 201);
  });

  app.delete("/questions/:id", async (c) => {
    const questionId = parseRouteUuid(c.req.param("id"));
    if (!questionId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    return c.json(await services.l3Paper.deleteQuestion({ userId: c.get("userId"), questionId }));
  });

  app.get("/practice-files", async (c) => {
    const parsed = l3PracticeFileListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.listPracticeFiles({ userId: c.get("userId"), ...parsed.data }));
  });

  app.get("/practice-files/detail", async (c) => {
    const parsed = l3PracticeFileDetailQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.getPracticeFile({ userId: c.get("userId"), ...parsed.data }));
  });

  return app;
}
