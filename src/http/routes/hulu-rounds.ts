/**
 * Hulu sprint round-advancement routes (ADR-0041, P1).
 *
 * 与 `hulu.ts` 同挂 `/api/hulu` 前缀（同 l3 族 `app.route("/api/l3", X)` 多条先例）：
 * `hulu.ts` 在 P0 落地后即被路由复杂度棘轮**冻结在基线**（67 行 / 3 路由），
 * P1 的四条端点因此另立本文件，而不是把冻结文件撑大。
 *
 *   GET  /plans/:id/pages/:no          — 本页词卡渲染载荷（R4，只读、零副作用）
 *   POST /plans/:id/rounds             — 开始下一轮（已有未收尾轮 → 返回它）
 *   POST /plans/:id/rounds/:no/pages   — 页结算（R7 游标幂等；不过闸 422、跳页 409）
 *   POST /plans/:id/rounds/:no/finish  — 轮收尾（已收尾幂等；末轮同事务完成计划）
 *
 * 恒 201：开始轮幂等命中既有轮时也走 201（状态码不因幂等而变）。
 * 路由不做业务判断：404/409/422 全部由 service 抛错、errorToResponse 统一映射。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { huluPageSettleSchema, huluRoundFinishSchema, huluRoundStartSchema } from "@/schemas/http";
import { validationError } from "../error-response";
import { invalidIdResponse, parseRouteUuid } from "./l3/shared";

/** 路径参数 `:no`（页号 / 轮号）：非负整数，否则 null（路由层 400）。 */
function parseRouteNonNegativeInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 解析可选 JSON body（缺 body / 非法 JSON 视为空对象，交给 schema 判形状）。 */
async function optionalJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  const body = await c.req.json().catch(() => ({}));
  return body ?? {};
}

export function huluRoundsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /plans/:id/pages/:no — 本页词卡载荷（R4）。只读、零副作用；越界页 404。
  app.get("/plans/:id/pages/:no", async (c) => {
    const planId = parseRouteUuid(c.req.param("id"));
    if (!planId) return invalidIdResponse(c);
    const pageIndex = parseRouteNonNegativeInt(c.req.param("no"));
    if (pageIndex === null) return invalidIdResponse(c, "no");
    return c.json(await services.hulu.getPlanPage({ userId: c.get("userId"), planId, pageIndex }));
  });

  // POST /plans/:id/rounds — 开始下一轮（已有未收尾轮 → 返回它；超目标轮数 → 409）。
  app.post("/plans/:id/rounds", async (c) => {
    const planId = parseRouteUuid(c.req.param("id"));
    if (!planId) return invalidIdResponse(c);
    const parsed = huluRoundStartSchema.safeParse(await optionalJson(c));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.hulu.startRound({
      userId: c.get("userId"), planId, startedAt: parsed.data.startedAt,
    });
    return c.json(result, 201);
  });

  // POST /plans/:id/rounds/:no/pages — 页结算（不过闸 422、跳页 409、重复提交幂等）。
  app.post("/plans/:id/rounds/:no/pages", async (c) => {
    const planId = parseRouteUuid(c.req.param("id"));
    if (!planId) return invalidIdResponse(c);
    const roundNo = parseRouteNonNegativeInt(c.req.param("no"));
    if (roundNo === null) return invalidIdResponse(c, "no");
    const parsed = huluPageSettleSchema.safeParse(await optionalJson(c));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.hulu.settlePage({
      userId: c.get("userId"), planId, roundNo,
      pageIndex: parsed.data.pageIndex, passed: parsed.data.passed, total: parsed.data.total,
    });
    return c.json(result);
  });

  // POST /plans/:id/rounds/:no/finish — 轮收尾（已收尾幂等；末轮同事务完成计划）。
  app.post("/plans/:id/rounds/:no/finish", async (c) => {
    const planId = parseRouteUuid(c.req.param("id"));
    if (!planId) return invalidIdResponse(c);
    const roundNo = parseRouteNonNegativeInt(c.req.param("no"));
    if (roundNo === null) return invalidIdResponse(c, "no");
    const parsed = huluRoundFinishSchema.safeParse(await optionalJson(c));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.hulu.finishRound({
      userId: c.get("userId"), planId, roundNo, endedAt: parsed.data.endedAt,
    });
    return c.json(result);
  });

  return app;
}
