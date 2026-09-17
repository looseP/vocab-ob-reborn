import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { NotFoundError } from "@/errors";
import type { Services } from "@/services";
import { createMockPool } from "../helpers/mock-db";
import type { L3QuestionAnnotationRow } from "@/domain";

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
const ANNOTATION_ID = "00000000-0000-4000-8000-000000000201";

function annotationItem(overrides: Partial<L3QuestionAnnotationRow> = {}): L3QuestionAnnotationRow {
  return {
    id: ANNOTATION_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: QUESTION_ID,
    ordinal: 0,
    anchor_start: 12,
    anchor_end: 20,
    excerpt: "trap phrase",
    note: "B 偷换概念",
    entry_tags: ["推断题"],
    option_tags: { B: ["偷换概念"] },
    stage: "confirmed",
    sheet_id: null,
    review: null,
    status: "active",
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeServices(l3Annotations: Record<string, unknown>): Services {
  return { l3Annotations } as unknown as Services;
}

async function expectValidationError(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json() as { code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
}

describe("GET /api/l3/question-annotations", () => {
  it("returns the items for a comma-separated questionIds list", async () => {
    const listForQuestions = vi.fn(async () => ({ items: [annotationItem()] }));
    const app = createApp(makeServices({ listForQuestions }));
    const res = await app.request(`/api/l3/question-annotations?questionIds=${QUESTION_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [annotationItem()] });
    expect(listForQuestions).toHaveBeenCalledWith("user-123", [QUESTION_ID]);
  });

  it("rejects a missing or non-uuid questionIds query", async () => {
    const app = createApp(makeServices({}));
    const missing = await app.request("/api/l3/question-annotations", { headers: AUTH_HEADERS });
    await expectValidationError(missing);
    const bad = await app.request("/api/l3/question-annotations?questionIds=nope", { headers: AUTH_HEADERS });
    await expectValidationError(bad);
  });
});

describe("POST /api/l3/question-annotations", () => {
  const validBody = {
    questionId: QUESTION_ID,
    anchorStart: 12,
    anchorEnd: 20,
    excerpt: "trap phrase",
    note: "B 偷换概念",
    entryTags: ["推断题"],
    optionTags: { B: ["偷换概念"] },
  };

  it("creates a new annotation with 201", async () => {
    const createAnnotation = vi.fn(async () => ({ item: annotationItem(), idempotent: false }));
    const app = createApp(makeServices({ createAnnotation }));
    const res = await app.request("/api/l3/question-annotations", {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.item.id).toBe(ANNOTATION_ID);
    expect(createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-123", questionId: QUESTION_ID }));
  });

  it("returns 200 (not 201) on an idempotent anchor hit", async () => {
    const createAnnotation = vi.fn(async () => ({ item: annotationItem(), idempotent: true }));
    const app = createApp(makeServices({ createAnnotation }));
    const res = await app.request("/api/l3/question-annotations", {
      method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an empty loose entry", async () => {
    const createAnnotation = vi.fn();
    const app = createApp(makeServices({ createAnnotation }));
    const res = await app.request("/api/l3/question-annotations", {
      method: "POST", headers: AUTH_HEADERS,
      body: JSON.stringify({ questionId: QUESTION_ID }),
    });
    await expectValidationError(res);
    expect(createAnnotation).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/l3/question-annotations/:id", () => {
  it("updates and returns the item", async () => {
    const patchAnnotation = vi.fn(async () => ({ item: annotationItem({ note: "改后" }) }));
    const app = createApp(makeServices({ patchAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ note: "改后" }),
    });
    expect(res.status).toBe(200);
    expect(patchAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123", id: ANNOTATION_ID, note: "改后",
    }));
  });

  it("translates a missing row to 404", async () => {
    const patchAnnotation = vi.fn(async () => {
      throw new NotFoundError("L3QuestionAnnotation", ANNOTATION_ID);
    });
    const app = createApp(makeServices({ patchAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}`, {
      method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ note: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/l3/question-annotations/:id", () => {
  it("soft-deletes with 204 and an empty body", async () => {
    const deleteAnnotation = vi.fn(async () => ({ deleted: true }));
    const app = createApp(makeServices({ deleteAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}`, {
      method: "DELETE", headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(deleteAnnotation).toHaveBeenCalledWith("user-123", ANNOTATION_ID);
  });

  it("translates a missing row to 404", async () => {
    const deleteAnnotation = vi.fn(async () => {
      throw new NotFoundError("L3QuestionAnnotation", ANNOTATION_ID);
    });
    const app = createApp(makeServices({ deleteAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}`, {
      method: "DELETE", headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

describe("annotation tag dictionary", () => {
  it("GET returns the seeded dictionary", async () => {
    const getTagDict = vi.fn(async () => ({ entry: ["细节题"], option: ["无中生有"] }));
    const app = createApp(makeServices({ getTagDict }));
    const res = await app.request("/api/l3/annotation-tags", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ entry: ["细节题"], option: ["无中生有"] });
  });

  it("PUT replaces the whole dictionary", async () => {
    const replaceTagDict = vi.fn(async () => ({ entry: ["自定义"], option: [] }));
    const app = createApp(makeServices({ replaceTagDict }));
    const res = await app.request("/api/l3/annotation-tags", {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify({ entry: ["自定义"], option: [] }),
    });
    expect(res.status).toBe(200);
    expect(replaceTagDict).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-123", entry: ["自定义"] }));
  });

  it("PUT rejects a payload missing either kind", async () => {
    const app = createApp(makeServices({}));
    const res = await app.request("/api/l3/annotation-tags", {
      method: "PUT", headers: AUTH_HEADERS, body: JSON.stringify({ entry: [] }),
    });
    await expectValidationError(res);
  });
});

describe("POST /api/l3/question-annotations/:id/withdraw", () => {
  const SHEET_ID = "00000000-0000-4000-8000-000000000401";

  it("withdraws a submitted annotation to draft on the given sheet", async () => {
    const withdrawAnnotation = vi.fn(async () => ({
      item: annotationItem({ stage: "draft", sheet_id: SHEET_ID }),
    }));
    const app = createApp(makeServices({ withdrawAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}/withdraw`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sheetId: SHEET_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { stage: string; sheet_id: string | null } };
    expect(body.item.stage).toBe("draft");
    expect(body.item.sheet_id).toBe(SHEET_ID);
    expect(withdrawAnnotation).toHaveBeenCalledWith({ userId: "user-123", id: ANNOTATION_ID, sheetId: SHEET_ID });
  });

  it("accepts an empty body (service reopens the sheet by the origin scope)", async () => {
    const withdrawAnnotation = vi.fn(async () => ({ item: annotationItem({ stage: "draft" }) }));
    const app = createApp(makeServices({ withdrawAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}/withdraw`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(withdrawAnnotation).toHaveBeenCalledWith({ userId: "user-123", id: ANNOTATION_ID });
  });

  it("rejects a non-uuid sheetId", async () => {
    const withdrawAnnotation = vi.fn();
    const app = createApp(makeServices({ withdrawAnnotation }));
    const res = await app.request(`/api/l3/question-annotations/${ANNOTATION_ID}/withdraw`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sheetId: "not-a-uuid" }),
    });
    await expectValidationError(res);
    expect(withdrawAnnotation).not.toHaveBeenCalled();
  });
});
