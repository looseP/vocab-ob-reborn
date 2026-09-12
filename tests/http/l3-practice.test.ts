import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { ValidationError } from "@/errors";
import type { Services } from "@/services";
import {
  l3PracticeAttemptPageResponseSchema,
  l3PracticeErrorBookPageResponseSchema,
} from "@/http/l3-practice-response-contract";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

const CONTEXT_ID = "00000000-0000-4000-8000-000000000002";
const OCCURRENCE_ID = "00000000-0000-4000-8000-000000000011";

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };

const ATTEMPT_ROW = {
  id: "attempt-1",
  user_id: "user-123",
  context_id: CONTEXT_ID,
  occurrence_id: null,
  session_id: null,
  practice_type: "context_quiz",
  outcome: "correct",
  payload: { taskId: "context_quiz:abc123" },
  created_at: "2026-09-11T00:00:00.000Z",
};

const PAGE = { items: [ATTEMPT_ROW], total: 1, limit: 20, offset: 0 };

const ERROR_BOOK_ITEM = {
  ...ATTEMPT_ROW,
  wrongCount: 2,
  latestOutcome: "wrong",
  latestAt: "2026-09-11T00:00:00.000Z",
};

const ERROR_BOOK_PAGE = { items: [ERROR_BOOK_ITEM], total: 1, limit: 20, offset: 0, nextCursor: null };

async function expectRouteValidationError(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json() as { code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
}

async function expectServiceError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json() as { code: string };
  expect(body.code).toBe(code);
}

function makeMockServices() {
  const l3Practice = {
    recordAttempt: vi.fn(async () => ATTEMPT_ROW),
    listAttempts: vi.fn(async () => PAGE),
    errorBook: vi.fn(async () => ERROR_BOOK_PAGE),
  };
  return { services: { l3Practice } as unknown as Services, l3Practice };
}

describe("L3 practice HTTP routes", () => {
  it("POST /attempts records an attempt and returns 201", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/attempts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        contextId: CONTEXT_ID,
        practiceType: "context_quiz",
        outcome: "correct",
        payload: { taskId: "context_quiz:abc123", hidden: true },
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(ATTEMPT_ROW);
    expect(l3Practice.recordAttempt).toHaveBeenCalledWith({
      userId: "user-123",
      contextId: CONTEXT_ID,
      occurrenceId: null,
      sessionId: null,
      practiceType: "context_quiz",
      outcome: "correct",
      payload: { taskId: "context_quiz:abc123", hidden: true },
    });
  });

  it("POST /attempts rejects a payload without taskId before any service call", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/attempts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        contextId: CONTEXT_ID,
        practiceType: "context_quiz",
        outcome: "correct",
        payload: { hidden: true },
      }),
    });

    await expectRouteValidationError(res);
    expect(l3Practice.recordAttempt).not.toHaveBeenCalled();
  });

  it("POST /attempts rejects an empty taskId and an unknown enum", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const emptyTaskId = await app.request("/api/l3-practice/attempts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ contextId: CONTEXT_ID, practiceType: "context_quiz", outcome: "correct", payload: { taskId: "  " } }),
    });
    await expectRouteValidationError(emptyTaskId);

    const unknownType = await app.request("/api/l3-practice/attempts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ contextId: CONTEXT_ID, practiceType: "bogus", outcome: "correct", payload: { taskId: "t1" } }),
    });
    await expectRouteValidationError(unknownType);

    expect(l3Practice.recordAttempt).not.toHaveBeenCalled();
  });

  it("POST /attempts forwards optional occurrence and session ids", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    await app.request("/api/l3-practice/attempts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        contextId: CONTEXT_ID,
        occurrenceId: OCCURRENCE_ID,
        practiceType: "essay_dictation",
        outcome: "wrong",
        payload: { taskId: "essay_dictation:xyz" },
      }),
    });

    expect(l3Practice.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      occurrenceId: OCCURRENCE_ID,
      sessionId: null,
      practiceType: "essay_dictation",
      outcome: "wrong",
    }));
  });

  it("GET /attempts maps query filters and returns the offset page", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(
      "/api/l3-practice/attempts?practiceType=context_quiz&outcome=wrong&space=阅读&direction=考研&limit=10&offset=5",
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(l3PracticeAttemptPageResponseSchema.parse(body)).toEqual(PAGE);
    expect(l3Practice.listAttempts).toHaveBeenCalledWith({
      userId: "user-123",
      practiceType: "context_quiz",
      outcome: "wrong",
      space: "阅读",
      direction: "考研",
      limit: 10,
      offset: 5,
    });
  });

  it("GET /attempts defaults omitted filters to null", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/attempts", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    expect(l3Practice.listAttempts).toHaveBeenCalledWith({
      userId: "user-123",
      practiceType: null,
      outcome: null,
      space: null,
      direction: null,
      limit: null,
      offset: null,
    });
  });

  it("GET /attempts rejects an invalid filter enum", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/attempts?practiceType=bogus", { headers: AUTH_HEADERS });

    await expectRouteValidationError(res);
    expect(l3Practice.listAttempts).not.toHaveBeenCalled();
  });

  it("GET /error-book returns the aggregated page and forwards the two axes", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/error-book?space=语法&direction=雅思&limit=3&offset=1", {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(l3PracticeErrorBookPageResponseSchema.parse(body)).toEqual(ERROR_BOOK_PAGE);
    expect(l3Practice.errorBook).toHaveBeenCalledWith({
      userId: "user-123",
      space: "语法",
      direction: "雅思",
      limit: 3,
      offset: 1,
      cursor: null,
    });
  });

  it("GET /error-book accepts a cursor and forwards it alongside offset (precedence: service)", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/error-book?cursor=abc123&offset=5&limit=2", {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(l3Practice.errorBook).toHaveBeenCalledWith({
      userId: "user-123",
      space: null,
      direction: null,
      limit: 2,
      offset: 5,
      cursor: "abc123",
    });
  });

  it("GET /error-book works without pagination params (defaults forwarded as null)", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/error-book", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    expect(l3Practice.errorBook).toHaveBeenCalledWith({
      userId: "user-123",
      space: null,
      direction: null,
      limit: null,
      offset: null,
      cursor: null,
    });
  });

  it("GET /error-book rejects an empty cursor", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/error-book?cursor=", { headers: AUTH_HEADERS });

    await expectRouteValidationError(res);
    expect(l3Practice.errorBook).not.toHaveBeenCalled();
  });

  it("GET /error-book rejects an invalid space", async () => {
    const { services, l3Practice } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/error-book?space=bogus", { headers: AUTH_HEADERS });

    await expectRouteValidationError(res);
    expect(l3Practice.errorBook).not.toHaveBeenCalled();
  });

  it("maps a service ValidationError to 422", async () => {
    const { services, l3Practice } = makeMockServices();
    l3Practice.recordAttempt = vi.fn(async () => {
      throw new ValidationError("payload.taskId is required", "taskId");
    });
    const app = createApp(services);

    const res = await app.request("/api/l3-practice/attempts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ contextId: CONTEXT_ID, practiceType: "context_quiz", outcome: "correct", payload: { taskId: "t1" } }),
    });

    await expectServiceError(res, 422, "VALIDATION_ERROR");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l3-practice/attempts");
    expect(res.status).toBe(401);
  });
});
