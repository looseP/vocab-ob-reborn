import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  INoteRepository,
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
  notes: { findByWord: ReturnType<typeof vi.fn> };
}

function makeRepos(wordBySlug: WordRow | null): CaptureMocks {
  const words = {
    findBySlug: vi.fn(async () => wordBySlug),
    insertMany: vi.fn(async () => 1),
  };
  const wordbooks = { addWords: vi.fn(async () => undefined) };
  const notes = { findByWord: vi.fn(async () => null) };
  mockRepos.words = words as unknown as IWordRepository;
  mockRepos.wordbooks = wordbooks as unknown as IWordbookRepository;
  mockRepos.notes = notes as unknown as INoteRepository;
  return { words, wordbooks, notes };
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

  it("surfaces the existing note content when one exists", async () => {
    const mocks = makeRepos(makeWordRow());
    mocks.notes.findByWord.mockResolvedValue({ content_md: "# note" });

    const result = await makeService(mocks.words).capture(BASE_INPUT);

    expect(result.noteContentMd).toBe("# note");
    expect(mocks.notes.findByWord).toHaveBeenCalledWith("u1", "wb1", "w-1");
  });
});

describe("CaptureService.capture — L3 reservation (deferred)", () => {
  beforeEach(() => {
    withTransactionMock.mockClear();
  });

  it("never persists L3 data even when source material is provided", async () => {
    const mocks = makeRepos(makeWordRow());

    const result = await makeService(mocks.words).capture({
      ...BASE_INPUT,
      sentence: "The ephemeral beauty of spring.",
      sourceUrl: "https://example.com/post/42",
      obsidianRef: "obsidian://open?vault=notes&file=reading",
    });

    expect(result.l3Status).toBe("deferred");
    expect(result.sourceId).toBeNull();
    expect(result.contextId).toBeNull();
    expect(result.occurrenceId).toBeNull();
    // No L3 repository surface exists on the tx repos in this round; the
    // service must not attempt any write beyond membership + note read.
    expect(mockRepos.l3Context).toBeUndefined();
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
