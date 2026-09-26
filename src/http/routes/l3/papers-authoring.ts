/**
 * 录题闸门路由（ADR-0037，2026-09-26）——**独立薄路由**，承担录题族的全部端点。
 *
 * 拆模块有两个理由（都写进文件头是因为它们很容易被下一个人"顺手违反"）：
 *  1. `routes/l3/papers.ts` 受复杂度棘轮冻结在基线（实际行数）——把建卷/录题迁出
 *     后它只剩读面与删题；同 papers-update / capabilities / sheets-export 先例。
 *  2. 录题是**一个族**：写入（建题/建卷）与评审（待录/采纳/驳回）必须在同一模块，
 *     否则"谁能写什么"这条规则会散在两个文件里各自漂移。
 *
 * 授权矩阵（`operations.ts` 是真源，这里只列形状）：
 *  - agent 可写：建题、建卷、改题面 —— 但产物一律 `status='pending'`；
 *  - **owner-only**：待录读面、采纳、驳回、批量采纳。核对与升级是 owner 的动作。
 *
 * 身份注入走 `authoringActor`（唯一从 Principal 认定 actor 的地方）；请求体一律
 * `.strict()`，所以 agent 无法在 body 里塞 `status`/`created_by`。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3PaperCreateSchema,
  l3PendingQuestionListQuerySchema,
  l3QuestionAcceptBatchSchema,
  l3QuestionCreateSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import type { Json } from "@/domain";
import { authoringActor } from "./authoring-actor";
import { parseRouteUuid } from "./shared";

export function papersAuthoringRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/papers", async (c) => {
    const parsed = l3PaperCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.createPaper({
      userId: c.get("userId"),
      actor: authoringActor(c),
      title: parsed.data.title,
      direction: parsed.data.direction ?? null,
      metadata: parsed.data.metadata as Json | undefined,
      sections: parsed.data.sections,
    }), 201);
  });

  app.post("/questions", async (c) => {
    const parsed = l3QuestionCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.createQuestion({
      userId: c.get("userId"),
      actor: authoringActor(c),
      ...parsed.data,
      sourceId: parsed.data.sourceId ?? null,
      fileKey: parsed.data.fileKey ?? null,
    }), 201);
  });

  app.get("/questions", async (c) => {
    const parsed = l3PendingQuestionListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.listPendingQuestions({
      userId: c.get("userId"),
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    }));
  });

  app.post("/questions/:id/accept", async (c) => {
    const questionId = parseRouteUuid(c.req.param("id"));
    if (!questionId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    return c.json(await services.l3Paper.acceptQuestions({
      userId: c.get("userId"),
      questionIds: [questionId],
    }));
  });

  app.post("/questions/:id/reject", async (c) => {
    const questionId = parseRouteUuid(c.req.param("id"));
    if (!questionId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    return c.json(await services.l3Paper.rejectQuestion({ userId: c.get("userId"), questionId }));
  });

  app.post("/questions/accept-batch", async (c) => {
    const parsed = l3QuestionAcceptBatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.acceptQuestions({
      userId: c.get("userId"),
      questionIds: parsed.data.questionIds,
    }));
  });

  return app;
}
