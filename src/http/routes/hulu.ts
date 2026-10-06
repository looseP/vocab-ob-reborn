/**
 * Hulu sprint HTTP routes (ADR-0041).
 *
 * 独立前缀 /api/hulu。HTTP 薄层：解析 body、附加 auth userId、只调 service。
 * 本期（P0）三条端点先行（计划容器）：
 *
 *   POST /plans              — 创建（含定格+风险校验；同词书已有 active → 200 返回它）
 *   GET  /plans/:id          — 计划 + 轮次列表（缩时曲线数据源）
 *   POST /plans/:id/abandon  — 放弃（已 abandoned 幂等；已 completed → 422）
 *
 * 其余四条（rounds 开始 / 页结算 / 轮收尾 / 页载荷）在 P1 补齐。
 * 路由不做业务判断：422/404/409 全部由 service 抛错、errorToResponse 统一映射。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { huluPlanCreateSchema } from "@/schemas/http";
import { validationError } from "../error-response";
import { invalidIdResponse, parseRouteUuid } from "./l3/shared";

export function huluRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /plans — 创建计划（幂等：同词书已有 active 计划直接返回它）。
  app.post("/plans", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = huluPlanCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.hulu.createPlan({
      userId: c.get("userId"),
      wordbookId: parsed.data.wordbookId,
      direction: parsed.data.direction ?? null,
      examDate: parsed.data.examDate,
      targetRounds: parsed.data.targetRounds,
      pageSize: parsed.data.pageSize,
      gateRatio: parsed.data.gateRatio,
      suspendReview: parsed.data.suspendReview,
    });
    return c.json(result, 201);
  });

  // GET /plans/:id — 计划 + 轮次（现拉；缩时曲线的唯一数据源）。
  app.get("/plans/:id", async (c) => {
    const planId = parseRouteUuid(c.req.param("id"));
    if (!planId) return invalidIdResponse(c);
    const result = await services.hulu.getPlan({
      userId: c.get("userId"),
      planId,
    });
    return c.json(result);
  });

  // POST /plans/:id/abandon — 放弃（active → abandoned；幂等；completed → 422）。
  app.post("/plans/:id/abandon", async (c) => {
    const planId = parseRouteUuid(c.req.param("id"));
    if (!planId) return invalidIdResponse(c);
    const result = await services.hulu.abandonPlan({
      userId: c.get("userId"),
      planId,
    });
    return c.json(result);
  });

  return app;
}
