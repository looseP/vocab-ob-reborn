import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import { NotFoundError } from "@/errors";
import type { Services } from "@/services";

// ── Auth env setup ──────────────────────────────────────────────────────
// authMiddleware resolves the bearer token against OWNER_API_TOKEN.
// We set it so "test-owner" maps to role=owner, satisfying app.use("/api/*", authMiddleware("owner")).
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
    words: {
      getPublicWords: vi
        .fn()
        .mockResolvedValue({ items: [{ slug: "abound", lemma: "abound" }], total: 1 }),
      getWordBySlug: vi.fn(),
      getWordCount: vi.fn().mockResolvedValue(1),
      getAllSlugs: vi.fn().mockResolvedValue(["abound"]),
    },
    reviews: {
      submitAnswer: vi.fn(),
      skip: vi.fn(),
      suspend: vi.fn(),
      undo: vi.fn(),
    },
    notes: {} as never,
    wordbooks: {} as never,
    stats: {} as never,
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

// ── Tests ───────────────────────────────────────────────────────────────
describe("GET /api/words", () => {
  it("returns paginated word list", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/words?limit=5", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { slug: string }[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe("abound");
    // service called with parsed query (limit coerced to number, defaults applied)
    expect(services.words.getPublicWords).toHaveBeenCalledTimes(1);
    const callArg = (services.words.getPublicWords as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.limit).toBe(5);
    expect(callArg.offset).toBe(0);
    expect(callArg.userId).toBe("user-123");
  });

  it("rejects missing credentials with 401 and a Bearer challenge", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/words");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="vocab-observatory"');
  });

  it("rejects invalid query with 400 (limit out of range)", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/words?limit=999", { headers: AUTH_HEADERS });
    expect(res.status).toBe(400);
    expect(services.words.getPublicWords).not.toHaveBeenCalled();
  });
});

describe("GET /api/words/:slug", () => {
  it("returns word when found", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi
      .fn()
      .mockResolvedValue({ word: { slug: "abound", lemma: "abound" } });
    const app = createApp(services);
    const res = await app.request("/api/words/abound", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; lemma: string };
    expect(body.slug).toBe("abound");
    expect(services.words.getWordBySlug).toHaveBeenCalledWith("abound");
  });

  it("returns 404 when not found", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi
      .fn()
      .mockRejectedValue(new NotFoundError("Word", "nonexistent"));
    const app = createApp(services);
    const res = await app.request("/api/words/nonexistent", { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
  });
});
