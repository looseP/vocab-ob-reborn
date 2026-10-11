/**
 * 每日捕获 M1 五端点的回归锁（owner-only 口径 + 合同校验 + 输入钳制）。
 *
 * 锁的不是"能返回 200"，而是口径：
 *  - POST：契约先于序列化校验；entryDate 形状对但不是真实日历日 → 400（不进服务层）；
 *  - GET /days：limit 路由内钳制（review-calendar 同款，不进 ops query schema）；
 *  - GET /days/:date 与 /file：非法日期 400；文件响应 text/markdown + no-store；
 *  - 未认证 401（owner-only：agent 读面只有 M3 的 export，设计拍板③）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { todayKeyInDisplayTz } from "@/db/timezone";
import {
  dailyCaptureAbsorbResponseSchema,
  dailyCaptureDayResponseSchema,
  dailyCaptureDaysResponseSchema,
  dailyCaptureEntryResponseSchema,
  dailyCaptureEvidencePackResponseSchema,
  dailyCaptureTypeResponseSchema,
  dailyCaptureTypesResponseSchema,
} from "@/http/daily-capture-response-contract";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;
const ORIGINAL_AGENT_TOKENS = process.env.AGENT_API_TOKENS;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
  process.env.AGENT_API_TOKENS = "agent-a:test-agent-token";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
  process.env.AGENT_API_TOKENS = ORIGINAL_AGENT_TOKENS;
});

const TODAY = todayKeyInDisplayTz();
const USER = "user-123";

const TYPE_ROW = {
  user_id: USER,
  type_key: "phrase",
  label: "词组",
  absorption_hint: "吸收时绑定 L3 语境。",
  sort: 0,
  hidden: false,
  created_at: "2026-10-10T00:00:00.000Z",
};

const ENTRY_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: USER,
  entry_date: TODAY,
  seq: 3,
  entry_type: "phrase",
  content: "harness the power",
  meta: null,
  status: "raw",
  absorption: null,
  created_at: "2026-10-10T01:02:00.000Z",
  hidden_at: null,
};

const DAY_SUMMARY = { date: TODAY, total: 3, raw: 2, reviewed: 1, absorbed: 0 };

/** 读时词信号（与 dailyCaptureWordSignalResponseSchema 对齐）。 */
const SIGNAL_STUB = {
  slug: "harness",
  state: "stub" as const,
  hasDefinition: false,
  l2Promoted: false,
  updatedAt: "2026-10-10T01:00:00.000Z",
};

/** 日视图条目 = 行 + 词信号投影（写路径回执仍只回行，故与 ENTRY_ROW 分开）。 */
const DAY_ENTRY = {
  ...ENTRY_ROW,
  meta: { wordSlugs: ["harness"] },
  wordSignals: [SIGNAL_STUB],
};

const EVIDENCE_PACK = {
  version: 1 as const,
  date: TODAY,
  markdown: "# 每日捕获 · " + TODAY + "\n",
  entries: [
    {
      seq: 3,
      id: ENTRY_ROW.id,
      entry_type: "phrase",
      label: "词组",
      absorption_hint: "吸收时绑定 L3 语境。",
      content: ENTRY_ROW.content,
      status: "raw" as const,
      meta: null,
      created_at: ENTRY_ROW.created_at,
      words: [
        { slug: "harness", title: "harness", lemma: "harness", ipa: null, short_definition: "利用", existing_context_count: 0, signal: SIGNAL_STUB },
      ],
    },
  ],
};

const ABSORB_RESULT = {
  entry: { ...ENTRY_ROW, status: "absorbed" as const, absorption: [
    { action: "bind_l3" as const, target: "l3_context", id: "ctx-1", at: "2026-10-10T09:00:00.000Z", word_slug: "harness" },
  ] },
  receipt: { action: "bind_l3" as const, target: "l3_context", id: "ctx-1", at: "2026-10-10T09:00:00.000Z", word_slug: "harness" },
};

function makeMockServices(overrides: Record<string, unknown> = {}): Services {
  return {
    wordbooks: { getOrCreateDefault: vi.fn(async () => ({ id: WORDBOOK_ID })) },
    dailyCapture: {
      appendEntry: vi.fn(async () => ENTRY_ROW),
      listTypes: vi.fn(async () => [TYPE_ROW]),
      listDays: vi.fn(async () => [DAY_SUMMARY]),
      getDay: vi.fn(async () => ({
        date: TODAY,
        observedAt: "2026-10-11T00:00:00.000Z",
        types: [TYPE_ROW],
        entries: [DAY_ENTRY],
      })),
      getDayFile: vi.fn(async () => ({ date: TODAY, markdown: "# 每日捕获 · " + TODAY + "\n" })),
      getEvidencePack: vi.fn(async () => EVIDENCE_PACK),
      absorbEntry: vi.fn(async () => ABSORB_RESULT),
      patchEntry: vi.fn(async () => ENTRY_ROW),
      createType: vi.fn(async () => TYPE_ROW),
      patchType: vi.fn(async () => TYPE_ROW),
      ...overrides,
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };
const AGENT_HEADERS = { Authorization: "Bearer test-agent-token" };
const WORDBOOK_ID = "33333333-3333-4333-8333-333333333333";

describe("POST /api/daily-capture/entries（轻阻力追加）", () => {
  it("201 + 契约校验；userId 来自鉴权态而非请求体", async () => {
    const services = makeMockServices();
    const res = await createApp(services).request("/api/daily-capture/entries", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ entryType: "phrase", content: "harness the power" }),
    });

    expect(res.status).toBe(201);
    const body = dailyCaptureEntryResponseSchema.parse(await res.json());
    expect(body.seq).toBe(3);
    expect(services.dailyCapture.appendEntry).toHaveBeenCalledWith({
      userId: USER,
      entryType: "phrase",
      content: "harness the power",
      meta: null,
      entryDate: undefined,
    });
  });

  it("meta 与 entryDate 透传", async () => {
    const services = makeMockServices();
    await createApp(services).request("/api/daily-capture/entries", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        entryType: "sentence",
        content: "She harnessed her frustration.",
        meta: { translation: "她把挫败感转化为产出。", wordSlugs: ["harness"] },
        entryDate: "2026-10-09",
      }),
    });
    expect(services.dailyCapture.appendEntry).toHaveBeenCalledWith(
      expect.objectContaining({ entryDate: "2026-10-09", meta: { translation: "她把挫败感转化为产出。", wordSlugs: ["harness"] } }),
    );
  });

  it("body 非法 400（VALIDATION_ERROR）；entryDate 形状对但非真实日历日 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const empty = await app.request("/api/daily-capture/entries", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ entryType: "phrase", content: "   " }),
    });
    expect(empty.status).toBe(400);

    const fakeDate = await app.request("/api/daily-capture/entries", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ entryType: "phrase", content: "x", entryDate: "2026-13-99" }),
    });
    expect(fakeDate.status).toBe(400);
    expect(services.dailyCapture.appendEntry).not.toHaveBeenCalled();
  });
});

describe("GET /api/daily-capture/types|days|days/:date|days/:date/file", () => {
  it("types 只读透传（零写；空注册表回空数组）", async () => {
    const services = makeMockServices({ listTypes: vi.fn(async () => []) });
    const res = await createApp(services).request("/api/daily-capture/types", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = dailyCaptureTypesResponseSchema.parse(await res.json());
    expect(body.types).toEqual([]);
  });

  it("days 聚合：limit 钳制 [1,180]，缺省 30", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/daily-capture/days?limit=9999", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = dailyCaptureDaysResponseSchema.parse(await res.json());
    expect(body.days).toEqual([DAY_SUMMARY]);
    expect(services.dailyCapture.listDays).toHaveBeenLastCalledWith(USER, 180);
    await app.request("/api/daily-capture/days", { headers: AUTH_HEADERS });
    expect(services.dailyCapture.listDays).toHaveBeenLastCalledWith(USER, 30);
    await app.request("/api/daily-capture/days?limit=0", { headers: AUTH_HEADERS });
    expect(services.dailyCapture.listDays).toHaveBeenLastCalledWith(USER, 1);
  });

  it("days/:date 非真实日历日 400 且不进服务层", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    expect((await app.request("/api/daily-capture/days/2026-13-99", { headers: AUTH_HEADERS })).status).toBe(400);
    expect((await app.request("/api/daily-capture/days/not-a-date", { headers: AUTH_HEADERS })).status).toBe(400);
    expect(services.dailyCapture.getDay).not.toHaveBeenCalled();

    const res = await app.request(`/api/daily-capture/days/${TODAY}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = dailyCaptureDayResponseSchema.parse(await res.json());
    expect(body.entries).toHaveLength(1);
    // 读时投影两项：整响应一个投影时钟 + 逐词信号（路由不重算，原样透传）
    expect(body.observedAt).toBe("2026-10-11T00:00:00.000Z");
    expect(body.entries[0].wordSignals).toEqual([SIGNAL_STUB]);
  });

  it("days/:date 透传 gone 信号（updatedAt null）—— 词已不在是合法投影", async () => {
    const services = makeMockServices({
      getDay: vi.fn(async () => ({
        date: TODAY,
        observedAt: "2026-10-11T00:00:00.000Z",
        types: [TYPE_ROW],
        entries: [
          {
            ...DAY_ENTRY,
            wordSignals: [
              { slug: "harness", state: "gone", hasDefinition: false, l2Promoted: false, updatedAt: null },
            ],
          },
        ],
      })),
    });
    const res = await createApp(services).request(`/api/daily-capture/days/${TODAY}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);

    const body = dailyCaptureDayResponseSchema.parse(await res.json());
    expect(body.entries[0].wordSignals[0]).toEqual({
      slug: "harness",
      state: "gone",
      hasDefinition: false,
      l2Promoted: false,
      updatedAt: null,
    });
  });

  it("days/:date/file 返回 text/markdown + no-store（捕获窗复制按钮数据源）；非法日期 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request(`/api/daily-capture/days/${TODAY}/file`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("# 每日捕获");

    const badDate = await app.request("/api/daily-capture/days/2026-13-99/file", { headers: AUTH_HEADERS });
    expect(badDate.status).toBe(400);
    expect(services.dailyCapture.getDayFile).toHaveBeenCalledTimes(1); // 坏日期不进服务层
  });

  it("未认证 401（owner-only 读面，agent 无权限）", async () => {
    const res = await createApp(makeMockServices()).request("/api/daily-capture/days");
    expect(res.status).toBe(401);
  });
});

describe("M2 回顾面：PATCH /entries/:id + POST /types + PATCH /types/:key", () => {
  it("PATCH /entries/:id：流转 + 置要透传，200 契约；空 body 400 不进服务层", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const ok = await app.request(`/api/daily-capture/entries/${ENTRY_ROW.id}`, {
      method: "PATCH",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ status: "reviewed", important: true }),
    });
    expect(ok.status).toBe(200);
    expect(services.dailyCapture.patchEntry).toHaveBeenCalledWith(USER, ENTRY_ROW.id, {
      status: "reviewed",
      important: true,
    });
    dailyCaptureEntryResponseSchema.parse(await ok.json());

    const empty = await app.request(`/api/daily-capture/entries/${ENTRY_ROW.id}`, {
      method: "PATCH",
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(services.dailyCapture.patchEntry).toHaveBeenCalledTimes(1);
  });

  it("POST /types：201 契约；typeKey 形状非法 400 不进服务层", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const created = await app.request("/api/daily-capture/types", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ typeKey: "slang", label: "俚语" }),
    });
    expect(created.status).toBe(201);
    expect(services.dailyCapture.createType).toHaveBeenCalledWith(USER, { typeKey: "slang", label: "俚语" });
    dailyCaptureTypeResponseSchema.parse(await created.json());

    const bad = await app.request("/api/daily-capture/types", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ typeKey: "Slang Key", label: "俚语" }),
    });
    expect(bad.status).toBe(400);
    expect(services.dailyCapture.createType).toHaveBeenCalledTimes(1);
  });

  it("PATCH /types/:key：改名/隐藏透传，200 契约；空 body 400 不进服务层", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const patched = await app.request("/api/daily-capture/types/slang", {
      method: "PATCH",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ label: "俚语", hidden: true }),
    });
    expect(patched.status).toBe(200);
    expect(services.dailyCapture.patchType).toHaveBeenCalledWith(USER, "slang", { label: "俚语", hidden: true });
    dailyCaptureTypeResponseSchema.parse(await patched.json());

    const empty = await app.request("/api/daily-capture/types/slang", {
      method: "PATCH",
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(services.dailyCapture.patchType).toHaveBeenCalledTimes(1);
  });

  it("M2 写面同样 owner-only：未认证 401", async () => {
    const app = createApp(makeMockServices());
    expect((await app.request(`/api/daily-capture/entries/${ENTRY_ROW.id}`, { method: "PATCH", body: "{}" })).status).toBe(401);
    expect((await app.request("/api/daily-capture/types", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request("/api/daily-capture/types/slang", { method: "PATCH", body: "{}" })).status).toBe(401);
  });
});

describe("M3 吸收侧：GET /days/:date/export（agent 唯一读面）+ POST /entries/:id/absorb", () => {
  it("owner 导出证据包：markdown + 结构化条目（含关联词语境计数）", async () => {
    const services = makeMockServices();
    const res = await createApp(services).request(`/api/daily-capture/days/${TODAY}/export`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = dailyCaptureEvidencePackResponseSchema.parse(await res.json());
    expect(body.version).toBe(1);
    expect(body.markdown).toContain("# 每日捕获");
    expect(body.entries[0].words[0].existing_context_count).toBe(0);
    // 词信号随关联词同出（agent 判「释义是否已补/是否已晋升 L2」的依据）
    expect(body.entries[0].words[0].signal).toEqual(SIGNAL_STUB);
  });

  it("agent bearer 可读证据包（唯一读面）；未认证 401；坏日期 400", async () => {
    const app = createApp(makeMockServices());
    const agentRes = await app.request(`/api/daily-capture/days/${TODAY}/export`, { headers: AGENT_HEADERS });
    expect(agentRes.status).toBe(200);
    expect((await app.request(`/api/daily-capture/days/${TODAY}/export`)).status).toBe(401);
    expect((await app.request("/api/daily-capture/days/2026-13-99/export", { headers: AUTH_HEADERS })).status).toBe(400);
  });

  it("采纳 bind_l3 提案：200 契约（entry + receipt）；无需词书解析", async () => {
    const services = makeMockServices();
    const res = await createApp(services).request(`/api/daily-capture/entries/${ENTRY_ROW.id}/absorb`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        action: "bind_l3",
        wordSlug: "harness",
        payload: { contextText: "She harnessed her frustration." },
      }),
    });
    expect(res.status).toBe(200);
    const body = dailyCaptureAbsorbResponseSchema.parse(await res.json());
    expect(body.receipt.target).toBe("l3_context");
    expect(body.entry.status).toBe("absorbed");
    expect(services.wordbooks.getOrCreateDefault).not.toHaveBeenCalled();
  });

  it("采纳 add_word 且缺 wordbookId → 路由缺省解析默认词书", async () => {
    const services = makeMockServices();
    await createApp(services).request(`/api/daily-capture/entries/${ENTRY_ROW.id}/absorb`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ action: "add_word", wordSlug: "harness" }),
    });
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.dailyCapture.absorbEntry).toHaveBeenCalledWith(
      expect.objectContaining({ wordbookId: WORDBOOK_ID, action: "add_word", wordSlug: "harness" }),
    );
  });

  it("未知 action 400；未认证 401", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const bad = await app.request(`/api/daily-capture/entries/${ENTRY_ROW.id}/absorb`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ action: "delete_everything" }),
    });
    expect(bad.status).toBe(400);
    expect(services.dailyCapture.absorbEntry).not.toHaveBeenCalled();
    const unauth = await app.request(`/api/daily-capture/entries/${ENTRY_ROW.id}/absorb`, {
      method: "POST",
      body: JSON.stringify({ action: "none" }),
    });
    expect(unauth.status).toBe(401);
  });
});
