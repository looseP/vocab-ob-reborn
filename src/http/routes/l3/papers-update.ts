/**
 * L3 改题面 / 改卷路由（2026-09-26）——**独立薄路由**。
 *
 * 为什么单独成文件：`routes/l3/papers.ts` 受复杂度棘轮冻结（80 行 / 7 路由，
 * 见 verify-route-complexity 的基线），且它的文件头已声明"薄路由"纪律。把两个
 * PATCH 端点塞进去会越线——那就拆模块，而不是抬高基线（同 sheets/grading/
 * assessments/error-book 的先例）。
 *
 * 护栏在 service（l3-paper.service.updateQuestion / updatePaper）：
 *  - 有作答历史 → 409（答案历史不可改写）
 *  - 被作文任务引用 → 409（题面冻结 = 新任务）
 *  - 证据锚点越界 → 422（带正文长度）
 *  - 引用他人/非 active 的题 → 422
 *
 * 角色闸门（ADR-0037）：agent 可写但**只能改 pending**（service 判，见 updateQuestion）；
 * 删题仍 owner-only。改卷仍 owner-only（agent 只建卷，卷内题强制 pending）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3PaperUpdateSchema, l3QuestionUpdateSchema } from "@/schemas/http";
import { validationError } from "../../error-response";
import { authoringActor } from "./authoring-actor";
import { parseRouteUuid } from "./shared";
import type { Json } from "@/domain";

export function papersUpdateRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.patch("/papers/:id", async (c) => {
    const paperId = parseRouteUuid(c.req.param("id"));
    if (!paperId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    const parsed = l3PaperUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.updatePaper({
      userId: c.get("userId"),
      paperId,
      title: parsed.data.title,
      direction: parsed.data.direction ?? null,
      metadata: parsed.data.metadata as Json | undefined,
      sections: parsed.data.sections,
    }));
  });

  app.patch("/questions/:id", async (c) => {
    const questionId = parseRouteUuid(c.req.param("id"));
    if (!questionId) return validationError(c, { fieldErrors: { id: ["invalid uuid"] } });
    const parsed = l3QuestionUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Paper.updateQuestion({
      userId: c.get("userId"),
      // ADR-0037：agent 可写，但 service 的可改状态集合对它只给 {pending}。
      actor: authoringActor(c),
      questionId,
      ...parsed.data,
    }));
  });

  return app;
}
