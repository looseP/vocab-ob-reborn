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
import { BusinessRuleError, ConflictError, HuluPageAliveMismatchError, NotFoundError, ValidationError } from "@/errors";
import type { Services } from "@/services";
import {
  huluPageResponseSchema,
  huluPlanRowResponseSchema,
  huluPlanWithRoundsResponseSchema,
  huluRoundRowResponseSchema,
} from "@/http/hulu-response-contract";
import type {
  HuluPagePayload,
  HuluPageWordItem,
  HuluPlanRow,
  HuluPlanSummary,
  HuluPlanWithRounds,
  HuluRoundRow,
} from "@/domain/hulu-sprint";
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
    status: "active", protocol_version: "v2", include_new_words: false,
    suspend_review: false, suspend_snapshot: null,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}

/** 出参摘要（P1 裁剪）：全量 word_ids / suspend_snapshot 折叠成计数。 */
function planSummary(overrides: Partial<HuluPlanSummary> = {}): HuluPlanSummary {
  return {
    id: PLAN, user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
    target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_count: 2,
    status: "active", protocol_version: "v2", include_new_words: false,
    suspend_review: false, suspended_count: 0,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}

function roundRow(overrides: Partial<HuluRoundRow> = {}): HuluRoundRow {
  return {
    id: "round-1", plan_id: PLAN, user_id: USER, round_no: 1,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
    kind: "recall", word_set_fingerprint: null,
    pages_passed: 0, words_passed: 0, words_total: 2,
    ...overrides,
  };
}

/** 页载荷词卡桩（R10 扩字段后须给全 16 列；形状照 findHuluPageWords 的返回）。 */
function pageWordItem(overrides: Partial<HuluPageWordItem> & { id: string }): HuluPageWordItem {
  return {
    slug: overrides.id,
    title: overrides.id,
    lemma: overrides.id,
    ipa: null,
    pos: null,
    cefr: null,
    short_definition: null,
    core_definitions: [],
    definition_md: "",
    examples: [],
    prototype_text: null,
    mnemonic_text: null,
    mnemonic_type: null,
    semantic_chain: null,
    ...overrides,
  };
}

function makeMockServices() {
  const hulu = {
    createPlan: vi.fn(async (): Promise<HuluPlanSummary> => planSummary()),
    getPlan: vi.fn(async (): Promise<HuluPlanWithRounds> => ({ plan: planSummary(), rounds: [] })),
    getPlanPage: vi.fn(async (): Promise<HuluPagePayload> => ({
      pageIndex: 0, pages: 1, total: 2, alive: 2,
      items: [
        pageWordItem({
          id: "w-1", slug: "alleviate", title: "alleviate", lemma: "alleviate",
          ipa: "/əˈliːvieɪt/", pos: "v.", cefr: "B2", short_definition: "减轻",
          mnemonic_text: "a+lev+iate", mnemonic_type: "词根",
          core_definitions: [{ sense: "减轻", en: "alleviate", priority: 1, tags: ["core"] }],
          definition_md: "1. 减轻", examples: [{ text: "It alleviates pain." }],
          prototype_text: "make lighter", semantic_chain: "lev（轻）→ alleviate",
        }),
        pageWordItem({ id: "w-2", slug: "bravo", title: "bravo", lemma: "bravo", short_definition: "好" }),
      ],
    })),
    startRound: vi.fn(async (): Promise<HuluRoundRow> => roundRow()),
    settlePage: vi.fn(async (): Promise<HuluRoundRow> => roundRow({ pages_passed: 1, words_passed: 18 })),
    finishRound: vi.fn(async (): Promise<HuluRoundRow> => roundRow({ ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 3600 })),
    abandonPlan: vi.fn(async (): Promise<HuluPlanSummary> => planSummary({ status: "abandoned", ended_at: "2026-10-07T00:00:00Z" })),
  };
  return { services: { hulu } as unknown as Services, hulu };
}

async function expectValidationError(response: Response, status = 400) {
  expect(response.status).toBe(status);
  const body = await response.json() as { code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
}

describe("hulu HTTP routes — 注册表同步", () => {
  it("路由文件的七条端点与 operations 注册表逐条一致", async () => {
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
      "GET /api/hulu/plans/:id/pages/:no",
      "POST /api/hulu/plans",
      "POST /api/hulu/plans/:id/abandon",
      "POST /api/hulu/plans/:id/rounds",
      "POST /api/hulu/plans/:id/rounds/:no/finish",
      "POST /api/hulu/plans/:id/rounds/:no/pages",
    ]);
    expect(registry).toEqual(source);
  });

  it("七条端点的 operationId / 状态码 / 角色与定稿一致", () => {
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

    // P1 页载荷：读面（agent 可读，同 getHuluPlan）
    const page = byId.get("getHuluPlanPage")!;
    expect(page.method).toBe("get");
    expect(page.path).toBe("/api/hulu/plans/:id/pages/:no");
    expect(page.minRole).toBe("agent");
    expect(page.csrf).toBe("none");
    expect(page.response.status).toBe(200);

    // P1 轮次开始：写面（owner），恒 201（幂等返回既有轮也走 201）
    const start = byId.get("startHuluRound")!;
    expect(start.method).toBe("post");
    expect(start.path).toBe("/api/hulu/plans/:id/rounds");
    expect(start.minRole).toBe("owner");
    expect(start.csrf).toBe("sessionMutation");
    expect(start.response.status).toBe(201);

    const settle = byId.get("settleHuluPage")!;
    expect(settle.method).toBe("post");
    expect(settle.path).toBe("/api/hulu/plans/:id/rounds/:no/pages");
    expect(settle.minRole).toBe("owner");
    expect(settle.csrf).toBe("sessionMutation");
    expect(settle.response.status).toBe(200);

    const finish = byId.get("finishHuluRound")!;
    expect(finish.method).toBe("post");
    expect(finish.path).toBe("/api/hulu/plans/:id/rounds/:no/finish");
    expect(finish.minRole).toBe("owner");
    expect(finish.csrf).toBe("sessionMutation");
    expect(finish.response.status).toBe(200);

    const abandon = byId.get("abandonHuluPlan")!;
    expect(abandon.method).toBe("post");
    expect(abandon.path).toBe("/api/hulu/plans/:id/abandon");
    expect(abandon.minRole).toBe("owner");
    expect(abandon.csrf).toBe("sessionMutation");
    expect(abandon.response.status).toBe(200);
  });

  it("响应契约是 .strict()（多余字段被拒）", () => {
    const row = planSummary();
    expect(huluPlanRowResponseSchema.safeParse(row).success).toBe(true);
    expect(huluPlanRowResponseSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
    // 契约里没有任何 FSRS 字段（结构性的零 FSRS）
    for (const key of ["stability", "difficulty", "retrievability", "due_at", "state"]) {
      expect(huluPlanRowResponseSchema.safeParse({ ...row, [key]: 1 }).success).toBe(false);
    }
  });

  it("P1 裁剪：计划出参不含全量 word_ids / suspend_snapshot，只给计数", () => {
    // 契约层：把全量字段塞回去会被 .strict() 拒
    const row = planSummary();
    expect(huluPlanRowResponseSchema.safeParse({ ...row, word_ids: ["w-1"] }).success).toBe(false);
    expect(huluPlanRowResponseSchema.safeParse({ ...row, suspend_snapshot: { "w-1": "new" } }).success).toBe(false);
    // 计数在契约里（前端算页数/显示挂起状态所需）
    expect(huluPlanRowResponseSchema.safeParse(row).success).toBe(true);
    expect(huluPlanRowResponseSchema.safeParse({ ...row, word_count: "2" }).success).toBe(false);
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

  it("service 抛 ValidationError（入参越界）→ 422", async () => {
    // P2 起 suspendReview 已接线，不再是拒绝路径；此处用仍会抛 ValidationError 的
    // 入参越界（service 侧的区间复验）验证同一条错误映射。
    const { services, hulu } = makeMockServices();
    hulu.createPlan.mockRejectedValue(new ValidationError("targetRounds must be an integer between 2 and 8", "targetRounds"));
    const app = createApp(services);

    const res = await app.request("/api/hulu/plans", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20" }),
    });

    expect(res.status).toBe(422);
    expect((await res.json() as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("suspendReview 原样透传给 service（P2 接线：开关只能创建时设定）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    await app.request("/api/hulu/plans", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WB, examDate: "2026-12-20", suspendReview: true }),
    });

    expect(hulu.createPlan).toHaveBeenCalledWith(expect.objectContaining({ suspendReview: true }));
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
      plan: planSummary(),
      rounds: [roundRow()],
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
    hulu.abandonPlan.mockResolvedValue(planSummary({ status: "abandoned" }));
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

describe("GET /api/hulu/plans/:id/pages/:no — 页载荷（R4，只读）", () => {
  it("返回本页切片载荷（响应契约可解析）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/pages/0`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = huluPageResponseSchema.parse(body);
    expect(parsed.pageIndex).toBe(0);
    expect(parsed.total).toBe(2);
    expect(parsed.alive).toBe(parsed.items.length);
    expect(hulu.getPlanPage).toHaveBeenCalledWith({ userId: USER, planId: PLAN, pageIndex: 0 });
  });

  it("R10：卡面全字段随页载荷带下（五层数据一次到位，单卡路径因此零请求）", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/pages/0`, { headers: AUTH_HEADERS });
    const parsed = huluPageResponseSchema.parse(await res.json());
    const first = parsed.items[0]!;

    // Tier0 / 义项 / 助记锚 / 例句 / Tier2 —— 五层各自的字段都在
    expect(first.short_definition).toBe("减轻");
    expect(first.core_definitions).toEqual([
      { sense: "减轻", en: "alleviate", priority: 1, tags: ["core"] },
    ]);
    expect(first.definition_md).toBe("1. 减轻");
    expect(first.mnemonic_text).toBe("a+lev+iate");
    expect(first.mnemonic_type).toBe("词根");
    expect(first.examples).toEqual([{ text: "It alleviates pain." }]);
    expect(first.semantic_chain).toBe("lev（轻）→ alleviate");
    expect(first.prototype_text).toBe("make lighter");
    expect(first.cefr).toBe("B2");
    // 字段清单是 15 列（R10）——多一列少一列都在这里被钉住
    expect(Object.keys(first).sort()).toEqual([
      "cefr", "core_definitions", "definition_md", "examples", "id", "ipa",
      "lemma", "mnemonic_text", "mnemonic_type", "pos", "prototype_text",
      "semantic_chain", "short_definition", "slug", "title",
    ]);
  });

  it("越界页由 service 抛 NotFoundError → 404", async () => {
    const { services, hulu } = makeMockServices();
    hulu.getPlanPage.mockRejectedValue(new NotFoundError("HuluPlanPage", `${PLAN}:99`));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/pages/99`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("NOT_FOUND");
  });

  it("路径非法（planId 非 uuid / 页号非数字 / 页号为负）→ 400，不调 service", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    await expectValidationError(await app.request("/api/hulu/plans/not-a-uuid/pages/0", { headers: AUTH_HEADERS }));
    await expectValidationError(await app.request(`/api/hulu/plans/${PLAN}/pages/abc`, { headers: AUTH_HEADERS }));
    await expectValidationError(await app.request(`/api/hulu/plans/${PLAN}/pages/-1`, { headers: AUTH_HEADERS }));
    expect(hulu.getPlanPage).not.toHaveBeenCalled();
  });

  it("未认证 → 401", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);

    expect((await app.request(`/api/hulu/plans/${PLAN}/pages/0`)).status).toBe(401);
  });
});

describe("POST /api/hulu/plans/:id/rounds — 开始轮次", () => {
  it("开始成功返回 201 与轮次行（响应契约可解析）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const parsed = huluRoundRowResponseSchema.parse(await res.json());
    expect(parsed.round_no).toBe(1);
    expect(hulu.startRound).toHaveBeenCalledWith({ userId: USER, planId: PLAN, startedAt: undefined });
  });

  it("startedAt 原样透传（service 侧夹取）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ startedAt: "2026-10-06T00:00:00.000Z" }),
    });

    expect(res.status).toBe(201);
    expect(hulu.startRound).toHaveBeenCalledWith({
      userId: USER, planId: PLAN, startedAt: "2026-10-06T00:00:00.000Z",
    });
  });

  it("startedAt 形状非法 → 400，不调 service", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    await expectValidationError(await app.request(`/api/hulu/plans/${PLAN}/rounds`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ startedAt: "yesterday" }),
    }));
    expect(hulu.startRound).not.toHaveBeenCalled();
  });

  it("已达目标轮数 → 409 CONFLICT", async () => {
    const { services, hulu } = makeMockServices();
    hulu.startRound.mockRejectedValue(new ConflictError("已达目标轮数，无法开始新一轮"));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("CONFLICT");
  });

  it("跨用户 → 404；路径 id 非 uuid → 400；未认证 → 401", async () => {
    const { services, hulu } = makeMockServices();
    hulu.startRound.mockRejectedValue(new NotFoundError("HuluPlan", PLAN));
    const app = createApp(services);

    expect((await app.request(`/api/hulu/plans/${PLAN}/rounds`, {
      method: "POST", headers: AUTH_HEADERS, body: "{}",
    })).status).toBe(404);
    await expectValidationError(await app.request("/api/hulu/plans/x/rounds", {
      method: "POST", headers: AUTH_HEADERS, body: "{}",
    }));
    expect((await app.request(`/api/hulu/plans/${PLAN}/rounds`, { method: "POST" })).status).toBe(401);
  });
});

describe("POST /api/hulu/plans/:id/rounds/:no/pages — 页结算（R7）", () => {
  it("结算成功返回 200 与更新后的轮次行", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds/1/pages`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ pageIndex: 0, passed: 18, total: 20 }),
    });

    expect(res.status).toBe(200);
    const parsed = huluRoundRowResponseSchema.parse(await res.json());
    expect(parsed.pages_passed).toBe(1);
    expect(hulu.settlePage).toHaveBeenCalledWith({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 18, total: 20,
    });
  });

  it("不过闸 → 422 VALIDATION_ERROR（服务端复验）", async () => {
    const { services, hulu } = makeMockServices();
    hulu.settlePage.mockRejectedValue(new ValidationError("本页未达闸门，不能结算", "passed"));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds/1/pages`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ pageIndex: 0, passed: 12, total: 20 }),
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { code: string }).code).toBe("VALIDATION_ERROR");
  });

  it("D1：total/alive 不符 → 422 且 code 是 HULU_PAGE_ALIVE_MISMATCH（前端据此自动重取）", async () => {
    const { services, hulu } = makeMockServices();
    hulu.settlePage.mockRejectedValue(new HuluPageAliveMismatchError("total 与本页存活词数不符", {
      total: 20, alive: 18, pageIndex: 0,
    }));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds/1/pages`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ pageIndex: 0, passed: 18, total: 20 }),
    });

    // HTTP 语义不变（仍 422），只有机器码变了
    expect(res.status).toBe(422);
    const body = await res.json() as { code: string; error: string; details?: unknown };
    expect(body.code).toBe("HULU_PAGE_ALIVE_MISMATCH");
    expect(body.error).toBe("total 与本页存活词数不符");
    // details 带出 { total, alive, pageIndex }，便于前端/日志归因
    expect(body.details).toMatchObject({ total: 20, alive: 18, pageIndex: 0 });
  });

  it("跳页 → 409 CONFLICT", async () => {
    const { services, hulu } = makeMockServices();
    hulu.settlePage.mockRejectedValue(new ConflictError("页结算被拒绝：跳页"));
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds/1/pages`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ pageIndex: 3, passed: 20, total: 20 }),
    });

    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("CONFLICT");
  });

  it("请求形状非法（负数 / 缺字段 / 非整数）→ 400，不调 service", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const bad = [
      { passed: 1, total: 1 },                        // 缺 pageIndex
      { pageIndex: -1, passed: 1, total: 1 },         // 页号负
      { pageIndex: 0, passed: -1, total: 1 },         // 通过数负
      { pageIndex: 0, passed: 1, total: 1.5 },        // 非整数
      { pageIndex: 0, passed: 1 },                    // 缺 total
    ];
    for (const payload of bad) {
      await expectValidationError(await app.request(`/api/hulu/plans/${PLAN}/rounds/1/pages`, {
        method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(payload),
      }));
    }
    expect(hulu.settlePage).not.toHaveBeenCalled();
  });

  it("路径轮号非数字 → 400；未认证 → 401", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    await expectValidationError(await app.request(`/api/hulu/plans/${PLAN}/rounds/x/pages`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ pageIndex: 0, passed: 0, total: 0 }),
    }));
    expect(hulu.settlePage).not.toHaveBeenCalled();
    expect((await app.request(`/api/hulu/plans/${PLAN}/rounds/1/pages`, { method: "POST" })).status).toBe(401);
  });
});

describe("POST /api/hulu/plans/:id/rounds/:no/finish — 轮收尾", () => {
  it("收尾成功返回 200 与轮次行（含 elapsed_seconds）", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/hulu/plans/${PLAN}/rounds/1/finish`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const parsed = huluRoundRowResponseSchema.parse(await res.json());
    expect(parsed.elapsed_seconds).toBe(3600);
    expect(hulu.finishRound).toHaveBeenCalledWith({ userId: USER, planId: PLAN, roundNo: 1, endedAt: undefined });
  });

  it("endedAt 原样透传", async () => {
    const { services, hulu } = makeMockServices();
    const app = createApp(services);

    await app.request(`/api/hulu/plans/${PLAN}/rounds/1/finish`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ endedAt: "2026-10-06T01:00:00.000Z" }),
    });

    expect(hulu.finishRound).toHaveBeenCalledWith({
      userId: USER, planId: PLAN, roundNo: 1, endedAt: "2026-10-06T01:00:00.000Z",
    });
  });

  it("轮次不存在 → 404；路径轮号非法 → 400；未认证 → 401", async () => {
    const { services, hulu } = makeMockServices();
    hulu.finishRound.mockRejectedValue(new NotFoundError("HuluRound", `${PLAN}:9`));
    const app = createApp(services);

    expect((await app.request(`/api/hulu/plans/${PLAN}/rounds/9/finish`, {
      method: "POST", headers: AUTH_HEADERS, body: "{}",
    })).status).toBe(404);
    await expectValidationError(await app.request(`/api/hulu/plans/${PLAN}/rounds/x/finish`, {
      method: "POST", headers: AUTH_HEADERS, body: "{}",
    }));
    expect((await app.request(`/api/hulu/plans/${PLAN}/rounds/1/finish`, { method: "POST" })).status).toBe(401);
  });
});
