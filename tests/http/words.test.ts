import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import { Word } from "@/domain/word.entity";
import type { NoteEntryRow, WordRow } from "@/domain";
import { NotFoundError, ConflictError } from "@/errors";
import type { Services } from "@/services";
import {
  wordBatchCreateResponseSchema,
  wordDeleteResponseSchema,
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
      deleteStubWord: vi.fn().mockResolvedValue({
        deleted: { entityType: "word", id: "word-1" },
        activeReadInvalidation: true,
      }),
    },
    reviews: {
      submitAnswer: vi.fn(),
      skip: vi.fn(),
      suspend: vi.fn(),
      undo: vi.fn(),
    },
    noteEntries: {
      getEntries: vi.fn().mockResolvedValue([]),
      addEntry: vi.fn(),
      editEntry: vi.fn(),
      deleteEntry: vi.fn().mockResolvedValue({ ok: true }),
      hideEntry: vi.fn(),
      restoreEntry: vi.fn(),
    },
    notes: {} as never,
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: "wordbook-1" }),
    } as unknown as never,
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
  core_definitions: [{ sense: "大量存在", en: null, priority: 1, tags: [] }],
  examples: [{ text: "Fish abound in the lake." }],
  metadata: { word_freq: "C1", semantic_field: "quantity" },
  source_path: "private/content/abound.md",
  source_updated_at: "2026-07-13T00:00:00.000Z",
  content_hash: "private-content-hash",
  is_published: true,
  is_deleted: false,
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
  collocations: [
    {
      phrase: "abound in/with",
      gloss: "充满",
      tone: "neutral",
      example: "The region abounds in coal.",
      exampleTranslation: "该地区盛产煤炭。",
      provenance: { source: "dictionary", dictionaryName: "Datamuse" },
    },
  ],
  corpus_items: [
    {
      text: "Opportunities abound for those who persist.",
      translation: "坚持者机会遍地。",
      source: "llm",
    },
  ],
  synonym_items: [
    {
      word: "teem",
      semanticDiff: "teem 强调密集涌动，abound 强调数量充足",
      tone: "neutral",
      usage: "teem with fish",
      delta: "teem 更生动，abound 更中性",
      object: "多用于生物/事物",
    },
  ],
  antonym_items: [{ word: "lack", semanticDiff: "lack 表示缺乏", tone: "neutral", usage: "lack resources", delta: "反义", object: "通用" }],
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
      .mockResolvedValue({ word: new Word(WORD_ROW), l2Promoted: true });
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
      core_definitions: [{ sense: "大量存在", en: null, priority: 1, tags: [] }],
      examples: [{ text: "Fish abound in the lake." }],
      metadata: { word_freq: "C1", semantic_field: "quantity" },
      l2_content: {
        collocations: [
          {
            phrase: "abound in/with",
            gloss: "充满",
            tone: "neutral",
            example: "The region abounds in coal.",
            exampleTranslation: "该地区盛产煤炭。",
            provenance: { source: "dictionary", dictionaryName: "Datamuse" },
          },
        ],
        corpus_items: [
          {
            text: "Opportunities abound for those who persist.",
            translation: "坚持者机会遍地。",
            source: "llm",
          },
        ],
        synonym_items: [
          {
            word: "teem",
            semanticDiff: "teem 强调密集涌动，abound 强调数量充足",
            tone: "neutral",
            usage: "teem with fish",
            delta: "teem 更生动，abound 更中性",
            object: "多用于生物/事物",
          },
        ],
        antonym_items: [{ word: "lack", semanticDiff: "lack 表示缺乏", tone: "neutral", usage: "lack resources", delta: "反义", object: "通用" }],
      },
      l2_promoted: true,
    });
    // v1 溯源字段必须原样透传（溯源徽标依赖），不得被契约剥离
    expect(rawBody.l2_content.collocations[0]).toHaveProperty("provenance");
    expect(rawBody).not.toHaveProperty("row");
    expect(rawBody).not.toHaveProperty("content_hash");
    expect(rawBody).not.toHaveProperty("source_path");
    expect(rawBody).not.toHaveProperty("is_deleted");
    expect(services.words.getWordBySlug).toHaveBeenCalledWith("abound", "user-123");
  });

  it("returns l2_promoted=false when the service reports no L2 promotion", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi
      .fn()
      .mockResolvedValue({ word: new Word(WORD_ROW), l2Promoted: false });
    const app = createApp(services);
    const res = await app.request("/api/words/abound", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordDetailResponseSchema.parse(await res.json());
    expect(body.l2_promoted).toBe(false);
  });

  it("returns empty l2_content arrays when the row omits the JSONB caches", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi
      .fn()
      .mockResolvedValue({ word: new Word({ ...WORD_ROW, collocations: undefined, corpus_items: undefined, synonym_items: undefined, antonym_items: undefined }), l2Promoted: true });
    const app = createApp(services);
    const res = await app.request("/api/words/abound", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordDetailResponseSchema.parse(await res.json());
    expect(body.l2_content).toEqual({
      collocations: [],
      corpus_items: [],
      synonym_items: [],
      antonym_items: [],
    });
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

// ── 0023 stub 生命周期：详情页硬删 stub 词条 ────────────────────────────────
describe("DELETE /api/words/:slug (stub delete)", () => {
  it("deletes a stub and returns the shared delete result shape", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/words/wibble", { method: "DELETE", headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordDeleteResponseSchema.parse(await res.json());
    expect(body).toEqual({
      deleted: { entityType: "word", id: "word-1" },
      activeReadInvalidation: true,
    });
    expect(services.words.deleteStubWord).toHaveBeenCalledWith({ slug: "wibble", userId: "user-123" });
  });

  it("maps a missing slug to 404 NOT_FOUND", async () => {
    const services = makeMockServices();
    services.words.deleteStubWord = vi.fn().mockRejectedValue(new NotFoundError("Word", "missing"));
    const app = createApp(services);
    const res = await app.request("/api/words/missing", { method: "DELETE", headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });

  it("maps blockers to 409 CONFLICT with the details.blockers wire contract", async () => {
    const services = makeMockServices();
    services.words.deleteStubWord = vi.fn().mockRejectedValue(
      new ConflictError("Cannot delete word with active dependencies", undefined, {
        entityType: "word",
        id: "word-1",
        blockers: { l3OccurrenceCount: 2, noteEntryCount: 1, inboundWordLinkCount: 3 },
      }),
    );
    const app = createApp(services);
    const res = await app.request("/api/words/wibble", { method: "DELETE", headers: AUTH_HEADERS });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "CONFLICT",
      details: {
        entityType: "word",
        id: "word-1",
        blockers: { l3OccurrenceCount: 2, noteEntryCount: 1, inboundWordLinkCount: 3 },
      },
    });
  });
});

// ── 条目制笔记端点（2026-09-06）：notes / entries 管理 ─────────────────────
const NOTE_WORD = { id: "word-1" };
const ISO_CREATED = "2026-09-06T00:00:00.000Z";
const ISO_UPDATED = "2026-09-06T01:00:00.000Z";
const ISO_HIDDEN = "2026-09-06T02:00:00.000Z";

function noteEntryRow(overrides: Partial<NoteEntryRow> = {}): NoteEntryRow {
  return {
    id: "entry-1",
    user_id: "user-123",
    word_id: "word-1",
    wordbook_id: "wordbook-1",
    content_md: "first note",
    hidden_at: null,
    created_at: ISO_CREATED,
    updated_at: ISO_UPDATED,
    ...overrides,
  };
}

describe("GET /api/words/:slug/notes", () => {
  it("maps entries to ISO timestamps and counts hidden entries (both toIso arms)", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi.fn().mockResolvedValue({ word: NOTE_WORD, l2Promoted: false });
    // one visible entry (hidden_at null → exercise the null arm) and one hidden
    // entry (hidden_at set → exercise the ISO arm), so the hidden_count filter
    // and both branches of `toIso`'s ternary are hit.
    services.noteEntries.getEntries = vi.fn().mockResolvedValue([
      noteEntryRow({ id: "entry-visible", hidden_at: null }),
      noteEntryRow({ id: "entry-hidden", content_md: "hidden note", hidden_at: ISO_HIDDEN }),
    ]);
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(services.words.getWordBySlug).toHaveBeenCalledWith("abound");
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.noteEntries.getEntries).toHaveBeenCalledWith("user-123", "word-1", "wordbook-1");
    expect(body.hidden_count).toBe(1);
    expect(body.entries).toEqual([
      {
        id: "entry-visible",
        content_md: "first note",
        hidden_at: null,
        created_at: ISO_CREATED,
        updated_at: ISO_UPDATED,
      },
      {
        id: "entry-hidden",
        content_md: "hidden note",
        hidden_at: ISO_HIDDEN,
        created_at: ISO_CREATED,
        updated_at: ISO_UPDATED,
      },
    ]);
  });

  it("returns an empty list with hidden_count=0 when there are no entries", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi.fn().mockResolvedValue({ word: NOTE_WORD, l2Promoted: false });
    services.noteEntries.getEntries = vi.fn().mockResolvedValue([]);
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], hidden_count: 0 });
  });
});

describe("POST /api/words/:slug/notes/entries", () => {
  it("creates an entry and returns 201 with hidden_at=null", async () => {
    const services = makeMockServices();
    services.words.getWordBySlug = vi.fn().mockResolvedValue({ word: NOTE_WORD, l2Promoted: false });
    services.noteEntries.addEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-new", content_md: "brand new" }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "brand new" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(services.noteEntries.addEntry).toHaveBeenCalledWith("user-123", "word-1", "brand new");
    expect(body).toEqual({
      entry: {
        id: "entry-new",
        content_md: "brand new",
        hidden_at: null,
        created_at: ISO_CREATED,
        updated_at: ISO_UPDATED,
      },
    });
  });

  it("rejects an empty content body with 400 VALIDATION_ERROR", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expect(services.noteEntries.addEntry).not.toHaveBeenCalled();
  });
});

describe("PUT /api/words/:slug/notes/entries/:entryId", () => {
  it("edits content and returns hidden_at=null for a visible entry", async () => {
    const services = makeMockServices();
    services.noteEntries.editEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-1", content_md: "edited", hidden_at: null }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1", {
      method: "PUT",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "edited" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(services.noteEntries.editEntry).toHaveBeenCalledWith("user-123", "entry-1", "edited");
    expect(body.entry).toEqual({
      id: "entry-1",
      content_md: "edited",
      hidden_at: null,
      created_at: ISO_CREATED,
      updated_at: ISO_UPDATED,
    });
  });

  it("preserves hidden_at as ISO when editing a hidden entry", async () => {
    const services = makeMockServices();
    services.noteEntries.editEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-2", content_md: "edited hidden", hidden_at: ISO_HIDDEN }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-2", {
      method: "PUT",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "edited hidden" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.hidden_at).toBe(ISO_HIDDEN);
    expect(body.entry.content_md).toBe("edited hidden");
  });

  it("rejects an empty content body with 400 VALIDATION_ERROR", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1", {
      method: "PUT",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expect(services.noteEntries.editEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/words/:slug/notes/entries/:entryId", () => {
  it("hard-deletes an entry and returns {ok:true}", async () => {
    const services = makeMockServices();
    services.noteEntries.deleteEntry = vi.fn().mockResolvedValue({ ok: true });
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1", {
      method: "DELETE",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(services.noteEntries.deleteEntry).toHaveBeenCalledWith("user-123", "entry-1");
  });
});

describe("POST /api/words/:slug/notes/entries/:entryId/hide", () => {
  it("hides an entry and returns hidden_at as ISO", async () => {
    const services = makeMockServices();
    services.noteEntries.hideEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-1", content_md: "hidden now", hidden_at: ISO_HIDDEN }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1/hide", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(services.noteEntries.hideEntry).toHaveBeenCalledWith("user-123", "entry-1");
    expect(body.entry.hidden_at).toBe(ISO_HIDDEN);
    expect(body.entry.content_md).toBe("hidden now");
  });

  it("returns hidden_at=null when the service reports no hidden timestamp", async () => {
    const services = makeMockServices();
    services.noteEntries.hideEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-1", hidden_at: null }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1/hide", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.hidden_at).toBeNull();
  });
});

describe("POST /api/words/:slug/notes/entries/:entryId/restore", () => {
  it("restores an entry and returns hidden_at=null", async () => {
    const services = makeMockServices();
    services.noteEntries.restoreEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-1", content_md: "restored", hidden_at: null }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1/restore", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(services.noteEntries.restoreEntry).toHaveBeenCalledWith("user-123", "entry-1");
    expect(body.entry.hidden_at).toBeNull();
    expect(body.entry.content_md).toBe("restored");
  });

  it("returns hidden_at as ISO when the service reports a still-hidden entry", async () => {
    const services = makeMockServices();
    services.noteEntries.restoreEntry = vi.fn().mockResolvedValue(
      noteEntryRow({ id: "entry-1", hidden_at: ISO_HIDDEN }),
    );
    const app = createApp(services);

    const res = await app.request("/api/words/abound/notes/entries/entry-1/restore", {
      method: "POST",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.hidden_at).toBe(ISO_HIDDEN);
  });
});
