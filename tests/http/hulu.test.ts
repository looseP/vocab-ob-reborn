/**
 * Hulu sprint HTTP 路由测试（ADR-0041，执行计划 P0-6）。
 *
 * 形状照 tests/http/forgetting.test.ts：createApp(services) + mock service，
 * 断言路由-注册表同步、状态码、错误映射（400/404/422/401）。
 *
 * 错误映射口径（与 forgetting/l3-sessions 一致）：
 *   - 请求形状非法（uuid / 日期 / 越界）→ 路由层 400 VALIDATION_ERROR
 *   - service 抛 ValidationError → 422 VALIDATION_ERROR
 *   - service 抛 NotFoundError → 404 NOT_FOUND（含跨用户隔离）
 *   - service 抛 BusinessRuleError → 422 BUSINESS_RULE（含 completed → 放弃）
 *   - 未认证 → 401
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { BusinessRuleError, NotFoundError, ValidationError } from "@/errors";
import type { Services } from "@/services";
import {
  huluPlanRowResponseSchema,
  huluPlanWithRoundsResponseSchema,
} from "@/http/hulu-response-contract";
import type { HuluPlanRow, HuluPlanWithRounds } from "@/domain/hulu-sprint";
import { apiOperations } from "@/http/operations";
import { extractApiSourceRoutes } from "../../scripts/api-source-routes";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

const USER = "00000000-0000-4000-8000-0000000000a1";
const WB = "00000000-0000-4000-8000-0000000000b1";
const PLAN = "00000000-0000-4000-8000-0000000000c1";

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };

function planRow(overrides: Partial<HuluPlanRow> = {}): HuluPlanRow {
  return {
    id: PLAN, user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
    target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: ["w-1", "w-2"],
    status: "active", suspend_review: false, suspend_snapshot: null,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}

function makeMockServices() {
  const hulu = {
    createPlan: vi.fn(async (): Promise<HuluPlanRow> => planRow()),
    getPlan: vi.fn(async (): Promise<HuluPlanWithRounds> => ({ plan: planRow(), rounds: [] })),
    abandonPlan: vi.fn(async (): Promise<HuluPlanRow> => planRow({ status: "abandoned", ended_at: "2026-10-07T00:00:00Z" })),
  };
  return { services: { hulu } as unknown as Services, hulu };
}

async function expectValidationError(response: Response, status = 400) {
  expect(response.status).toBe(status);
  const body = await response.json() as { code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
}

describe("hulu HTTP routes — 注册表同步", () => {
  it("路由文件的三条端点与 operations 注册表逐条一致", async () => {
    const source = (await extractApiSourceRoutes())
      .filter((route) => route.path.startsWith("/api/hulu"))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`)
      .sort();
    const registry = apiOperations
      .filter((operation) => operation.path.startsWith("/api/hulu"))
      .map((operation) => `${operation.method.toUpperCase()} ${operation.path}`)
      .sort();

    expect(source).toEqual([
      "GET /api/hulu/plans/:id",
      "POST /api/hulu/plans",
      "POST /api/hulu/plans/:id/abandon",
    ]);
    expect(registry).toEqual(source);
  });

  it("P0 三条端点的 operationId / 状态码 / 角色与定稿一致", () => {
    const byId = new Map(apiOperations.map((operation) => [operation.operationId, operation]));

    const create = byId.get("createHuluPlan")!;
    expect(create.method).toBe("post");
    expect(create.path).toBe("/api/hulu/plans");
    expect(create.minRole).toBe("owner");
    expect(create.csrf).toBe("sessionMutation");
    expect(create.response.status).toBe(201);

    const get = byId.get("getHuluPlan")!;
    expect(get.method).toBe("get");
    expect(get.path).toBe("/api/hulu/plans/:id");
    expect(get.minRole).toBe("agent");
    expect(get.csrf).toBe("none");
    expect(get.response.status).toBe(200);

    const abandon = byId.get("abandonHuluPlan")!;
    expect(abandon.method).toBe("post");
    expect(abandon.path).toBe("/api/hulu/plans/:id/abandon");
    expect(abandon.minRole).toBe("owner");
    expect(abandon.csrf).toBe("sessionMutation");
    expect(abandon.response.status).toBe(200);
  });

  it("响应契约是 .strict()（多余字段被拒）", () => {
    const row = planRow();
    expect(huluPlanRowResponseSchema.safeParse(row).success).toBe(true);
    expect(huluPlanRowResponseSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
    // 契约里没有任何 FSRS 字段（结构性的零 FSRS）
    for (const key of ["stability", "difficulty", "retrievability", "due_at", "state"]) {
      expect(huluPlanRowResponseSchema.safeParse({ ...row, [key]: 1 }).success).toBe(false);
    }
  });
});

describe("POST /api/hulu/plans", () => {
  it("创建成功返回 201 与计划行（响应契约可解析）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(huluPlanRowResponseSchema.parse(body).id).toBe(PLAN);
    // 默认值由 schema 填充后原样透传（轮数/页数/闸门/不挂起）
    expect(hulu.createPlan).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      direction: null,
      examDate: "2026-12-20",
      targetRounds: 4,
      pageSize: 20,
      gateRatio: 0.8,
      suspendReview: false,
    });
  });

  it("显式字段原样透传（direction / 轮数 / 页数 / 闸门）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        wordbookId: WB, examDate: "2026-12-20", direction: "考研",
        targetRounds: 6, pageSize: 30, gateRatio: 0.9,
      }),
    });

    expect(res.status).toBe(201);
    expect(hulu.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      direction: "考研", targetRounds: 6, pageSize: 30, gateRatio: 0.9,
    }));
  });

  it("请求形状非法 → 400，且不调 service（uuid / 日期 / 越界 / direction 枚举）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const bad = [
      { examDate: "2026-12-20" },                                        // 缺 wordbookId
      { wordbookId: "nope", examDate: "2026-12-20" },                    // 非 uuid
      { wordbookId: WB, examDate: "2026/12/20" },                        // 日期形状
      { wordbookId: WB, examDate: "2026-12-20", targetRounds: 1 },       // 轮数下界外
      { wordbookId: WB, examDate: "2026-12-20", targetRounds: 9 },       // 轮数上界外
      { wordbookId: WB, examDate: "2026-12-20", pageSize: 4 },           // 页数下界外
      { wordbookId: WB, examDate: "2026-12-20", pageSize: 51 },          // 页数上界外
      { wordbookId: WB, examDate: "2026-12-20", gateRatio: 0.49 },       // 闸门下界外
      { wordbookId: WB, examDate: "2026-12-20", gateRatio: 1.01 },       // 闸门上界外
      { wordbookId: WB, examDate: "2026-12-20", direction: "日语" },      // 方向枚举外
    ];
    for (const payload of bad) {
      await expectValidationError(await app.request("/api/hulu/plans", {
        method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(payload),
      }));
    }
    expect(hulu.createPlan).not.toHaveBeenCalled();
  });

  it("service 抛 NotFoundError（他人词书）→ 404", async () => {
    const { services, hulu } = makeMockServices();
    hulu.createPlan.mockRejectedValue(new NotFoundError("Wordbook", WB));
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20" }),
    });

    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("NOT_FOUND");
  });

  it("service 抛 BusinessRuleError（风险 block）→ 422 且 details 带缺口", async () => {
    const { services, hulu } = makeMockServices();
    hulu.createPlan.mockRejectedValue(new BusinessRuleError("超出太多", undefined, { need: 40, left: 5, perRound: 10 }));
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20" }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { code: string; details: unknown };
    expect(body.code).toBe("BUSINESS_RULE");
    expect(body.details).toEqual({ need: 40, left: 5, perRound: 10 });
  });

  it("service 抛 ValidationError（HULU_SUSPEND_NOT_YET）→ 422", async () => {
    const { services, hulu } = makeMockServices();
    hulu.createPlan.mockRejectedValue(new ValidationError("HULU_SUSPEND_NOT_YET", "suspendReview"));
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20", suspendReview: true }),
    });

    expect(res.status).toBe(422);
    expect((await res.json() as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("未认证 → 401（owner 写面）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20" }),
    });

    expect(res.status).toBe(401);
    expect(hulu.createPlan).not.toHaveBeenCalled();
  });
});

describe("GET /api/hulu/plans/:id", () => {
  it("返回计划 + 轮次（响应契约可解析）", async () => {
    const { services, hulu } = makeMockServices();
    hulu.getPlan.mockResolvedValue({
      plan: planRow(),
      rounds: [{
        id: "round-1", plan_id: PLAN, user_id: USER, round_no: 1,
        started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
        pages_passed: 0, words_passed: 0, words_total: 2,
      }],
    });
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = huluPlanWithRoundsResponseSchema.parse(body);
    expect(parsed.plan.id).toBe(PLAN);
    expect(parsed.rounds).toHaveLength(1);
    expect(hulu.getPlan).toHaveBeenCalledWith({ userId: USER, planId: PLAN });
  });

  it("路径 id 非 uuid → 400（不调 service）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    await expectValidationError(await app.request("/api/hulu/plans/not-a-uuid", { headers: AUTH_HEADERS }));
    expect(hulu.getPlan).not.toHaveBeenCalled();
  });

  it("service 抛 NotFoundError（跨用户/不存在）→ 404", async () => {
    const { services, hulu } = makeMockServices();
    hulu.getPlan.mockRejectedValue(new NotFoundError("HuluPlan", PLAN));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("NOT_FOUND");
  });

  it("未认证 → 401", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}`);

    expect(res.status).toBe(401);
  });
});

describe("POST /api/hulu/plans/:id/abandon", () => {
  it("放弃成功返回 200 与 abandoned 计划行", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/abandon`, {
      method: "POST", headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(huluPlanRowResponseSchema.parse(body).status).toBe("abandoned");
    expect(hulu.abandonPlan).toHaveBeenCalledWith({ userId: USER, planId: PLAN });
  });

  it("幂等：service 返回已 abandoned 的计划 → 仍 200", async () => {
    const { services, hulu } = makeMockServices();
    hulu.abandonPlan.mockResolvedValue(planRow({ status: "abandoned" }));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/abandon`, {
      method: "POST", headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(huluPlanRowResponseSchema.parse(await res.json()).status).toBe("abandoned");
  });

  it("已 completed → 422 BUSINESS_RULE（409 语义）", async () => {
    const { services, hulu } = makeMockServices();
    hulu.abandonPlan.mockRejectedValue(new BusinessRuleError("计划已完成，无法放弃"));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/abandon`, {
      method: "POST", headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(422);
    expect((await res.json() as { code: string }).code).toBe("BUSINESS_RULE");
  });

  it("跨用户 → 404；路径 id 非 uuid → 400；未认证 → 401", async () => {
    const { services, hulu } = makeMockServices();
    hulu.abandonPlan.mockRejectedValue(new NotFoundError("HuluPlan", PLAN));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/abandon`, { method: "POST", headers: AUTH_HEADERS });
    expect(res.status).toBe(404);

    await expectValidationError(await app.request("/api/hulu/plans/x/abandon", { method: "POST", headers: AUTH_HEADERS }));
    expect(await (await app.request(`/api/hulu/plans/${PLAN}/abandon`, { method: "POST" })).status).toBe(401);
  });
});
