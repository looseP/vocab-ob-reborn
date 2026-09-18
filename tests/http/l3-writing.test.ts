/**
 * 作文子空间 HTTP 面测试（W6，ADR《writing-workspace》§6）。
 *
 * 结构：假服务注入 + 真实 createApp（路由/校验/错误映射全走真件）。
 * 授权矩阵（401/403/CSRF 全量行）由 tests/http/authorization-registry.test.ts 与
 * tests/http/authorization-matrix.test.ts 的注册表驱动测试自动覆盖本批 15 端点。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { BusinessRuleError, ConflictError, InternalConsistencyError, NotFoundError, ValidationError } from "@/errors";
import type { Services } from "@/services";
import { createMockPool } from "../helpers/mock-db";

const mockDb = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mockDb.pool,
  getBatchImportPool: () => mockDb.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
  pool: () => mockDb.pool,
}));

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
  process.env.AGENT_API_TOKENS = "agent-a:test-agent-token";
});
afterAll(() => {
  delete process.env.OWNER_API_TOKEN;
  delete process.env.LOCAL_OWNER_ID;
  delete process.env.AGENT_API_TOKENS;
});

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };
const AGENT_HEADERS = { Authorization: "Bearer test-agent-token", "Content-Type": "application/json" };
const TASK_ID = "00000000-0000-4000-8000-000000000701";
const SHEET_ID = "00000000-0000-4000-8000-000000000801";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const REQUEST_ID = "00000000-0000-4000-8000-000000000901";
const SHA = "a".repeat(64);

function taskDto(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    questionId: QUESTION_ID,
    title: "任务",
    prompt: "自由写作",
    kind: "free",
    direction: "通用",
    status: "active",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function sheetDto(overrides: Record<string, unknown> = {}) {
  return {
    id: SHEET_ID,
    taskId: TASK_ID,
    status: "draft",
    draftVersion: 0,
    revisionNo: null,
    parentSheetId: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    sealedAt: null,
    ...overrides,
  };
}

function feedbackPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    summary: "结构清楚。",
    strengths: ["立场明确"],
    dimensions: {
      task_response: { applicable: true, comment: "回应了题目。" },
      organization: { applicable: true, comment: "结构可辨。" },
      language: { applicable: true, comment: "基本通顺。" },
      expression: { applicable: false, comment: "本稿不评表达风格。" },
    },
    priorities: [],
    ...overrides,
  };
}

function feedbackRecord(overrides: Record<string, unknown> = {}) {
  return {
    feedback: feedbackPayload(),
    version: 1,
    textSha256: SHA,
    lastEditor: "agent-a",
    updatedAt: "2026-09-18T01:00:00.000Z",
    ...overrides,
  };
}

type FakeBundle = {
  l3WritingTasks?: Record<string, unknown>;
  l3WritingSheets?: Record<string, unknown>;
  l3WritingFeedback?: Record<string, unknown>;
};

function makeServices(bundle: FakeBundle): Services {
  return {
    l3WritingTasks: {},
    l3WritingSheets: {},
    l3WritingFeedback: {},
    ...bundle,
  } as unknown as Services;
}

describe("POST /api/l3/writing/tasks（创建；201/200 动态）", () => {
  it("passes the owner id and parsed body through; maps created to 201", async () => {
    const create = vi.fn(async () => ({ task: taskDto(), draft: sheetDto(), created: true }));
    const app = createApp(makeServices({ l3WritingTasks: { create } }));
    const res = await app.request("/api/l3/writing/tasks", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQUEST_ID, kind: "free", direction: "通用" }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith("user-123", expect.objectContaining({ requestId: REQUEST_ID, kind: "free" }));
  });

  it("maps reuse to 200 and rejects unknown fields（strict）", async () => {
    const create = vi.fn(async () => ({ task: taskDto(), draft: null, created: false }));
    const app = createApp(makeServices({ l3WritingTasks: { create } }));
    const reuse = await app.request("/api/l3/writing/tasks", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQUEST_ID, kind: "free", direction: "通用" }),
    });
    expect(reuse.status).toBe(200);
    expect((await reuse.json()).draft).toBeNull();

    const unknown = await app.request("/api/l3/writing/tasks", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQUEST_ID, kind: "free", direction: "通用", ownerId: "hijack" }),
    });
    expect(unknown.status).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("prompt 与 questionId 互斥（422→400 校验层拦截）", async () => {
    const create = vi.fn();
    const app = createApp(makeServices({ l3WritingTasks: { create } }));
    const res = await app.request("/api/l3/writing/tasks", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        requestId: REQUEST_ID, kind: "free", direction: "通用",
        prompt: "题目", questionId: QUESTION_ID,
      }),
    });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("任务读/写路由接线（list/get/patch/archive/restore/revisions）", () => {
  it("GET /tasks 传 query 并回传分页形状", async () => {
    const list = vi.fn(async () => ({ items: [], total: 0, nextCursor: null }));
    const app = createApp(makeServices({ l3WritingTasks: { list } }));
    const res = await app.request("/api/l3/writing/tasks?status=active&limit=20", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith("user-123", expect.objectContaining({ status: "active", limit: 20 }));
  });

  it("GET /tasks/:id 与 revisions 接线（含非法 query 400）", async () => {
    const get = vi.fn(async () => ({ task: taskDto(), draftSummary: null, revisionCount: 0, latestSubmittedSheetId: null }));
    const listRevisions = vi.fn(async () => ({ items: [], total: 0, nextCursor: null }));
    const app = createApp(makeServices({ l3WritingTasks: { get }, l3WritingSheets: { listRevisions } }));
    expect((await app.request(`/api/l3/writing/tasks/${TASK_ID}`, { headers: AUTH_HEADERS })).status).toBe(200);
    expect(get).toHaveBeenCalledWith("user-123", TASK_ID);
    expect((await app.request(`/api/l3/writing/tasks/${TASK_ID}/revisions?limit=20`, { headers: AUTH_HEADERS })).status).toBe(200);
    expect(listRevisions).toHaveBeenCalledWith("user-123", TASK_ID, { limit: 20 });
    // 非法 limit（0 → 违反 min(1)）→ 400。
    expect((await app.request(`/api/l3/writing/tasks/${TASK_ID}/revisions?limit=0`, { headers: AUTH_HEADERS })).status).toBe(400);
  });

  it("PATCH / archive / restore 接线（rename 校验非空）", async () => {
    const rename = vi.fn(async () => taskDto({ title: "新标题" }));
    const archive = vi.fn(async () => taskDto({ status: "archived" }));
    const restore = vi.fn(async () => taskDto());
    const app = createApp(makeServices({ l3WritingTasks: { rename, archive, restore } }));
    const patched = await app.request(`/api/l3/writing/tasks/${TASK_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ title: "新标题" }),
    });
    expect(patched.status).toBe(200);
    expect(rename).toHaveBeenCalledWith("user-123", TASK_ID, { title: "新标题" });

    const empty = await app.request(`/api/l3/writing/tasks/${TASK_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ title: "  " }),
    });
    expect(empty.status).toBe(400);

    expect((await app.request(`/api/l3/writing/tasks/${TASK_ID}/archive`, { method: "POST", headers: AUTH_HEADERS })).status).toBe(200);
    expect((await app.request(`/api/l3/writing/tasks/${TASK_ID}/restore`, { method: "POST", headers: AUTH_HEADERS })).status).toBe(200);
  });
});

describe("稿件路由接线（sheet/drafts/save/submit/discard）", () => {
  it("GET sheet：sealed 且正文可用时组合反馈；draft 时组合为 null 且不读反馈", async () => {
    const getSheet = vi.fn(async () => ({
      sheet: sheetDto({ status: "sealed", revisionNo: 1, sealedAt: "2026-09-18T01:00:00.000Z" }),
      text: "定稿", textSha256: SHA, wordCount: 2, contentStatus: "available", feedback: null,
    }));
    const getFeedback = vi.fn(async () => ({ state: "ready", feedback: feedbackRecord() }));
    const app = createApp(makeServices({ l3WritingSheets: { getSheet }, l3WritingFeedback: { getFeedback } }));
    const res = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(getFeedback).toHaveBeenCalledWith("user-123", TASK_ID, SHEET_ID);
    expect((await res.json()).feedback.version).toBe(1);

    getSheet.mockResolvedValueOnce({
      sheet: sheetDto(), text: "草稿", textSha256: SHA, wordCount: 2, contentStatus: "available", feedback: null,
    });
    const draft = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}`, { headers: AUTH_HEADERS });
    expect((await draft.json()).feedback).toBeNull();
    expect(getFeedback).toHaveBeenCalledTimes(1); // draft 不触发反馈读取
  });

  it("POST drafts：201/200 动态 + parent/seed 组合校验", async () => {
    const createDraft = vi.fn(async () => ({ sheet: sheetDto({ parentSheetId: SHEET_ID }), created: true }));
    const app = createApp(makeServices({ l3WritingSheets: { createDraft } }));
    const created = await app.request(`/api/l3/writing/tasks/${TASK_ID}/drafts`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ parentSheetId: SHEET_ID, seed: "copy" }),
    });
    expect(created.status).toBe(201);
    expect(createDraft).toHaveBeenCalledWith("user-123", TASK_ID, { parentSheetId: SHEET_ID, seed: "copy" });

    const bad = await app.request(`/api/l3/writing/tasks/${TASK_ID}/drafts`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ parentSheetId: null, seed: "copy" }),
    });
    expect(bad.status).toBe(400); // parent=null 时 seed 必须 blank（schema 互斥）
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it("PATCH save / submit / discard 接线（订阅字面严格）", async () => {
    const saveDraft = vi.fn(async () => ({ sheet: sheetDto({ draftVersion: 1 }), textSha256: SHA }));
    const submit = vi.fn(async () => ({ sheet: sheetDto({ status: "sealed", revisionNo: 1 }), attemptId: REQUEST_ID }));
    const discard = vi.fn(async () => sheetDto({ status: "discarded" }));
    const app = createApp(makeServices({ l3WritingSheets: { saveDraft, submit, discard } }));

    const saved = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 0, text: "初稿" }),
    });
    expect(saved.status).toBe(200);
    expect(saveDraft).toHaveBeenCalledWith("user-123", TASK_ID, SHEET_ID, { expectedVersion: 0, text: "初稿" });

    const extra = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 0, text: "x", answers: {} }),
    });
    expect(extra.status).toBe(400); // 专用契约拒绝旧 answers 键（strict）

    const submitted = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/submit`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(submitted.status).toBe(200);
    expect(submit).toHaveBeenCalledWith("user-123", TASK_ID, SHEET_ID, { expectedVersion: 1 });

    const discarded = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/discard`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(discarded.status).toBe(200);
  });
});

describe("反馈路由（owner/agent 双身份 + editor 服务端认定 + 64KiB 前闸）", () => {
  it("agent 读 feedback-context 200；agent 写 feedback 的 editor=agent-a", async () => {
    const getContext = vi.fn(async () => ({
      taskId: TASK_ID, sheetId: SHEET_ID, revisionNo: 1, kind: "free", direction: "通用",
      prompt: "自由写作", text: "定稿", textSha256: SHA, wordCount: 2,
      feedbackVersion: 0, feedbackSchemaVersion: 1,
    }));
    const putFeedback = vi.fn(async () => feedbackRecord());
    const app = createApp(makeServices({ l3WritingFeedback: { getContext, putFeedback } }));

    const ctx = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback-context`, { headers: AGENT_HEADERS });
    expect(ctx.status).toBe(200);
    expect((await ctx.json()).feedbackVersion).toBe(0);

    const put = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, {
      method: "PUT", headers: AGENT_HEADERS,
      body: JSON.stringify({ expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID, feedback: feedbackPayload() }),
    });
    expect(put.status).toBe(200);
    expect(putFeedback).toHaveBeenCalledWith(
      "user-123", TASK_ID, SHEET_ID,
      expect.objectContaining({ expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID }),
      "agent-a",
    );
  });

  it("owner 写 feedback 的 editor=owner；body 冒充 lastEditor 被 strict 拒绝", async () => {
    const putFeedback = vi.fn(async () => feedbackRecord({ lastEditor: "owner" }));
    const app = createApp(makeServices({ l3WritingFeedback: { putFeedback } }));
    const ok = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, {
      method: "PUT", headers: AUTH_HEADERS,
      body: JSON.stringify({ expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID, feedback: feedbackPayload() }),
    });
    expect(ok.status).toBe(200);
    expect(putFeedback).toHaveBeenLastCalledWith("user-123", TASK_ID, SHEET_ID, expect.anything(), "owner");

    const forged = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, {
      method: "PUT", headers: AUTH_HEADERS,
      body: JSON.stringify({
        expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID,
        feedback: feedbackPayload(), lastEditor: "agent-evil",
      }),
    });
    expect(forged.status).toBe(400);
  });

  it("64KiB 上限在完整解析前生效：超大声明长度 → 413 且服务不被调用", async () => {
    const putFeedback = vi.fn();
    const app = createApp(makeServices({ l3WritingFeedback: { putFeedback } }));
    const huge = JSON.stringify({
      expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID,
      feedback: feedbackPayload({ summary: "长".repeat(70_000) }),
    });
    const res = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, {
      method: "PUT", headers: AUTH_HEADERS, body: huge,
    });
    expect(res.status).toBe(413);
    expect(putFeedback).not.toHaveBeenCalled(); // 前闸生效，未进入解析/服务层
  });

  it("业务错误映射：409 带 details.code、422、500 一致性错误原样上行", async () => {
    const putFeedback = vi.fn(async () => {
      throw new ConflictError("feedback version conflict", undefined, {
        code: "FEEDBACK_VERSION_CONFLICT", expectedVersion: 0, actualVersion: 1,
      });
    });
    const app = createApp(makeServices({ l3WritingFeedback: { putFeedback } }));
    const conflict = await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, {
      method: "PUT", headers: AUTH_HEADERS,
      body: JSON.stringify({ expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID, feedback: feedbackPayload() }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).details.code).toBe("FEEDBACK_VERSION_CONFLICT");

    const badAnchor = vi.fn(async () => { throw new BusinessRuleError("anchors mismatch", undefined, { code: "FEEDBACK_ANCHOR_MISMATCH" }); });
    const app422 = createApp(makeServices({ l3WritingFeedback: { putFeedback: badAnchor } }));
    const res422 = await app422.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, {
      method: "PUT", headers: AUTH_HEADERS,
      body: JSON.stringify({ expectedVersion: 0, textSha256: SHA, requestId: REQUEST_ID, feedback: feedbackPayload() }),
    });
    expect(res422.status).toBe(422);

    const inconsistent = vi.fn(async () => { throw new InternalConsistencyError("bad rows", undefined, { code: "WRITING_DATA_INCONSISTENT" }); });
    const appCtx = createApp(makeServices({ l3WritingFeedback: { getContext: inconsistent } }));
    const resCtx = await appCtx.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback-context`, { headers: AGENT_HEADERS });
    expect(resCtx.status).toBe(500);

    const missing = vi.fn(async () => { throw new NotFoundError("WritingSheet", SHEET_ID); });
    const app404 = createApp(makeServices({ l3WritingSheets: { getSheet: missing } }));
    expect((await app404.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}`, { headers: AUTH_HEADERS })).status).toBe(404);

    const invalid = vi.fn(async () => { throw new ValidationError("empty text", "text"); });
    const appV = createApp(makeServices({ l3WritingSheets: { submit: invalid } }));
    expect((await appV.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/submit`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 1 }),
    })).status).toBe(422);
  });

  it("未认证 401（抽样；全量矩阵由注册表驱动测试覆盖）", async () => {
    const app = createApp(makeServices({}));
    expect((await app.request(`/api/l3/writing/tasks`)).status).toBe(401);
    expect((await app.request(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`, { method: "PUT" })).status).toBe(401);
  });
});
