import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";

// ── Auth env setup ──────────────────────────────────────────────────────
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

// ── Mock services (no DB) ───────────────────────────────────────────────
function makeMockServices(): Services {
  return {
    words: {} as never,
    reviews: {
      submitAnswer: vi.fn().mockResolvedValue({
        ok: true,
        reviewLogId: "log-1",
        nextDueAt: "2026-01-16T12:00:00Z",
        state: "review",
      }),
      skip: vi.fn().mockResolvedValue({ ok: true }),
      suspend: vi.fn().mockResolvedValue({ ok: true }),
      undo: vi.fn().mockResolvedValue({ ok: true }),
    },
    notes: {} as never,
    wordbooks: {} as never,
    stats: {} as never,
  } as unknown as Services;
}

const AUTH_HEADERS = {
  Authorization: "Bearer test-owner",
  "Content-Type": "application/json",
};

// Valid UUIDs (schemas require uuid for progressId/sessionId)
const PROGRESS_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

// ── Tests ───────────────────────────────────────────────────────────────
describe("POST /api/review/answer", () => {
  it("accepts valid answer and returns result", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        progressId: PROGRESS_ID,
        rating: "good",
        sessionId: SESSION_ID,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reviewLogId: string };
    expect(body.ok).toBe(true);
    expect(body.reviewLogId).toBe("log-1");
    expect(services.reviews.submitAnswer).toHaveBeenCalledTimes(1);
    expect(services.reviews.submitAnswer).toHaveBeenCalledWith({
      progressId: PROGRESS_ID,
      rating: "good",
      sessionId: SESSION_ID,
    }, "user-123");
  });

  it("rejects invalid body with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
    expect(services.reviews.submitAnswer).not.toHaveBeenCalled();
  });

  it("rejects invalid rating enum with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        progressId: PROGRESS_ID,
        rating: "medium", // not in [again,hard,good,easy]
        sessionId: SESSION_ID,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("forwards optional idempotencyKey when present", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        progressId: PROGRESS_ID,
        rating: "easy",
        sessionId: SESSION_ID,
        idempotencyKey: "client-key-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(services.reviews.submitAnswer).toHaveBeenCalledWith({
      progressId: PROGRESS_ID,
      rating: "easy",
      sessionId: SESSION_ID,
      idempotencyKey: "client-key-1",
    }, "user-123");
  });
});

describe("POST /api/review/skip", () => {
  it("passes userId from auth context as second arg", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/skip", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ progressId: PROGRESS_ID, sessionId: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    expect(services.reviews.skip).toHaveBeenCalledTimes(1);
    const callArgs = (services.reviews.skip as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toEqual({ progressId: PROGRESS_ID, sessionId: SESSION_ID });
    // userId from LOCAL_OWNER_ID env, injected by authMiddleware
    expect(callArgs[1]).toBe("user-123");
  });
});

describe("POST /api/review/suspend", () => {
  it("suspends with userId", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/suspend", {
      method: "POST",
      headers: AUTH_HEADERS,
      // sessionId optional for suspend
      body: JSON.stringify({ progressId: PROGRESS_ID }),
    });
    expect(res.status).toBe(200);
    expect(services.reviews.suspend).toHaveBeenCalledTimes(1);
    const callArgs = (services.reviews.suspend as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toBe("user-123");
  });
});

describe("API request body limit", () => {
  it("rejects payloads over 1 MiB before invoking the route handler", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: "Request body exceeds 1 MiB limit",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(services.reviews.submitAnswer).not.toHaveBeenCalled();
  });
});

describe("POST /api/review/undo", () => {
  it("undoes with reviewLogId + userId", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/undo", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ reviewLogId: "log-1", sessionId: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    expect(services.reviews.undo).toHaveBeenCalledTimes(1);
    const callArgs = (services.reviews.undo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toEqual({ reviewLogId: "log-1", sessionId: SESSION_ID });
    expect(callArgs[1]).toBe("user-123");
  });

  it("rejects missing reviewLogId with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/undo", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(res.status).toBe(400);
    expect(services.reviews.undo).not.toHaveBeenCalled();
  });
});
