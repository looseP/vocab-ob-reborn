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
});
afterAll(() => {
  delete process.env.OWNER_API_TOKEN;
  delete process.env.LOCAL_OWNER_ID;
});

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };
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

  it("requires a file identity on the detail endpoint", async () => {
    const getPracticeFile = vi.fn();
    const app = createApp(makeServices({ getPracticeFile }));
    const res = await app.request("/api/l3/practice-files/detail?questionType=reading_choice", { headers: AUTH_HEADERS });
    await expectValidationError(res);
    expect(getPracticeFile).not.toHaveBeenCalled();
  });
});
