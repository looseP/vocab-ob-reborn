/**
 * 学习笔记（N1）HTTP 面测试：路由/校验/错误映射全走真件（假服务注入）。
 *
 * 授权矩阵（401/403/CSRF 全量行）由 tests/http/authorization-registry.test.ts 与
 * authorization-matrix.test.ts 的注册表驱动测试自动覆盖本批 12 端点；
 * 本文件验证合同行为、固定路径优先与错误映射。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { Services } from "@/services";
import { L3StudyNoteService, computeNoteCreateHash } from "@/services/l3-study-notes.service";
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
const NOTE_ID = "00000000-0000-4000-8000-000000000101";
const TOPIC_ID = "00000000-0000-4000-8000-000000000111";
const REQ = "00000000-0000-4000-8000-000000000121";
const SOURCE_ID = "00000000-0000-4000-8000-000000000201";

function noteSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID, title: "标题", venues: ["reading_choice"], pinned: false, status: "active",
    version: 1, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function noteDto(overrides: Record<string, unknown> = {}) {
  return { ...noteSummary(), bodyMd: "正文", references: [], ...overrides };
}

function topicDto(overrides: Record<string, unknown> = {}) {
  return {
    id: TOPIC_ID, questionType: "reading_choice", title: "专题", status: "active",
    version: 1, memberCount: 0, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function savePayload(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: 1, requestId: REQ, title: "标题", bodyMd: "正文",
    venues: ["reading_choice"], pinned: false, status: "active", references: [],
    ...overrides,
  };
}

function makeServices(bundle: {
  studyNotes?: Record<string, unknown>;
  studyReferences?: Record<string, unknown>;
}): Services {
  return { studyNotes: {}, studyReferences: {}, ...bundle } as unknown as Services;
}

describe("POST /api/l3/study-notes（创建；201/200 动态）", () => {
  it("owner 创建：201，传 userId 与解析后的 body", async () => {
    const create = vi.fn(async () => ({ item: noteDto(), created: true }));
    const app = createApp(makeServices({ studyNotes: { create } }));
    const res = await app.request("/api/l3/study-notes", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, venue: "reading_choice" }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith("user-123", { requestId: REQ, venue: "reading_choice" });
  });

  it("幂等复用 200；未知字段（strict）400", async () => {
    const create = vi.fn(async () => ({ item: noteDto(), created: false }));
    const app = createApp(makeServices({ studyNotes: { create } }));
    const reuse = await app.request("/api/l3/study-notes", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, venue: "cloze" }),
    });
    expect(reuse.status).toBe(200);

    const unknown = await app.request("/api/l3/study-notes", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, venue: "cloze", userId: "hijack" }),
    });
    expect(unknown.status).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/l3/study-notes（列表；venue 必填 + 互斥）", () => {
  it("查询参数透传（q/status/pinned/topicId/limit）", async () => {
    const list = vi.fn(async () => ({ items: [noteSummary()], total: 1, nextCursor: null }));
    const app = createApp(makeServices({ studyNotes: { list } }));
    const res = await app.request(
      `/api/l3/study-notes?venue=reading_choice&q=fox&status=active&pinned=1&topicId=${TOPIC_ID}&limit=20`,
      { headers: AUTH_HEADERS },
    );
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith("user-123", expect.objectContaining({
      venue: "reading_choice", q: "fox", status: "active", pinned: true, topicId: TOPIC_ID, limit: 20,
    }));
  });

  it("缺 venue 400；topicId 与 unfiled 互斥 400", async () => {
    const list = vi.fn();
    const app = createApp(makeServices({ studyNotes: { list } }));
    expect((await app.request("/api/l3/study-notes", { headers: AUTH_HEADERS })).status).toBe(400);
    expect(
      (await app.request(
        `/api/l3/study-notes?venue=cloze&topicId=${TOPIC_ID}&unfiled=1`,
        { headers: AUTH_HEADERS },
      )).status,
    ).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("固定路径优先与详情路由", () => {
  it("GET /study-notes/reference-targets 命中 search（不被 /:noteId 捕获）", async () => {
    const search = vi.fn(async () => ({ items: [], total: 0, nextCursor: null }));
    const get = vi.fn();
    const app = createApp(makeServices({ studyReferences: { search }, studyNotes: { get } }));
    const res = await app.request(
      "/api/l3/study-notes/reference-targets?kind=source&q=abc",
      { headers: AUTH_HEADERS },
    );
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledWith("user-123", expect.objectContaining({ kind: "source", q: "abc" }));
    expect(get).not.toHaveBeenCalled();
  });

  it("POST /study-notes/reference-preview 命中 preview（只读；422 直传）", async () => {
    const preview = vi.fn(async () => ({
      preview: {
        target: { kind: "source", sourceId: SOURCE_ID },
        displaySnapshot: { kind: "source", title: "T", excerpt: "E" },
        liveTitle: "T",
      },
    }));
    const app = createApp(makeServices({ studyReferences: { preview } }));
    const res = await app.request("/api/l3/study-notes/reference-preview", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ kind: "source", sourceId: SOURCE_ID }),
    });
    expect(res.status).toBe(200);
    expect(preview).toHaveBeenCalledWith("user-123", { kind: "source", sourceId: SOURCE_ID });

    const bad = await app.request("/api/l3/study-notes/reference-preview", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ kind: "source" }),
    });
    expect(bad.status).toBe(400);
  });

  it("GET /study-notes/backlinks 命中 backlinks；GET /study-notes/:noteId 命中 get", async () => {
    const backlinks = vi.fn(async () => ({ items: [], total: 0, nextCursor: null }));
    const get = vi.fn(async () => ({ item: noteDto() }));
    const app = createApp(makeServices({ studyReferences: { backlinks }, studyNotes: { get } }));
    const back = await app.request(
      `/api/l3/study-notes/backlinks?targetKind=source&targetId=${SOURCE_ID}`,
      { headers: AUTH_HEADERS },
    );
    expect(back.status).toBe(200);
    expect(backlinks).toHaveBeenCalledWith("user-123", expect.objectContaining({ targetKind: "source", targetId: SOURCE_ID }));

    const detail = await app.request(`/api/l3/study-notes/${NOTE_ID}`, { headers: AUTH_HEADERS });
    expect(detail.status).toBe(200);
    expect(get).toHaveBeenCalledWith("user-123", NOTE_ID);
  });
});

describe("PUT /api/l3/study-notes/:noteId（保存与错误映射）", () => {
  it("保存透传；service 冲突 409 / 缺失 404 / 校验 422 直传", async () => {
    const save = vi.fn(async () => ({ item: noteDto({ version: 2 }) }));
    const app = createApp(makeServices({ studyNotes: { save } }));
    const ok = await app.request(`/api/l3/study-notes/${NOTE_ID}`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify(savePayload()),
    });
    expect(ok.status).toBe(200);
    expect(save).toHaveBeenCalledWith("user-123", NOTE_ID, expect.objectContaining({ expectedVersion: 1 }));

    const conflict = vi.fn(async () => {
      throw new ConflictError("Study note version conflict", undefined, { currentVersion: 5 });
    });
    const app2 = createApp(makeServices({ studyNotes: { save: conflict } }));
    const res409 = await app2.request(`/api/l3/study-notes/${NOTE_ID}`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify(savePayload()),
    });
    expect(res409.status).toBe(409);

    const missing = vi.fn(async () => {
      throw new NotFoundError("StudyNote", NOTE_ID);
    });
    const app3 = createApp(makeServices({ studyNotes: { save: missing } }));
    const res404 = await app3.request(`/api/l3/study-notes/${NOTE_ID}`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify(savePayload()),
    });
    expect(res404.status).toBe(404);

    const invalid = vi.fn(async () => {
      throw new ValidationError("原文已变化，请重新选择引用", "quote");
    });
    const app4 = createApp(makeServices({ studyNotes: { save: invalid } }));
    const res422 = await app4.request(`/api/l3/study-notes/${NOTE_ID}`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify(savePayload()),
    });
    expect(res422.status).toBe(422);
  });

  it("保存 body 不得携带 userId/fieldHash/displaySnapshot（strict 400）", async () => {
    const save = vi.fn();
    const app = createApp(makeServices({ studyNotes: { save } }));
    for (const field of ["userId", "fieldHash", "displaySnapshot"]) {
      const res = await app.request(`/api/l3/study-notes/${NOTE_ID}`, {
        method: "PUT", headers: AUTH_HEADERS,
        body: JSON.stringify({ ...savePayload(), [field]: "x" }),
      });
      expect(res.status, field).toBe(400);
    }
    expect(save).not.toHaveBeenCalled();
  });
});

describe("study-topics 路由", () => {
  it("创建 201/200；列表；保存；成员加入/移出", async () => {
    const createTopic = vi.fn(async () => ({ item: topicDto(), created: true }));
    const listTopics = vi.fn(async () => ({ items: [topicDto()], total: 1, nextCursor: null }));
    const saveTopic = vi.fn(async () => ({ item: topicDto({ version: 2 }) }));
    const moveTopicMember = vi.fn(async () => ({ item: topicDto({ version: 2, memberCount: 1 }) }));
    const removeTopicMember = vi.fn(async () => ({ item: topicDto({ version: 3 }) }));
    const app = createApp(makeServices({
      studyNotes: { createTopic, listTopics, saveTopic, moveTopicMember, removeTopicMember },
    }));

    const created = await app.request("/api/l3/study-topics", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, venue: "reading_choice", title: "专题" }),
    });
    expect(created.status).toBe(201);

    const listed = await app.request("/api/l3/study-topics?venue=reading_choice", { headers: AUTH_HEADERS });
    expect(listed.status).toBe(200);
    expect(listTopics).toHaveBeenCalled();

    const saved = await app.request(`/api/l3/study-topics/${TOPIC_ID}`, {
      method: "PUT", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, expectedVersion: 1, title: "改名", status: "archived" }),
    });
    expect(saved.status).toBe(200);

    const moved = await app.request(`/api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`, {
      method: "PUT", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, expectedVersion: 2, beforeNoteId: null }),
    });
    expect(moved.status).toBe(200);
    expect(moveTopicMember).toHaveBeenCalledWith("user-123", TOPIC_ID, NOTE_ID, expect.objectContaining({
      expectedVersion: 2, beforeNoteId: null,
    }));

    const removed = await app.request(`/api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`, {
      method: "DELETE", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ, expectedVersion: 2 }),
    });
    expect(removed.status).toBe(200);
    expect(removeTopicMember).toHaveBeenCalledWith("user-123", TOPIC_ID, NOTE_ID, expect.objectContaining({
      expectedVersion: 2,
    }));
  });
});

describe("补齐：各端点校验分支（400；不触服务）", () => {
  it("study-topics 各端点非法载荷均 400 且零调用", async () => {
    const createTopic = vi.fn();
    const listTopics = vi.fn();
    const saveTopic = vi.fn();
    const moveTopicMember = vi.fn();
    const removeTopicMember = vi.fn();
    const app = createApp(makeServices({
      studyNotes: { createTopic, listTopics, saveTopic, moveTopicMember, removeTopicMember },
    }));

    const cases: [string, string, string, unknown][] = [
      ["POST", "/api/l3/study-topics", "创建（坏 requestId）", { requestId: "bad", venue: "reading_choice", title: "x" }],
      ["GET", "/api/l3/study-topics", "列表（缺 venue）", undefined],
      ["PUT", `/api/l3/study-topics/${TOPIC_ID}`, "保存（缺字段）", { requestId: REQ }],
      ["PUT", `/api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`, "移动（缺 beforeNoteId）", { requestId: REQ, expectedVersion: 1 }],
      ["DELETE", `/api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`, "移除（空 body）", {}],
    ];
    for (const [method, url, label, body] of cases) {
      const res = await app.request(url, {
        method,
        headers: AUTH_HEADERS,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, label).toBe(400);
    }
    expect(createTopic).not.toHaveBeenCalled();
    expect(listTopics).not.toHaveBeenCalled();
    expect(saveTopic).not.toHaveBeenCalled();
    expect(moveTopicMember).not.toHaveBeenCalled();
    expect(removeTopicMember).not.toHaveBeenCalled();
  });

  it("study-references 三端点非法输入均 400 且零调用", async () => {
    const search = vi.fn();
    const preview = vi.fn();
    const backlinks = vi.fn();
    const app = createApp(makeServices({ studyReferences: { search, preview, backlinks } }));

    expect((await app.request("/api/l3/study-notes/reference-targets", { headers: AUTH_HEADERS })).status).toBe(400);
    expect((await app.request("/api/l3/study-notes/reference-preview", {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ kind: "nope" }),
    })).status).toBe(400);
    expect((await app.request("/api/l3/study-notes/backlinks?targetKind=source", { headers: AUTH_HEADERS })).status).toBe(400);

    expect(search).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(backlinks).not.toHaveBeenCalled();
  });

  it("study-notes 列表非法 venue 与保存缺字段均 400 且零调用", async () => {
    const list = vi.fn();
    const save = vi.fn();
    const app = createApp(makeServices({ studyNotes: { list, save } }));
    expect((await app.request("/api/l3/study-notes?venue=not_a_type", { headers: AUTH_HEADERS })).status).toBe(400);
    expect((await app.request(`/api/l3/study-notes/${NOTE_ID}`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify({}),
    })).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

// ── F5：合法大写 UUID 经真实 service 接线（路径参数与 body 同一身份进入仓储层）──
// 本组直接挂载真实 L3StudyNoteService（fake 仓储），验证 HTTP 边界 → 服务入口
// 的规范化行为；语义真库证据在 l3-study-notes-repair.integration.test.ts。

describe("F5 UUID 身份（真实 service 接线）", () => {
  const NOTE_CASE_L = "abcdef01-2345-4789-8abc-def012345678";
  const NOTE_CASE_U = "ABCDEF01-2345-4789-8ABC-DEF012345678";
  const REQ_CASE_L = "deadbeef-2345-4789-8abc-0123456789ab";
  const REQ_CASE_U = "DEADBEEF-2345-4789-8ABC-0123456789AB";

  function caseNoteRow() {
    return {
      id: NOTE_CASE_L, user_id: "user-123", title: "详情", body_md: "", status: "active" as const,
      pinned: false, version: 1, create_request_id: REQ_CASE_L,
      create_input_hash: computeNoteCreateHash("reading_choice"),
      last_write_request_id: null, last_write_hash: null,
      created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    };
  }

  function mountRealService() {
    const repos = {
      studyNotes: {
        get: vi.fn(async () => caseNoteRow()),
        lock: vi.fn(async () => caseNoteRow()),
        findByCreateRequestId: vi.fn(async () => caseNoteRow()),
        listVenues: vi.fn(async () => ["reading_choice"]),
      },
      studyTopics: {},
      studyReferences: {
        listForNote: vi.fn(async () => []),
      },
    };
    const txRunner = (async (callback: (tx: unknown) => Promise<unknown>) => callback({})) as never;
    const referenceService = { resolve: vi.fn(async () => []) } as never;
    const service = new L3StudyNoteService(txRunner, () => repos as never, referenceService);
    return { app: createApp(makeServices({ studyNotes: service as never })), repos };
  }

  it("路径参数：合法大写 noteId → 仓储以规范小写为键读取（同一身份）", async () => {
    const { app, repos } = mountRealService();
    const res = await app.request(`/api/l3/study-notes/${NOTE_CASE_U}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { id: string } };
    expect(body.item.id).toBe(NOTE_CASE_L);
    expect(repos.studyNotes.get).toHaveBeenCalledWith("user-123", NOTE_CASE_L);
  });

  it("body：合法大写 requestId → 幂等查询以规范小写为键（复用既有对象，200）", async () => {
    const { app, repos } = mountRealService();
    const res = await app.request("/api/l3/study-notes", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ requestId: REQ_CASE_U, venue: "reading_choice" }),
    });
    expect(res.status).toBe(200);
    expect(repos.studyNotes.findByCreateRequestId).toHaveBeenCalledWith("user-123", REQ_CASE_L);
  });
});
