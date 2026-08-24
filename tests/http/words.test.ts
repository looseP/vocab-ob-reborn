import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import { Word } from "@/domain/word.entity";
import type { WordRow } from "@/domain";
import { NotFoundError } from "@/errors";
import type { Services } from "@/services";
import {
  wordBatchCreateResponseSchema,
  wordDetailResponseSchema,
  wordListResponseSchema,
} from "@/http/words-response-contract";

// 鈹€鈹€ Auth env setup 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

// 鈹€鈹€ Mock services (no DB) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
      batchCreate: vi.fn().mockResolvedValue({ inserted: 0 }),
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
      prototype_text: null,
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

// 鈹€鈹€ Tests 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
      prototype_text: null,
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

describe("POST /api/words/batch", () => {
  it("sanitizes rows, delegates to batchCreate, and matches the response contract", async () => {
    const services = makeMockServices();
    services.words.batchCreate = vi.fn().mockResolvedValue({ inserted: 2 });
    const app = createApp(services);

    const res = await app.request("/api/words/batch", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        words: [
          { lemma: "Blue Sky!", short_definition: "a wide sky" },
          { slug: "existing", title: "Existing", lemma: "existing", pos: "noun" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = wordBatchCreateResponseSchema.parse(await res.json());
    expect(body).toEqual({ inserted: 2 });

    // slug derives from lemma, lowercased with non [a-z0-9-] collapsed to "-";
    // title/lemma fall back to each other; missing optionals become null
    expect(services.words.batchCreate).toHaveBeenCalledWith([
      { slug: "blue-sky-", title: "Blue Sky!", lemma: "Blue Sky!", pos: null, cefr: null, ipa: null, short_definition: "a wide sky" },
      { slug: "existing", title: "Existing", lemma: "existing", pos: "noun", cefr: null, ipa: null, short_definition: null },
    ]);
  });

  it("rejects a missing or empty words array with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const missing = await app.request("/api/words/batch", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const empty = await app.request("/api/words/batch", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ words: [] }),
    });
    expect(empty.status).toBe(400);
    expect(services.words.batchCreate).not.toHaveBeenCalled();
  });

  it("rejects batches larger than 500 words with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const words = Array.from({ length: 501 }, (_, i) => ({ lemma: `w-${i}` }));

    const res = await app.request("/api/words/batch", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ words }),
    });

    expect(res.status).toBe(400);
    expect(services.words.batchCreate).not.toHaveBeenCalled();
  });

  it("drops rows whose sanitized slug is empty", async () => {
    const services = makeMockServices();
    services.words.batchCreate = vi.fn().mockResolvedValue({ inserted: 2 });
    const app = createApp(services);

    const res = await app.request("/api/words/batch", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        words: [
          { lemma: "" },
          { lemma: "!!!" },
          { lemma: "valid" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 2 });
    // empty lemma sanitizes to "" and is dropped; "!!!" sanitizes to "---"
    // (non-empty, kept as-is); only the empty row is filtered out
    expect(services.words.batchCreate).toHaveBeenCalledWith([
      { slug: "---", title: "!!!", lemma: "!!!", pos: null, cefr: null, ipa: null, short_definition: null },
      { slug: "valid", title: "valid", lemma: "valid", pos: null, cefr: null, ipa: null, short_definition: null },
    ]);
  });

  it("rejects missing credentials with 401", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/words/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: [{ lemma: "valid" }] }),
    });
    expect(res.status).toBe(401);
    expect(services.words.batchCreate).not.toHaveBeenCalled();
  });
});
