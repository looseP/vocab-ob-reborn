import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { ConflictError, NotFoundError } from "@/errors";
import type { Services } from "@/services";
import { createMockPool } from "../helpers/mock-db";
import type { L3PaperDetail, L3QuestionRow } from "@/domain";

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
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const PAPER_ID = "00000000-0000-4000-8000-000000000201";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";

function questionRow(overrides: Partial<L3QuestionRow> = {}): L3QuestionRow {
  return {
    id: QUESTION_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    source_id: SOURCE_ID,
    file_key: null,
    space: "阅读",
    question_type: "reading_choice",
    ordinal: 0,
    stem: "21. 题干",
    options: [{ key: "A", text: "选项 A" }],
    answer: { choice: "A" },
    explanation: "解析",
    evidence: [],
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function paperDetail(): L3PaperDetail {
  const question = questionRow();
  return {
    id: PAPER_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    title: "2023 英语一真题",
    direction: "考研",
    metadata: { year: 2023 },
    payload: {
      version: 1,
      sections: [{
        key: "s1",
        title: "Text 1",
        questionType: "reading_choice",
        sourceId: SOURCE_ID,
        fileKey: null,
        questionIds: [QUESTION_ID],
      }],
    },
    payload_version: 1,
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    sections: [{
      key: "s1",
      title: "Text 1",
      questionType: "reading_choice",
      sourceId: SOURCE_ID,
      fileKey: null,
      questionIds: [QUESTION_ID],
      missing: false,
      source_title: "2023 英语一 Text 1",
      source_content: "Passage body.",
      questions: [question],
    }],
  };
}

function makeServices(l3Paper: Record<string, unknown>): Services {
  return { l3Paper } as unknown as Services;
}

async function expectValidationError(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json() as { code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
}

describe("POST /api/l3/papers", () => {
  const validBody = {
    title: "2023 英语一真题",
    direction: "考研",
    sections: [{
      title: "Text 1",
      questionType: "reading_choice",
      sourceId: SOURCE_ID,
      questions: [{
        stem: "21. 题干",
        options: [{ key: "A", text: "选项 A" }],
        answer: { choice: "A" },
      }],
    }],
  };

  it("creates a paper with questions and returns the contract shape", async () => {
    const detail = paperDetail();
    const { sections: _sections, ...paperRow } = detail;
    const createPaper = vi.fn(async () => ({
      paper: paperRow,
      questions: detail.sections[0].questions,
      questionCount: 1,
    }));
    const app = createApp(makeServices({ createPaper }));
    const res = await app.request("/api/l3/papers", { method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(validBody) });
    expect(res.status).toBe(201);
    const body = await res.json() as { questionCount: number };
    expect(body.questionCount).toBe(1);
    expect(createPaper).toHaveBeenCalledWith(expect.objectContaining({
      title: "2023 英语一真题",
      direction: "考研",
    }));
    const calledInput = (createPaper.mock.calls as unknown as Array<[{
      sections: Array<{ questions: Array<{ answer?: unknown }> }>;
    }]>)[0][0];
    expect(calledInput.sections[0].questions[0].answer).toEqual({ choice: "A" });
  });

  it("rejects empty sections before the service is called", async () => {
    const createPaper = vi.fn();
    const app = createApp(makeServices({ createPaper }));
    const res = await app.request("/api/l3/papers", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ title: "空卷", sections: [] }),
    });
    await expectValidationError(res);
    expect(createPaper).not.toHaveBeenCalled();
  });

  it("rejects a reading section without source identity", async () => {
    const createPaper = vi.fn();
    const app = createApp(makeServices({ createPaper }));
    const res = await app.request("/api/l3/papers", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        title: "坏卷",
        sections: [{ title: "Text 1", questionType: "reading_choice", questions: [{ stem: "x" }] }],
      }),
    });
    await expectValidationError(res);
    expect(createPaper).not.toHaveBeenCalled();
  });

  it("rejects an unknown question type", async () => {
    const createPaper = vi.fn();
    const app = createApp(makeServices({ createPaper }));
    const res = await app.request("/api/l3/papers", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        title: "坏卷",
        sections: [{ title: "七选五", questionType: "matching", fileKey: "k", questions: [{ stem: "x" }] }],
      }),
    });
    await expectValidationError(res);
  });
});

describe("GET /api/l3/papers", () => {
  it("lists papers with pagination and forwards filters", async () => {
    const listPapers = vi.fn(async () => ({
      items: [{
        id: PAPER_ID,
        title: "2023 英语一真题",
        direction: "考研",
        status: "active",
        section_count: 1,
        question_count: 1,
        created_at: "2026-09-16T00:00:00Z",
        updated_at: "2026-09-16T00:00:00Z",
      }],
      total: 1,
      limit: 50,
      offset: 0,
    }));
    const app = createApp(makeServices({ listPapers }));
    const res = await app.request("/api/l3/papers?status=active&q=2023", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(listPapers).toHaveBeenCalledWith(expect.objectContaining({ status: "active", q: "2023" }));
  });
});

describe("GET /api/l3/papers/:id", () => {
  it("returns the assembled paper detail", async () => {
    const getPaper = vi.fn(async () => paperDetail());
    const app = createApp(makeServices({ getPaper }));
    const res = await app.request(`/api/l3/papers/${PAPER_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as L3PaperDetail;
    expect(body.sections[0].missing).toBe(false);
    expect(body.sections[0].questions[0].stem).toBe("21. 题干");
    expect(getPaper).toHaveBeenCalledWith("user-123", PAPER_ID);
  });

  it("rejects a non-uuid id and maps a missing paper to 404", async () => {
    const getPaper = vi.fn(async () => {
      throw new NotFoundError("L3Paper", "nope");
    });
    const app = createApp(makeServices({ getPaper }));

    const bad = await app.request("/api/l3/papers/not-a-uuid", { headers: AUTH_HEADERS });
    expect(bad.status).toBe(400);

    const missing = await app.request(`/api/l3/papers/${PAPER_ID}`, { headers: AUTH_HEADERS });
    expect(missing.status).toBe(404);
  });
});

describe("PATCH /api/l3/questions/:id（改题面 2026-09-26）", () => {

  it("200 + 单行题面；把 stem/options/answer/explanation/evidence 交给 service", async () => {
    const updateQuestion = vi.fn(async () => ({ question: questionRow() }));
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        stem: "改过的题干",
        options: [{ key: "A", text: "选项 A（改）" }, { key: "B", text: "选项 B（改）" }],
        answer: { choice: "B" },
        explanation: "因为原文如此",
        evidence: [{ start: 0, end: 12, label: "官方证据" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { question: { id: string } };
    expect(body.question.id).toBe(QUESTION_ID);
    expect(updateQuestion).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      questionId: QUESTION_ID,
      stem: "改过的题干",
      answer: { choice: "B" },
      explanation: "因为原文如此",
    }));
  });

  it("非 uuid 路径参数 → 400（不猜）", async () => {
    const updateQuestion = vi.fn();
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request("/api/l3/questions/not-a-uuid", {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ stem: "x" }),
    });
    expect(res.status).toBe(400);
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("畸形 evidence（end<=start）→ 400（validationError 口径），不进 service", async () => {
    const updateQuestion = vi.fn();
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        stem: "x",
        evidence: [{ start: 5, end: 5, label: "空区间" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("空题干 → 400（不吞）", async () => {
    const updateQuestion = vi.fn();
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ stem: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("service 的 409 护栏原样透出（答案历史不可改写）", async () => {
    const updateQuestion = vi.fn(async () => {
      throw new ConflictError("Cannot edit a question that already has answer history", undefined, {
        entityType: "question", id: QUESTION_ID, blockers: { attempts: 3 },
      });
    });
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ stem: "x" }),
    });
    expect(res.status).toBe(409);
  });

  it("404 语义：题不存在或非属主", async () => {
    const updateQuestion = vi.fn(async () => {
      throw new NotFoundError("L3Question", QUESTION_ID);
    });
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ stem: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("agent 可写，但 service 拿到的 actor 是 {role:agent, agentId}（由 Principal 认定）", async () => {
    const updateQuestion = vi.fn(async () => ({ question: questionRow({ status: "pending" }) }));
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: AGENT_HEADERS,
      body: JSON.stringify({ stem: "改过的题干" }),
    });
    expect(res.status).toBe(200);
    expect(updateQuestion).toHaveBeenCalledWith(expect.objectContaining({
      actor: { role: "agent", agentId: "agent-a" },
    }));
  });


});

describe("PATCH /api/l3/papers/:id（改卷 2026-09-26）", () => {
  it("200 + 单行卷；sections 只带引用", async () => {
    const updatePaper = vi.fn(async () => ({ paper: paperDetail() }));
    const app = createApp(makeServices({ updatePaper }));
    const res = await app.request(`/api/l3/papers/${PAPER_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        title: "2023 模拟卷（修订）",
        direction: "考研",
        sections: [
          { key: "s1", title: "Text 2", questionType: "reading_choice", sourceId: SOURCE_ID, questionIds: [QUESTION_ID] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(updatePaper).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      paperId: PAPER_ID,
      title: "2023 模拟卷（修订）",
    }));
  });

  it("空 sections → 400；非 uuid → 400", async () => {
    const updatePaper = vi.fn();
    const app = createApp(makeServices({ updatePaper }));

    const empty = await app.request(`/api/l3/papers/${PAPER_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ title: "x", sections: [] }),
    });
    expect(empty.status).toBe(400);

    const bad = await app.request("/api/l3/papers/nope", {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ title: "x", sections: [] }),
    });
    expect(bad.status).toBe(400);
    expect(updatePaper).not.toHaveBeenCalled();
  });

  it("owner-only：agent 令牌被拒", async () => {
    const updatePaper = vi.fn();
    const app = createApp(makeServices({ updatePaper }));
    const res = await app.request(`/api/l3/papers/${PAPER_ID}`, {
      method: "PATCH",
      headers: AGENT_HEADERS,
      body: JSON.stringify({ title: "x", sections: [] }),
    });
    expect(res.status).toBe(403);
  });

  /**
   * 断 body 的 JSON 解析：`.catch(() => ({}))` 兜成空对象后由 schema 判 400。
   * 不兜的话这里是 500 —— 手滑截断的请求体不该报服务器错。
   */
  it("body 不是合法 JSON → 400（解析失败兜成空对象，交给 schema 判形状）", async () => {
    const updatePaper = vi.fn();
    const app = createApp(makeServices({ updatePaper }));
    const res = await app.request(`/api/l3/papers/${PAPER_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: "{ 截断的 json",
    });
    expect(res.status).toBe(400);
    expect(updatePaper).not.toHaveBeenCalled();
  });

  it("缺省 direction → 落 null（不改方向），空 body 字段由 schema 兜住", async () => {
    const updatePaper = vi.fn(async () => ({ paper: paperDetail() }));
    const app = createApp(makeServices({ updatePaper }));
    const res = await app.request(`/api/l3/papers/${PAPER_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        title: "只改标题",
        sections: [
          { key: "s1", title: "Text 2", questionType: "reading_choice", sourceId: SOURCE_ID, questionIds: [QUESTION_ID] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(updatePaper).toHaveBeenCalledWith(expect.objectContaining({ direction: null }));
  });
});

describe("PATCH 请求体健壮性（2026-09-26）", () => {
  it("题目 PATCH：body 不是合法 JSON → 400（不进 service）", async () => {
    const updateQuestion = vi.fn();
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(400);
    expect(updateQuestion).not.toHaveBeenCalled();
  });
});

describe("POST /api/l3/questions", () => {
  it("creates a standalone question and maps service errors", async () => {
    const createQuestion = vi.fn(async () => ({ question: questionRow() }));
    const app = createApp(makeServices({ createQuestion }));
    const res = await app.request("/api/l3/questions", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        questionType: "reading_choice",
        sourceId: SOURCE_ID,
        stem: "21. 题干",
        options: [{ key: "A", text: "选项 A" }],
        answer: { choice: "A" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { question: { id: string } };
    expect(body.question.id).toBe(QUESTION_ID);
  });

  it("requires sourceId or fileKey", async () => {
    const createQuestion = vi.fn();
    const app = createApp(makeServices({ createQuestion }));
    const res = await app.request("/api/l3/questions", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ questionType: "long_essay", stem: "作文" }),
    });
    await expectValidationError(res);
    expect(createQuestion).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/l3/questions/:id", () => {
  it("deletes and maps active-paper references to 409 with blockers", async () => {
    const deleteQuestion = vi.fn()
      .mockResolvedValueOnce({ deleted: true as const })
      .mockRejectedValueOnce(new ConflictError("referenced", undefined, {
        entityType: "question",
        id: QUESTION_ID,
        blockers: { papers: [{ id: PAPER_ID, title: "2023 英语一" }] },
      }));
    const app = createApp(makeServices({ deleteQuestion }));

    const ok = await app.request(`/api/l3/questions/${QUESTION_ID}`, { method: "DELETE", headers: AUTH_HEADERS });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ deleted: true });

    const blocked = await app.request(`/api/l3/questions/${QUESTION_ID}`, { method: "DELETE", headers: AUTH_HEADERS });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { details?: { blockers?: { papers?: Array<{ id: string }> } } };
    expect(body.details?.blockers?.papers?.[0]?.id).toBe(PAPER_ID);
  });

  it("rejects a non-uuid id", async () => {
    const deleteQuestion = vi.fn();
    const app = createApp(makeServices({ deleteQuestion }));
    const res = await app.request("/api/l3/questions/bad-id", { method: "DELETE", headers: AUTH_HEADERS });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/l3/practice-files", () => {
  it("lists derived practice files and serves a single file detail", async () => {
    const listPracticeFiles = vi.fn(async () => ({
      items: [{
        question_type: "reading_choice" as const,
        source_id: SOURCE_ID,
        file_key: null,
        title: "2023 英语一 Text 1",
        direction: "考研",
        question_count: 5,
        latest_created_at: "2026-09-16T00:00:00Z",
      }],
      total: 1,
      limit: 50,
      offset: 0,
    }));
    const getPracticeFile = vi.fn(async () => ({
      question_type: "reading_choice" as const,
      source: { id: SOURCE_ID, title: "2023 英语一 Text 1" },
      source_content: "A passage for the file.",
      file_key: null,
      questions: [questionRow()],
    }));
    const app = createApp(makeServices({ listPracticeFiles, getPracticeFile }));

    const list = await app.request("/api/l3/practice-files?questionType=reading_choice&direction=%E8%80%83%E7%A0%94", {
      headers: AUTH_HEADERS,
    });
    expect(list.status).toBe(200);
    expect(listPracticeFiles).toHaveBeenCalledWith(expect.objectContaining({
      questionType: "reading_choice",
      direction: "考研",
    }));

    const detail = await app.request(
      `/api/l3/practice-files/detail?questionType=reading_choice&sourceId=${SOURCE_ID}`,
      { headers: AUTH_HEADERS },
    );
    expect(detail.status).toBe(200);
    const body = await detail.json() as { questions: L3QuestionRow[] };
    expect(body.questions).toHaveLength(1);
  });

  it("R3：精确来源过滤（sourceId/fileKey）透传服务层；非法 sourceId → 400", async () => {
    const listPracticeFiles = vi.fn(async () => ({ items: [], total: 0, limit: 1, offset: 0 }));
    const app = createApp(makeServices({ listPracticeFiles }));

    const bySource = await app.request(
      `/api/l3/practice-files?questionType=short_essay&sourceId=${SOURCE_ID}&limit=1`,
      { headers: AUTH_HEADERS },
    );
    expect(bySource.status).toBe(200);
    expect(listPracticeFiles).toHaveBeenCalledWith(expect.objectContaining({
      questionType: "short_essay", sourceId: SOURCE_ID, limit: 1,
    }));

    const byFileKey = await app.request(
      "/api/l3/practice-files?questionType=short_essay&fileKey=writing-short-1&limit=1",
      { headers: AUTH_HEADERS },
    );
    expect(byFileKey.status).toBe(200);
    expect(listPracticeFiles).toHaveBeenLastCalledWith(expect.objectContaining({
      questionType: "short_essay", fileKey: "writing-short-1",
    }));

    const bad = await app.request(
      "/api/l3/practice-files?questionType=short_essay&sourceId=not-a-uuid",
      { headers: AUTH_HEADERS },
    );
    await expectValidationError(bad);
  });

  it("requires a file identity on the detail endpoint", async () => {
    const getPracticeFile = vi.fn();
    const app = createApp(makeServices({ getPracticeFile }));
    const res = await app.request("/api/l3/practice-files/detail?questionType=reading_choice", { headers: AUTH_HEADERS });
    await expectValidationError(res);
    expect(getPracticeFile).not.toHaveBeenCalled();
  });
});

/**
 * 录题闸门的 HTTP 侧（ADR-0037 决策 9 的必交矩阵）。
 *
 * 这组断言的价值在于**它们各自对应一种绕过闸门的尝试**：
 *  - agent 在 body 里塞 `status:'active'` → strict 拒键（决策 2）
 *  - agent 调删题 → 403（只订正不销毁）
 *  - agent 写 submissions → 403（ADR-0030 §5 红线，一个字没动）
 *  - agent 读待录面 → 403（核对是 owner 的责任）
 *  - agent 采纳 → 403（唯一把 pending 变 active 的动作只给 owner）
 *  - 非 pending 状态查询 → 400（待录面不接受别的用途）
 */
describe("录题闸门 · HTTP 鉴权与 strict 拒键（ADR-0037）", () => {
  it("agent 录题 → 200 且 actor 带 agentId（created_by 由服务端认定）", async () => {
    const createQuestion = vi.fn(async () => ({ question: questionRow({ status: "pending", created_by: "agent-a" }) }));
    const app = createApp(makeServices({ createQuestion }));
    const res = await app.request("/api/l3/questions", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({
        questionType: "reading_choice", sourceId: SOURCE_ID, stem: "21. 题干", answer: { choice: "B" },
      }),
    });
    expect(res.status).toBe(201);
    expect(createQuestion).toHaveBeenCalledWith(expect.objectContaining({
      actor: { role: "agent", agentId: "agent-a" },
    }));
  });

  it("agent body 里塞 status/created_by → 400（strict 拒越权键，不静默剥离）", async () => {
    const createQuestion = vi.fn();
    const createPaper = vi.fn();
    const app = createApp(makeServices({ createQuestion, createPaper }));
    const res = await app.request("/api/l3/questions", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({
        questionType: "reading_choice", sourceId: SOURCE_ID, stem: "21. 题干", status: "active",
      }),
    });
    await expectValidationError(res);
    expect(createQuestion).not.toHaveBeenCalled();

    const paperRes = await app.request("/api/l3/papers", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({
        title: "卷", created_by: "agent-a",
        sections: [{ title: "Text 1", questionType: "reading_choice", sourceId: SOURCE_ID, questions: [{ stem: "x" }] }],
      }),
    });
    await expectValidationError(paperRes);
    expect(createPaper).not.toHaveBeenCalled();
  });

  it("agent 改题面 body 带 status → 400（PATCH 同样 strict）", async () => {
    const updateQuestion = vi.fn();
    const app = createApp(makeServices({ updateQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "PATCH",
      headers: AGENT_HEADERS,
      body: JSON.stringify({ stem: "x", status: "active" }),
    });
    await expectValidationError(res);
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("agent 删题 → 403（只订正不销毁）", async () => {
    const deleteQuestion = vi.fn();
    const app = createApp(makeServices({ deleteQuestion }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}`, {
      method: "DELETE",
      headers: AGENT_HEADERS,
    });
    expect(res.status).toBe(403);
    expect(deleteQuestion).not.toHaveBeenCalled();
  });

  it("agent 改卷 → 403（agent 只建卷，卷内题强制 pending）", async () => {
    const updatePaper = vi.fn();
    const app = createApp(makeServices({ updatePaper }));
    const res = await app.request(`/api/l3/papers/${PAPER_ID}`, {
      method: "PATCH",
      headers: AGENT_HEADERS,
      body: JSON.stringify({
        title: "x",
        sections: [{ key: "s1", title: "Text 1", questionType: "reading_choice", sourceId: SOURCE_ID, questionIds: [QUESTION_ID] }],
      }),
    });
    expect(res.status).toBe(403);
    expect(updatePaper).not.toHaveBeenCalled();
  });

  it("agent 写 submissions（作答）→ 403（ADR-0030 §5 红线未松动）", async () => {
    const openSheet = vi.fn();
    const app = createApp(makeServices({ openSheet }));
    const res = await app.request("/api/l3/sheets", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({ scope: "file", sourceId: SOURCE_ID, questionType: "reading_choice" }),
    });
    expect(res.status).toBe(403);
    expect(openSheet).not.toHaveBeenCalled();
  });

  it("agent 读待录面 / 采纳 / 驳回 / 批量采纳 → 全 403（核对与升级是 owner 的动作）", async () => {
    const listPendingQuestions = vi.fn();
    const acceptQuestions = vi.fn();
    const rejectQuestion = vi.fn();
    const app = createApp(makeServices({ listPendingQuestions, acceptQuestions, rejectQuestion }));
    for (const [path, method] of [
      ["/api/l3/questions?status=pending", "GET"],
      [`/api/l3/questions/${QUESTION_ID}/accept`, "POST"],
      [`/api/l3/questions/${QUESTION_ID}/reject`, "POST"],
      ["/api/l3/questions/accept-batch", "POST"],
    ] as const) {
      const res = await app.request(path, { method, headers: AGENT_HEADERS });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(listPendingQuestions).not.toHaveBeenCalled();
    expect(acceptQuestions).not.toHaveBeenCalled();
    expect(rejectQuestion).not.toHaveBeenCalled();
  });

  it("owner 读待录面 → 200（核对面带答案键与证据切片）", async () => {
    const listPendingQuestions = vi.fn(async () => ({
      total: 1,
      items: [{
        question: questionRow({ status: "pending", created_by: "agent-a", answer: { choice: "B" } }),
        sourceTitle: "2023 英语一 Text 1",
        evidenceExcerpts: [{ excerpt: "The trend", outOfRange: false }, { excerpt: null, outOfRange: true }],
      }],
    }));
    const app = createApp(makeServices({ listPendingQuestions }));
    const res = await app.request("/api/l3/questions?status=pending", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ question: { answer: unknown }; evidenceExcerpts: unknown[] }> };
    expect(body.items[0]!.question.answer).toEqual({ choice: "B" });
    expect(body.items[0]!.evidenceExcerpts).toHaveLength(2);
    expect(listPendingQuestions).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
  });

  it("待录面 status 非 pending → 400（这个端点只有「待录」一个用途）", async () => {
    const listPendingQuestions = vi.fn();
    const app = createApp(makeServices({ listPendingQuestions }));
    const res = await app.request("/api/l3/questions?status=active", { headers: AUTH_HEADERS });
    await expectValidationError(res);
    expect(listPendingQuestions).not.toHaveBeenCalled();
  });

  it("owner 采纳 → 逐条结果原样透出（部分失败不静默）", async () => {
    const acceptQuestions = vi.fn(async () => ({
      acceptedCount: 1,
      results: [
        { id: QUESTION_ID, ok: true, status: "active" },
        { id: "00000000-0000-4000-8000-000000000102", ok: false, reason: "not_pending", status: "rejected" },
      ],
    }));
    const app = createApp(makeServices({ acceptQuestions }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}/accept`, {
      method: "POST", headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { acceptedCount: number; results: Array<{ ok: boolean; reason?: string }> };
    expect(body.acceptedCount).toBe(1);
    expect(body.results[1]!.reason).toBe("not_pending");
  });

  it("批量采纳：重复 id → 400；超 200 条 → 400；非 uuid → 400", async () => {
    const acceptQuestions = vi.fn();
    const app = createApp(makeServices({ acceptQuestions }));
    for (const body of [
      { questionIds: [QUESTION_ID, QUESTION_ID] },
      { questionIds: Array.from({ length: 201 }, () => QUESTION_ID) },
      { questionIds: ["nope"] },
      { questionIds: [] },
    ]) {
      const res = await app.request("/api/l3/questions/accept-batch", {
        method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(body),
      });
      await expectValidationError(res);
    }
    expect(acceptQuestions).not.toHaveBeenCalled();
  });

  it("非 uuid 路径参数 → 400（采纳/驳回都是）", async () => {
    const acceptQuestions = vi.fn();
    const rejectQuestion = vi.fn();
    const app = createApp(makeServices({ acceptQuestions, rejectQuestion }));
    for (const path of ["/api/l3/questions/nope/accept", "/api/l3/questions/nope/reject"]) {
      const res = await app.request(path, { method: "POST", headers: AUTH_HEADERS });
      await expectValidationError(res);
    }
    expect(acceptQuestions).not.toHaveBeenCalled();
    expect(rejectQuestion).not.toHaveBeenCalled();
  });
});