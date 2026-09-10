import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";

// ── Auth env setup ────────────────────────────────────────────────────────
// authMiddleware resolves the bearer token against OWNER_API_TOKEN. Setting it
// maps "test-owner" to role=owner, satisfying app.use("/api/*", authMiddleware(...,"owner")).
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

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

// Minimal mock services — only the collaborators the promotion route touches.
// `createApp` never invokes any service method at construction time, so the
// bearer-token auth path (which never reaches authSessions) is all that runs.
function makeMockServices(): Services {
  return {
    words: {
      getWordBySlug: vi.fn().mockResolvedValue({ word: { id: "word-1" }, l2Promoted: false }),
    },
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: "wordbook-1" }),
    },
    reviews: {
      getProgressSnapshot: vi.fn(),
    },
    l2Transition: {
      promoteNow: vi.fn().mockResolvedValue({
        alreadyPromoted: false,
        l2DueAt: "2026-09-20T00:00:00.000Z",
      }),
    },
  } as unknown as Services;
}

describe("POST /api/l2/:slug/promote", () => {
  it("promotes using the L1 snapshot and returns the promotion result", async () => {
    const services = makeMockServices();
    services.reviews.getProgressSnapshot = vi.fn().mockResolvedValue({
      user_id: "user-123",
      wordbook_id: "wordbook-1",
      word_id: "word-1",
      stability: 25,
      difficulty: 5.5,
      review_count: 7,
      last_rating: "good",
    });
    services.l2Transition.promoteNow = vi.fn().mockResolvedValue({
      alreadyPromoted: false,
      l2DueAt: "2026-09-20T00:00:00.000Z",
    });
    const app = createApp(services);

    const res = await app.request("/api/l2/abound/promote", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, alreadyPromoted: false, l2DueAt: "2026-09-20T00:00:00.000Z" });

    expect(services.words.getWordBySlug).toHaveBeenCalledWith("abound");
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.reviews.getProgressSnapshot).toHaveBeenCalledWith("user-123", "wordbook-1", "word-1");
    // Inherit arithmetic: stability passed through unchanged (non-null arm of `??`).
    expect(services.l2Transition.promoteNow).toHaveBeenCalledWith({
      user_id: "user-123",
      wordbook_id: "wordbook-1",
      word_id: "word-1",
      stability: 25,
      difficulty: 5.5,
      review_count: 7,
      last_rating: "good",
    });
  });

  it("returns 422 BUSINESS_RULE when the word is not yet tracked in L1", async () => {
    const services = makeMockServices();
    services.reviews.getProgressSnapshot = vi.fn().mockResolvedValue(null);
    const app = createApp(services);

    const res = await app.request("/api/l2/abound/promote", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("BUSINESS_RULE");
    expect(body.error).toBe("该词尚未加入复习，请先在词条库将其加入复习后再晋升");
    expect(services.l2Transition.promoteNow).not.toHaveBeenCalled();
  });

  it("defaults stability to 0 when the L1 snapshot has no stability (?? fallback)", async () => {
    const services = makeMockServices();
    services.reviews.getProgressSnapshot = vi.fn().mockResolvedValue({
      user_id: "user-123",
      wordbook_id: "wordbook-1",
      word_id: "word-1",
      stability: null,
      difficulty: null,
      review_count: 0,
      last_rating: null,
    });
    const app = createApp(services);

    const res = await app.request("/api/l2/abound/promote", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, alreadyPromoted: false, l2DueAt: "2026-09-20T00:00:00.000Z" });

    const callArg = (services.l2Transition.promoteNow as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.stability).toBe(0);
    expect(callArg.difficulty).toBeNull();
    expect(callArg.review_count).toBe(0);
    expect(callArg.last_rating).toBeNull();
  });
});
