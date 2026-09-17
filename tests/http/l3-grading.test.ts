import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { ConflictError, NotFoundError } from "@/errors";
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
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const ANNOTATION_ID = "00000000-0000-4000-8000-000000000201";

function gradingItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    user_id: "user-123",
    sheet_id: SHEET_ID,
    question_id: QUESTION_ID,
    verdict: "wrong",
    analysis_md: null,
    graded_by: "agent-a",
    graded_at: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

function makeServices(l3Grading: Record<string, unknown>): Services {
  return { l3Grading } as unknown as Services;
}

describe("GET /api/l3/sheets/:id/grading-context（agent 面）", () => {
  it("passes the owner id and sheet id through to the service", async () => {
    const getGradingContext = vi.fn(async () => ({
      sheet: { id: SHEET_ID, status: "sealed" },
      questions: [],
      sources: [],
    }));
    const app = createApp(makeServices({ getGradingContext }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/grading-context`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(getGradingContext).toHaveBeenCalledWith("user-123", SHEET_ID);
  });

  it("is readable by an agent bearer（bearer 直调）", async () => {
    const getGradingContext = vi.fn(async () => ({ sheet: { id: SHEET_ID }, questions: [], sources: [] }));
    const app = createApp(makeServices({ getGradingContext }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/grading-context`, { headers: AGENT_HEADERS });
    expect(res.status).toBe(200);
  });

  it("maps missing sheets to 404 and unsettled sheets to 409", async () => {
    const missing = createApp(makeServices({
      getGradingContext: vi.fn(async () => { throw new NotFoundError("L3Sheet", SHEET_ID); }),
    }));
    expect((await missing.request(`/api/l3/sheets/${SHEET_ID}/grading-context`, { headers: AUTH_HEADERS })).status).toBe(404);
    const conflict = createApp(makeServices({
      getGradingContext: vi.fn(async () => { throw new ConflictError("grading-context requires a sealed sheet"); }),
    }));
    expect((await conflict.request(`/api/l3/sheets/${SHEET_ID}/grading-context`, { headers: AUTH_HEADERS })).status).toBe(409);
  });
});

describe("POST /api/l3/sheets/:id/grading（agent 写面）", () => {
  it("submits as owner with gradedBy resolved from the principal", async () => {
    const submitGrading = vi.fn(async () => ({
      sheet: { id: SHEET_ID }, resultCount: 1, annotationReviewCount: 0, confirmedCount: 0,
    }));
    const app = createApp(makeServices({ submitGrading }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/grading`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ results: [{ questionId: QUESTION_ID, verdict: "wrong", analysisMd: "定位偏移。" }] }),
    });
    expect(res.status).toBe(200);
    expect(submitGrading).toHaveBeenCalledWith({
      userId: "user-123",
      sheetId: SHEET_ID,
      gradedBy: "owner",
      results: [{ questionId: QUESTION_ID, verdict: "wrong", analysisMd: "定位偏移。" }],
    });
  });

  it("resolves gradedBy from the bearer agentId for agent submissions（非自述）", async () => {
    const submitGrading = vi.fn(async () => ({
      sheet: { id: SHEET_ID }, resultCount: 1, annotationReviewCount: 1, confirmedCount: 1,
    }));
    const app = createApp(makeServices({ submitGrading }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/grading`, {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({
        results: [{
          questionId: QUESTION_ID,
          verdict: "correct",
          annotationReviews: [{ annotationId: ANNOTATION_ID, verdict: "sound" }],
        }],
      }),
    });
    expect(res.status).toBe(200);
    expect(submitGrading).toHaveBeenCalledWith(expect.objectContaining({ gradedBy: "agent-a" }));
  });

  it("rejects empty results and unknown keys with 400（graded_by 不可自述）", async () => {
    const submitGrading = vi.fn();
    const app = createApp(makeServices({ submitGrading }));
    const empty = await app.request(`/api/l3/sheets/${SHEET_ID}/grading`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ results: [] }),
    });
    expect(empty.status).toBe(400);
    const spoofed = await app.request(`/api/l3/sheets/${SHEET_ID}/grading`, {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ gradedBy: "fake-agent", results: [{ questionId: QUESTION_ID, verdict: "correct" }] }),
    });
    expect(spoofed.status).toBe(400);
    expect(submitGrading).not.toHaveBeenCalled();
  });
});

describe("GET /api/l3/sheets/:id/grading（解析模式读面）", () => {
  it("returns the verdict rows for the owner", async () => {
    const getGradingResults = vi.fn(async () => ({ sheet: { id: SHEET_ID }, results: [gradingItem()] }));
    const app = createApp(makeServices({ getGradingResults }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/grading`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results).toHaveLength(1);
    expect(getGradingResults).toHaveBeenCalledWith("user-123", SHEET_ID);
  });

  it("is owner-only: an agent bearer gets 403（fail-closed 注册表执行）", async () => {
    const getGradingResults = vi.fn();
    const app = createApp(makeServices({ getGradingResults }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/grading`, { headers: AGENT_HEADERS });
    expect(res.status).toBe(403);
    expect(getGradingResults).not.toHaveBeenCalled();
  });
});

describe("POST /api/l3/annotations/:id/confirm（owner 处置，D18）", () => {
  it("confirms through the owner channel and returns the item", async () => {
    const confirmAnnotation = vi.fn(async () => ({
      item: { id: ANNOTATION_ID, stage: "confirmed", note: "原样", review: { verdict: "sound" } },
    }));
    const app = createApp(makeServices({ confirmAnnotation }));
    const res = await app.request(`/api/l3/annotations/${ANNOTATION_ID}/confirm`, {
      method: "POST", headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { stage: string } };
    expect(body.item.stage).toBe("confirmed");
    expect(confirmAnnotation).toHaveBeenCalledWith("user-123", ANNOTATION_ID);
  });

  it("maps a non-submitted annotation to 409", async () => {
    const app = createApp(makeServices({
      confirmAnnotation: vi.fn(async () => { throw new ConflictError("only submitted annotations can be confirmed"); }),
    }));
    const res = await app.request(`/api/l3/annotations/${ANNOTATION_ID}/confirm`, { method: "POST", headers: AUTH_HEADERS });
    expect(res.status).toBe(409);
  });
});
