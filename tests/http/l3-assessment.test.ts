import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { NotFoundError } from "@/errors";
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
});
afterAll(() => {
  delete process.env.OWNER_API_TOKEN;
  delete process.env.LOCAL_OWNER_ID;
});

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

function assessmentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    user_id: "user-123",
    question_id: QUESTION_ID,
    content_md: "评析正文",
    last_editor: "owner",
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeServices(l3Assessments: Record<string, unknown>): Services {
  return { l3Assessments } as unknown as Services;
}

describe("GET /api/l3/questions/:id/assessment", () => {
  it("returns the 空态 item:null when no assessment exists", async () => {
    const getAssessment = vi.fn(async () => ({ item: null }));
    const app = createApp(makeServices({ getAssessment }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}/assessment`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ item: null });
    expect(getAssessment).toHaveBeenCalledWith("user-123", QUESTION_ID);
  });

  it("returns the stored row", async () => {
    const getAssessment = vi.fn(async () => ({ item: assessmentItem() }));
    const app = createApp(makeServices({ getAssessment }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}/assessment`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { content_md: string } };
    expect(body.item.content_md).toBe("评析正文");
  });

  it("translates a missing question to 404", async () => {
    const getAssessment = vi.fn(async () => { throw new NotFoundError("L3Question", QUESTION_ID); });
    const app = createApp(makeServices({ getAssessment }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}/assessment`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/l3/question-assessments（批量 · 2026-09-27）", () => {
  const Q2 = "00000000-0000-4000-8000-000000000102";

  it("passes the CSV questionIds through and returns { items }", async () => {
    const listForQuestions = vi.fn(async () => ({ items: [assessmentItem()] }));
    const app = createApp(makeServices({ listForQuestions }));
    const res = await app.request(`/api/l3/question-assessments?questionIds=${QUESTION_ID},${Q2}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [assessmentItem()] });
    expect(listForQuestions).toHaveBeenCalledWith("user-123", [QUESTION_ID, Q2]);
  });

  it("empty batch is an empty array, not item:null（批量空态 ≠ 单题空态）", async () => {
    const listForQuestions = vi.fn(async () => ({ items: [] }));
    const app = createApp(makeServices({ listForQuestions }));
    const res = await app.request(`/api/l3/question-assessments?questionIds=${QUESTION_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  it("rejects a missing / non-uuid / oversized questionIds without touching the service", async () => {
    const listForQuestions = vi.fn();
    const app = createApp(makeServices({ listForQuestions }));
    const missing = await app.request(`/api/l3/question-assessments`, { headers: AUTH_HEADERS });
    expect(missing.status).toBe(400);
    const notUuid = await app.request(`/api/l3/question-assessments?questionIds=abc`, { headers: AUTH_HEADERS });
    expect(notUuid.status).toBe(400);
    const tooMany = await app.request(
      `/api/l3/question-assessments?questionIds=${Array.from({ length: 201 }, () => QUESTION_ID).join(",")}`,
      { headers: AUTH_HEADERS },
    );
    expect(tooMany.status).toBe(400);
    expect(listForQuestions).not.toHaveBeenCalled();
  });

  it("does not 404 on unknown questions（批量语义是「有哪些」而非「是否都存在」）", async () => {
    const listForQuestions = vi.fn(async () => ({ items: [] }));
    const app = createApp(makeServices({ listForQuestions }));
    const res = await app.request(
      `/api/l3/question-assessments?questionIds=${QUESTION_ID},${Q2}`,
      { headers: AUTH_HEADERS },
    );
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/l3/questions/:id/assessment", () => {
  it("upserts with the owner editor resolved from the authenticated role", async () => {
    const putAssessment = vi.fn(async () => ({ item: assessmentItem() }));
    const app = createApp(makeServices({ putAssessment }));
    const res = await app.request(`/api/l3/questions/${QUESTION_ID}/assessment`, {
      method: "PUT",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ contentMd: "评析正文" }),
    });
    expect(res.status).toBe(200);
    expect(putAssessment).toHaveBeenCalledWith({
      userId: "user-123", questionId: QUESTION_ID, editor: "owner", contentMd: "评析正文",
    });
  });

  it("rejects empty or unknown-key bodies", async () => {
    const putAssessment = vi.fn();
    const app = createApp(makeServices({ putAssessment }));
    const empty = await app.request(`/api/l3/questions/${QUESTION_ID}/assessment`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify({ contentMd: "  " }),
    });
    expect(empty.status).toBe(400);
    const extra = await app.request(`/api/l3/questions/${QUESTION_ID}/assessment`, {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify({ contentMd: "x", note: "越权字段" }),
    });
    expect(extra.status).toBe(400);
    expect(putAssessment).not.toHaveBeenCalled();
  });
});
