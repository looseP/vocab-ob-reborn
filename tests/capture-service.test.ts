import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  INoteEntryRepository,
  IRepositories,
  IWordRepository,
  IWordbookRepository,
} from "@/repositories/interfaces";
import type { WordRow } from "@/domain";
import { CaptureService, slugifyHeadword } from "@/services/capture.service";
import { plazaCache } from "@/services/plaza-cache";
import { ValidationError } from "@/errors";

// ── Mock infrastructure (same pattern as review-enqueue.test.ts) ─────────
const mockRepos: Partial<IRepositories> = {};

const { withTransactionMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(async (
    cb: (tx: unknown) => Promise<unknown>,
    _options?: { actorId?: string },
  ) => cb({})),
}));

vi.mock("@/db/transaction", () => ({
  withTransaction: withTransactionMock,
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

function makeWordRow(overrides: Partial<WordRow> = {}): WordRow {
  return {
    id: "w-1",
    slug: "ephemeral",
    title: "ephemeral",
    lemma: "ephemeral",
    short_definition: null,
    ...overrides,
  } as unknown as WordRow;
}

interface CaptureMocks {
  words: {
    findBySlug: ReturnType<typeof vi.fn>;
    insertMany: ReturnType<typeof vi.fn>;
  };
  wordbooks: { addWords: ReturnType<typeof vi.fn> };
  noteEntries: { listVisibleByWordIds: ReturnType<typeof vi.fn> };
  l3Context: {
    createSource: ReturnType<typeof vi.fn>;
    createContext: ReturnType<typeof vi.fn>;
    createOccurrence: ReturnType<typeof vi.fn>;
  };
}

function makeRepos(wordBySlug: WordRow | null): CaptureMocks {
  const words = {
    findBySlug: vi.fn(async () => wordBySlug),
    insertMany: vi.fn(async () => 1),
  };
  const wordbooks = { addWords: vi.fn(async () => undefined) };
  const noteEntries = { listVisibleByWordIds: vi.fn(async () => []) };
  const l3Context = {
    createSource: vi.fn(async (input: { user_id: string }) => ({
      id: "src-1", user_id: input.user_id, source_type: "manual", title: "t",
      author: null, url: null, language: null, metadata: {}, content_text: null, content_hash: null,
      created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
    })),
    createContext: vi.fn(async (input: { user_id: string; source_id: string; text: string }) => ({
      id: "ctx-1", user_id: input.user_id, source_id: input.source_id, context_type: "sentence",
      text: input.text, normalized_text: null, language: null, position: {}, metadata: {},
      created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
    })),
    createOccurrence: vi.fn(async (input: { user_id: string; context_id: string; word_id: string }) => ({
      id: "occ-1", user_id: input.user_id, context_id: input.context_id, word_id: input.word_id,
      surface: "ephemeral", lemma: "ephemeral", start_offset: 0, end_offset: 9,
      confidence: null, evidence: {}, created_at: "2026-09-07T00:00:00Z",
    })),
  };
  mockRepos.words = words as unknown as IWordRepository;
  mockRepos.wordbooks = wordbooks as unknown as IWordbookRepository;
  mockRepos.noteEntries = noteEntries as unknown as INoteEntryRepository;
  mockRepos.l3Context = l3Context as never;
  return { words, wordbooks, noteEntries, l3Context };
}

function makeService(words: CaptureMocks["words"]): CaptureService {
  return new CaptureService(words as unknown as IWordRepository);
}

const BASE_INPUT = {
  userId: "u1",
  wordbookId: "wb1",
  headword: "ephemeral",
};

describe("slugifyHeadword", () => {
  it("lowercases and collapses separators", () => {
    expect(slugifyHeadword("Ephemeral")).toBe("ephemeral");
    expect(slugifyHeadword("  Hello, World! ")).toBe("hello-world");
    expect(slugifyHeadword("anti--virus")).toBe("anti-virus");
  });

  it("returns an empty slug for non-latin input", () => {
    expect(slugifyHeadword("中文词汇")).toBe("");
  });
});

describe("CaptureService.capture — new word stub", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("creates the stub via insertMany and ensures membership in one transaction", async () => {
    let call = 0;
    const rows = [null, makeWordRow()];
    const mocks = makeRepos(null);
    mocks.words.findBySlug.mockImplementation(async () => rows[Math.min(call++, 1)]!);

    const result = await makeService(mocks.words).capture(BASE_INPUT);

    expect(result.ok).toBe(true);
    expect(result.existed).toBe(false);
    expect(result.word.id).toBe("w-1");
    expect(mocks.words.insertMany).toHaveBeenCalledTimes(1);
    expect(mocks.words.insertMany.mock.calls[0]![0][0]).toMatchObject({
      slug: "ephemeral",
      title: "ephemeral",
      lemma: "ephemeral",
    });
    expect(mocks.wordbooks.addWords).toHaveBeenCalledWith("wb1", ["w-1"]);
    expect(result.noteContentMd).toBeNull();
    expect(withTransactionMock).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
  });

  it("does not invalidate the plaza cache — capture only creates stubs (filtered from aggregations)", async () => {
    let call = 0;
    const rows = [null, makeWordRow()];
    const mocks = makeRepos(null);
    mocks.words.findBySlug.mockImplementation(async () => rows[Math.min(call++, 1)]!);
    const invalidate = vi.spyOn(plazaCache, "invalidateAll");

    const result = await makeService(mocks.words).capture(BASE_INPUT);

    expect(result.ok).toBe(true);
    expect(mocks.words.insertMany).toHaveBeenCalledTimes(1);
    // 契约锁定：capture 建的是 stub（definition_md=''），不参与广场聚合，故不失效缓存
    expect(invalidate).not.toHaveBeenCalled();
    invalidate.mockRestore();
  });
});

describe("CaptureService.capture — existing word", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("skips stub creation and still ensures membership", async () => {
    const mocks = makeRepos(makeWordRow({ short_definition: "lasting a very short time" }));

    const result = await makeService(mocks.words).capture(BASE_INPUT);

    expect(result.existed).toBe(true);
    expect(result.word.shortDefinition).toBe("lasting a very short time");
    expect(mocks.words.insertMany).not.toHaveBeenCalled();
    expect(mocks.wordbooks.addWords).toHaveBeenCalledWith("wb1", ["w-1"]);
  });

  it("surfaces the existing note entries joined when one exists", async () => {
    const mocks = makeRepos(makeWordRow());
    mocks.noteEntries.listVisibleByWordIds.mockResolvedValue([
      {
        id: "e1", user_id: "u1", word_id: "w-1", wordbook_id: "wb1",
        content_md: "# note", hidden_at: null,
        created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
      },
    ]);

    const result = await makeService(mocks.words).capture(BASE_INPUT);

    expect(result.noteContentMd).toBe("# note");
    expect(mocks.noteEntries.listVisibleByWordIds).toHaveBeenCalledWith("u1", "wb1", ["w-1"]);
  });
});

describe("CaptureService.capture — L3 deferred without sentence", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("does not persist L3 rows when only url/ref metadata is provided (no sentence)", async () => {
    const mocks = makeRepos(makeWordRow());

    const result = await makeService(mocks.words).capture({
      ...BASE_INPUT,
      sourceUrl: "https://example.com/post/42",
      obsidianRef: "obsidian://open?vault=notes&file=reading",
    });

    expect(result.l3Status).toBe("deferred");
    expect(result.sourceId).toBeNull();
    expect(result.contextId).toBeNull();
    expect(result.occurrenceId).toBeNull();
    // capture-first（grill 2026-09-07）：无 sentence 即不尝试三件套写入。
    expect(mocks.l3Context.createSource).not.toHaveBeenCalled();
    expect(mocks.l3Context.createContext).not.toHaveBeenCalled();
    expect(mocks.l3Context.createOccurrence).not.toHaveBeenCalled();
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("CaptureService.capture — defensive guards", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("throws when the word repository lacks insertMany (batch pool unconfigured)", async () => {
    const words = {
      findBySlug: vi.fn(async () => null),
    } as unknown as IWordRepository;

    const service = new CaptureService(words);
    await expect(service.capture({ userId: "u1", wordbookId: "wb1", headword: "ephemeral" })).rejects.toThrow(
      "insertMany not configured",
    );
  });

  it("fails closed when the stub re-fetch returns null after upsert", async () => {
    const words = {
      findBySlug: vi.fn(async () => null),
      insertMany: vi.fn(async () => 0),
    } as unknown as IWordRepository;

    const service = new CaptureService(words);
    await expect(service.capture({ userId: "u1", wordbookId: "wb1", headword: "ephemeral" })).rejects.toThrow(
      'capture word upsert failed for slug "ephemeral"',
    );
  });
});

describe("CaptureService.capture — validation", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("rejects non-latin headwords before any write or transaction", async () => {
    const mocks = makeRepos(null);

    await expect(
      makeService(mocks.words).capture({ ...BASE_INPUT, headword: "中文词汇" }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(mocks.words.insertMany).not.toHaveBeenCalled();
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});

describe("L3 capture-first (grill 2026-09-07)", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("persists source/context/occurrence trio in one tx when sentence provided", async () => {
    const mocks = makeRepos(makeWordRow());
    const service = makeService(mocks.words);
    const result = await service.capture({
      userId: "u1", wordbookId: "wb1", headword: "ephemeral",
      sentence: "The ephemeral beauty of cherry blossoms.",
      sourceUrl: "https://example.com/a",
    });
    expect(mocks.l3Context.createSource).toHaveBeenCalledTimes(1);
    expect(mocks.l3Context.createContext).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: "src-1", context_type: "sentence" }),
    );
    expect(mocks.l3Context.createOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ context_id: "ctx-1", word_id: "w-1", start_offset: 4 }),
    );
    expect(result.l3Status).toBe("captured");
    expect(result.sourceId).toBe("src-1");
    expect(result.contextId).toBe("ctx-1");
    expect(result.occurrenceId).toBe("occ-1");
  });

  it("keeps deferred status and writes no l3 rows when no sentence", async () => {
    const mocks = makeRepos(makeWordRow());
    const service = makeService(mocks.words);
    const result = await service.capture({ userId: "u1", wordbookId: "wb1", headword: "ephemeral" });
    expect(mocks.l3Context.createSource).not.toHaveBeenCalled();
    expect(result.l3Status).toBe("deferred");
    expect(result.sourceId).toBeNull();
  });

  it("capture survives l3 trio failure (best-effort)", async () => {
    const mocks = makeRepos(makeWordRow());
    mocks.l3Context.createSource.mockRejectedValue(new Error("l3 down"));
    const service = makeService(mocks.words);
    const result = await service.capture({
      userId: "u1", wordbookId: "wb1", headword: "ephemeral", sentence: "The ephemeral beauty.",
    });
    expect(result.ok).toBe(true);
    expect(result.l3Status).toBe("deferred");
  });
});
