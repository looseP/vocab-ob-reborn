/**
 * L3 题目/试卷域**读面与删题**路由（ADR-0030，V1 owner 入库面）：试卷列表与详情
 * （现拉组装）/ 题型空间文件列表与详情 / 删题（卷面引用走 409）。
 *
 * ⚠️ 本模块受复杂度棘轮冻结（基线 = 实际行数），且录题写面已迁出到
 * `papers-authoring.ts`（ADR-0037）——建卷/录题/改题面/采纳都在那边。
 * 改题面/改卷的 PATCH 在 `papers-update.ts`。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3PaperListQuerySchema,
  l3PracticeFileDetailQuerySchema,
  l3PracticeFileListQuerySchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import { parseRouteUuid } from "./shared";

export function papersRoutes(services: Services) {
  const app = new Hono<AppEnv>();

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
