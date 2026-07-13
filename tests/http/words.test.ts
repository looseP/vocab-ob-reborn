import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import { Word } from "@/domain/word.entity";
import type { WordRow } from "@/domain";
import { NotFoundError } from "@/errors";
import type { Services } from "@/services";
import {
  wordDetailResponseSchema,
  wordListResponseSchema,
} from "@/http/words-response-contract";

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
        .mockResolvedValue({
          items: [{
            id: "word-1",
            slug: "abound",
            title: "Abound",
            lemma: "abound",
            pos: "verb",
            cefr: "C1",
            ipa: null,
            short_definition: "exist in large numbers",
            metadata: {},
          }],
          total: 1,
          limit: 5,
          offset: 0,
          hasMore: false,
        }),
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

const WORD_ROW: WordRow = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "abound",
  title: "Abound",
  lemma: "abound",
  pos: "verb",
  cefr: "C1",
  ipa: null,
  aliases: ["abounds", "abounded"],
  short_definition: "exist in large numbers",
  definition_md: "To exist in large numbers.",
  body_md: "# abound",
  examples: [{ text: "Fish abound in the lake." }],
  metadata: { word_freq: "C1", semantic_field: "quantity" },
  source_path: "private/content/abound.md",
  source_updated_at: "2026-07-13T00:00:00.000Z",
  content_hash: "private-content-hash",
  is_published: true,
  is_deleted: false,
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
};

// ── Tests ───────────────────────────────────────────────────────────────
describe("GET /api/words", () => {
  it("returns paginated word list", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/words?limit=5", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordListResponseSchema.parse(await res.json());
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
  it("returns a flat public WordDetail when the service returns a real Word entity", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi
      .fn()
      .mockResolvedValue({ word: new Word(WORD_ROW) });
    const app = createApp(services);
    const res = await app.request("/api/words/abound", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const rawBody = await res.json();
    const body = wordDetailResponseSchema.parse(rawBody);

    expect(body).toEqual({
      id: WORD_ROW.id,
      slug: "abound",
      title: "Abound",
      lemma: "abound",
      pos: "verb",
      cefr: "C1",
      ipa: null,
      aliases: ["abounds", "abounded"],
      short_definition: "exist in large numbers",
      definition_md: "To exist in large numbers.",
      body_md: "# abound",
      examples: [{ text: "Fish abound in the lake." }],
      metadata: { word_freq: "C1", semantic_field: "quantity" },
    });
    expect(rawBody).not.toHaveProperty("row");
    expect(rawBody).not.toHaveProperty("content_hash");
    expect(rawBody).not.toHaveProperty("source_path");
    expect(rawBody).not.toHaveProperty("is_deleted");
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
