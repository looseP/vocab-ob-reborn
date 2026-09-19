import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { createMockPool } from "../helpers/mock-db";
import type { L3QuestionAttemptRow, L3SubmissionRow } from "@/domain";

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
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const SOURCE_ID = "00000000-0000-4000-8000-000000000302";
const PAPER_ID = "00000000-0000-4000-8000-000000000303";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000501";

function sheetItem(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    scope: "file",
    scope_key: `file:${SOURCE_ID}:reading_choice`,
    source_id: SOURCE_ID,
    question_type: "reading_choice",
    paper_id: null,
    writing_task_id: null,
    parent_sheet_id: null,
    revision_no: null,
    draft_version: 0,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function attemptItem(overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: ATTEMPT_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: QUESTION_ID,
    sheet_id: SHEET_ID,
    venue: "file",
    answer: { choice: "B" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

function makeServices(l3Sheets: Record<string, unknown>): Services {
  return { l3Sheets } as unknown as Services;
}

describe("POST /api/l3/sheets", () => {
  it("creates a sheet with 201 and passes the owner id through", async () => {
    const openSheet = vi.fn(async () => ({ sheet: sheetItem(), created: true }));
    const app = createApp(makeServices({ openSheet }));
    const res = await app.request("/api/l3/sheets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ scope: "file", sourceId: SOURCE_ID, questionType: "reading_choice" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { sheet: { scope_key: string } };
    expect(body.sheet.scope_key).toBe(`file:${SOURCE_ID}:reading_choice`);
    expect(openSheet).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123", scope: "file", sourceId: SOURCE_ID, questionType: "reading_choice",
    }));
  });

  it("returns 200 (not 201) when the draft sheet is reused", async () => {
    const openSheet = vi.fn(async () => ({ sheet: sheetItem(), created: false }));
    const app = createApp(makeServices({ openSheet }));
    const res = await app.request("/api/l3/sheets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ scope: "paper", paperId: PAPER_ID }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a file scope missing its identity or a paper scope missing paperId", async () => {
    const openSheet = vi.fn();
    const app = createApp(makeServices({ openSheet }));
    for (const body of [{ scope: "file" }, { scope: "paper" }, { scope: "nope" }]) {
      const res = await app.request("/api/l3/sheets", {
        method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(openSheet).not.toHaveBeenCalled();
  });
});

describe("GET /api/l3/sheets/:id", () => {
  it("returns the sheet detail with derived attempts", async () => {
    const getSheet = vi.fn(async () => ({ sheet: sheetItem({ status: "sealed" }), attempts: [attemptItem()] }));
    const app = createApp(makeServices({ getSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts: unknown[] };
    expect(body.attempts).toHaveLength(1);
    expect(getSheet).toHaveBeenCalledWith("user-123", SHEET_ID);
  });
});

describe("PATCH /api/l3/sheets/:id", () => {
  it("merges per-question answers and returns the sheet with its draft_version", async () => {
    const patchSheet = vi.fn(async () => ({
      sheet: sheetItem({ answers: { [QUESTION_ID]: { choice: "C" } }, draft_version: 3 }),
    }));
    const app = createApp(makeServices({ patchSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}`, {
      method: "PATCH",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ expectedVersion: 2, answers: { [QUESTION_ID]: { choice: "C" }, [PAPER_ID]: null } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sheet: { draft_version: number } };
    expect(body.sheet.draft_version).toBe(3); // V：公开响应必含 draft_version（定格基线）
    expect(patchSheet).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      sheetId: SHEET_ID,
      expectedVersion: 2,
      answers: { [QUESTION_ID]: { choice: "C" }, [PAPER_ID]: null },
    }));
  });

  it("rejects a patch without the client-confirmed expectedVersion（缺版本 400，无旁路）", async () => {
    const patchSheet = vi.fn();
    const app = createApp(makeServices({ patchSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ answers: { [QUESTION_ID]: { choice: "C" } } }),
    });
    expect(res.status).toBe(400);
    expect(patchSheet).not.toHaveBeenCalled();
  });

  it("rejects an empty answers merge", async () => {
    const patchSheet = vi.fn();
    const app = createApp(makeServices({ patchSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 0, answers: {} }),
    });
    expect(res.status).toBe(400);
    expect(patchSheet).not.toHaveBeenCalled();
  });
});

describe("POST /api/l3/sheets/:id/seal", () => {
  it("seals with the chosen mode, the confirmed version and returns the counters", async () => {
    const sealSheet = vi.fn(async () => ({
      sheet: sheetItem({ status: "sealed", seal_mode: "full" }),
      unansweredCount: 0,
      recheckCount: 1,
      materializedCount: 2,
      promotedAnnotationCount: 1,
    }));
    const app = createApp(makeServices({ sealSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/seal`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ expectedVersion: 1, mode: "full" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { materializedCount: number; unansweredCount: number; recheckCount: number };
    expect(body.materializedCount).toBe(2);
    expect(body.recheckCount).toBe(1);
    expect(sealSheet).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123", sheetId: SHEET_ID, expectedVersion: 1, mode: "full", acknowledgeUnanswered: false,
    }));
  });

  it("rejects a seal without the client-confirmed expectedVersion（缺版本 400）", async () => {
    const sealSheet = vi.fn();
    const app = createApp(makeServices({ sealSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/seal`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ mode: "full" }),
    });
    expect(res.status).toBe(400);
    expect(sealSheet).not.toHaveBeenCalled();
  });

  it("rejects the summary mode without summary text", async () => {
    const sealSheet = vi.fn();
    const app = createApp(makeServices({ sealSheet }));
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/seal`, {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify({ expectedVersion: 0, mode: "summary" }),
    });
    expect(res.status).toBe(400);
    expect(sealSheet).not.toHaveBeenCalled();
  });
});

describe("GET /api/l3/attempts", () => {
  it("returns batch rows for a comma-separated questionIds list", async () => {
    const listAttempts = vi.fn(async () => ({ items: [attemptItem()] }));
    const app = createApp(makeServices({ listAttempts }));
    const res = await app.request(`/api/l3/attempts?questionIds=${QUESTION_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(listAttempts).toHaveBeenCalledWith("user-123", [QUESTION_ID]);
  });

  it("rejects a missing or malformed questionIds query", async () => {
    const listAttempts = vi.fn();
    const app = createApp(makeServices({ listAttempts }));
    const missing = await app.request("/api/l3/attempts", { headers: AUTH_HEADERS });
    expect(missing.status).toBe(400);
    const bad = await app.request("/api/l3/attempts?questionIds=nope", { headers: AUTH_HEADERS });
    expect(bad.status).toBe(400);
    expect(listAttempts).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/l3/attempts/:id", () => {
  it("soft-deletes with 204", async () => {
    const deleteAttempt = vi.fn(async () => ({ deleted: true }));
    const app = createApp(makeServices({ deleteAttempt }));
    const res = await app.request(`/api/l3/attempts/${ATTEMPT_ID}`, { method: "DELETE", headers: AUTH_HEADERS });
    expect(res.status).toBe(204);
    expect(deleteAttempt).toHaveBeenCalledWith("user-123", ATTEMPT_ID);
  });
});

describe("GET /api/l3/sheets/:id/export", () => {
  it("returns the markdown archive with manifest headers（v2 版本头）", async () => {
    const exportSheet = vi.fn(async () => ({
      markdown: "# L3 题纸档案（v2）\n",
      filename: `l3-sheet-${SHEET_ID.slice(0, 8)}.md`,
      sha256: "a".repeat(64),
      schemaVersion: 2,
      stats: { attempts: 1, cleared: 0, annotations: 0, assessments: 0 },
    }));
    const app = createApp({ l3SheetExport: { exportSheet } } as unknown as Services);
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/export`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".md");
    expect(res.headers.get("x-export-schema-version")).toBe("2");
    expect(res.headers.get("x-export-sha256")).toBe("a".repeat(64));
    await expect(res.text()).resolves.toContain("# L3 题纸档案（v2）");
    // 缺省 withAnswers：路由传 undefined（service 按状态分流）。
    expect(exportSheet).toHaveBeenCalledWith("user-123", SHEET_ID, { withAnswers: undefined });
  });

  it("translates the withAnswers query switch（0/1）", async () => {
    const exportSheet = vi.fn(async () => ({
      markdown: "x", filename: "x.md", sha256: "b".repeat(64), schemaVersion: 2,
      stats: { attempts: 0, cleared: 0, annotations: 0, assessments: 0 },
    }));
    const app = createApp({ l3SheetExport: { exportSheet } } as unknown as Services);
    const one = await app.request(`/api/l3/sheets/${SHEET_ID}/export?withAnswers=1`, { headers: AUTH_HEADERS });
    expect(one.status).toBe(200);
    expect(exportSheet).toHaveBeenLastCalledWith("user-123", SHEET_ID, { withAnswers: true });
    const zero = await app.request(`/api/l3/sheets/${SHEET_ID}/export?withAnswers=0`, { headers: AUTH_HEADERS });
    expect(zero.status).toBe(200);
    expect(exportSheet).toHaveBeenLastCalledWith("user-123", SHEET_ID, { withAnswers: false });
  });

  it("rejects an invalid withAnswers value（service ValidationError → 422 惯例，勿宽容吞掉）", async () => {
    const exportSheet = vi.fn();
    const app = createApp({ l3SheetExport: { exportSheet } } as unknown as Services);
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/export?withAnswers=2`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(422);
    expect(exportSheet).not.toHaveBeenCalled();
  });

  it("V：透传 expectedVersion（数值化）供 draft 版本核对", async () => {
    const exportSheet = vi.fn(async () => ({
      markdown: "x", filename: "x.md", sha256: "c".repeat(64), schemaVersion: 2,
      stats: { attempts: 0, cleared: 0, annotations: 0, assessments: 0 },
    }));
    const app = createApp({ l3SheetExport: { exportSheet } } as unknown as Services);
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/export?expectedVersion=7`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(exportSheet).toHaveBeenLastCalledWith("user-123", SHEET_ID, {
      withAnswers: undefined,
      expectedVersion: 7,
    });
  });

  it("V：非法 expectedVersion → 422（不静默吞掉）", async () => {
    const exportSheet = vi.fn();
    const app = createApp({ l3SheetExport: { exportSheet } } as unknown as Services);
    const res = await app.request(`/api/l3/sheets/${SHEET_ID}/export?expectedVersion=abc`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(422);
    expect(exportSheet).not.toHaveBeenCalled();
  });
});
