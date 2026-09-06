import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  IWordRepository,
  INoteEntryRepository,
  IWordbookRepository,
  IStatsRepository,
  IRepositories,
} from "@/repositories/interfaces";
import { WordService } from "@/services/word.service";
import { NoteEntryService } from "@/services/note-entry.service";
import { WordbookService } from "@/services/wordbook.service";
import { StatsService } from "@/services/stats.service";
import { plazaCache } from "@/services/plaza-cache";
import { NotFoundError, BusinessRuleError } from "@/errors";
import type { WordRow, WordSummary, NoteEntryRow, WordbookRow } from "@/domain";

// Mock withTransaction so NoteService.upsertNote doesn't hit real DB.
// The callback receives a fake tx; createRepositories is also mocked
// to return the test's mock repos.
const mockRepos: Partial<IRepositories> = {};
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

// ── Mock repository factory ─────────────────────────────────────────────
function makeMockWordRepo(overrides: Partial<IWordRepository> = {}): IWordRepository {
  return {
    findById: vi.fn(async () => null),
    findBySlug: vi.fn(async () => null),
    findPublic: vi.fn(async () => ({ items: [], total: 0, limit: 10, offset: 0, hasMore: false })),
    suggest: vi.fn(async () => []),
    findSemanticFieldGroups: vi.fn(async () => []),
    findRootFamilyGroups: vi.fn(async () => []),
    findBySourcePathPrefix: vi.fn(async () => []),
    findByRootToken: vi.fn(async () => []),
    countReviewStatsByWordIds: vi.fn(async () => ({ tracked: 0, due: 0 })),
    count: vi.fn(async () => 0),
    findSlugs: vi.fn(async () => []),
    ...overrides,
  };
}

function makeMockNoteEntryRepo(overrides: Partial<INoteEntryRepository> = {}): INoteEntryRepository {
  return {
    listByWord: vi.fn(async () => []),
    listVisibleByWordIds: vi.fn(async () => []),
    insert: vi.fn(async () => ({ hidden_at: null } as NoteEntryRow)),
    updateContent: vi.fn(async () => null),
    hide: vi.fn(async () => null),
    restore: vi.fn(async () => null),
    remove: vi.fn(async () => false),
    listByUser: vi.fn(async () => []),
    ...overrides,
  };
}

function makeMockWordbookRepo(overrides: Partial<IWordbookRepository> = {}): IWordbookRepository {
  return {
    findById: vi.fn(async () => null),
    findDefaultByUser: vi.fn(async () => null),
    findAllByUser: vi.fn(async () => []),
    create: vi.fn(async () => ({} as WordbookRow)),
    getOrCreateDefault: vi.fn(async () => ({} as WordbookRow)),
    countWords: vi.fn(async () => 0),
    getWordIds: vi.fn(async () => []),
    addWords: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeNoteEntryService(
  noteEntries: INoteEntryRepository,
  wordbooks: IWordbookRepository,
  txRunner: typeof import("@/db/transaction").withTransaction = async (callback) => callback({} as never),
): NoteEntryService {
  return new NoteEntryService(
    noteEntries,
    wordbooks,
    txRunner,
    () => ({ noteEntries, wordbooks } as unknown as IRepositories),
  );
}

function makeMockStatsRepo(overrides: Partial<IStatsRepository> = {}): IStatsRepository {
  return {
    getDashboardSummary: vi.fn(async () => ({
      totalWords: 100, trackedWords: 50, dueToday: 5,
      reviewedToday: 10, reviewed7d: 70, reviewed30d: 300,
      streakDays: 3, notesCount: 20,
      l2: { promoted: 8, dueNow: 2, weakSignal: 1 },
    })),
    getRatingDistribution: vi.fn(async () => ({ again: 1, hard: 2, good: 5, easy: 2 })),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("WordService", () => {
  it("getPublicWords uses the authenticated actor transaction repository", async () => {
    const constructorRepo = makeMockWordRepo();
    const txRepo = makeMockWordRepo({
      findPublic: vi.fn(async () => ({
        items: [{ id: "1", slug: "aboard" } as WordSummary],
        total: 1, limit: 10, offset: 0, hasMore: false,
      })),
    });
    const fakeTx = {} as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ words: txRepo } as unknown as IRepositories));
    const service = new WordService(constructorRepo, txRunner, repositoryFactory);

    const result = await service.getPublicWords({
      userId: "u1", q: "ab", limit: 10, offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(txRunner).toHaveBeenCalledTimes(1);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repositoryFactory).toHaveBeenCalledWith(fakeTx);
    expect(txRepo.findPublic).toHaveBeenCalledWith({
      filters: { q: "ab", freq: undefined, semantic: undefined, review: undefined },
      pagination: { limit: 10, offset: 0 },
      userId: "u1",
      wordbookId: undefined,
    });
    expect(constructorRepo.findPublic).not.toHaveBeenCalled();
  });

  it("getWordBySlug throws NotFound when missing", async () => {
    const service = new WordService(makeMockWordRepo());
    await expect(service.getWordBySlug("missing")).rejects.toMatchObject({
      httpStatus: 404, code: "NOT_FOUND",
    });
  });

  it("getWordBySlug returns Word entity when found", async () => {
    const repo = makeMockWordRepo({
      findBySlug: vi.fn(async () => ({
        id: "1", slug: "aboard", is_published: true, is_deleted: false,
        content_hash: "abc", metadata: { word_freq: "基础词" },
      } as unknown as WordRow)),
    });
    const service = new WordService(repo);
    const result = await service.getWordBySlug("aboard");
    expect(result.word.slug).toBe("aboard");
    expect(result.word.isPublished).toBe(true);
    expect(result.word.freqLabel).toBe("基础词");
  });

  it("getWordBySlug reports l2Promoted via an actor-scoped transaction", async () => {
    const row = {
      id: "w-1", slug: "aboard", is_published: true, is_deleted: false,
      content_hash: "abc", metadata: {},
    } as unknown as WordRow;
    const constructorRepo = makeMockWordRepo({ findBySlug: vi.fn(async () => row) });
    const l2Progress = { existsByUserAndWord: vi.fn(async () => true) };
    const fakeTx = { query: vi.fn() } as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ l2Progress } as unknown as IRepositories));
    const service = new WordService(constructorRepo, txRunner, repositoryFactory);

    const promoted = await service.getWordBySlug("aboard", "u1");
    expect(promoted.l2Promoted).toBe(true);
    expect(l2Progress.existsByUserAndWord).toHaveBeenCalledWith("u1", "w-1");
    // 业务查询必须携带 request.jwt.claim.sub（owner-RLS 表，广场教训①）
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });

    // 未传 userId → 不开事务，恒为 false
    const anon = await service.getWordBySlug("aboard");
    expect(anon.l2Promoted).toBe(false);
    expect(l2Progress.existsByUserAndWord).toHaveBeenCalledTimes(1);
    expect(txRunner).toHaveBeenCalledTimes(1);
  });

  it("batchCreate delegates to insertMany and returns the inserted count", async () => {
    const repo = makeMockWordRepo({
      insertMany: vi.fn(async () => 3),
    });
    const service = new WordService(repo);
    const batch = [
      { slug: "abound", title: "Abound", lemma: "abound", pos: "verb", cefr: "C1", ipa: null, short_definition: "def" },
    ];

    await expect(service.batchCreate(batch)).resolves.toEqual({ inserted: 3 });
    expect(repo.insertMany).toHaveBeenCalledWith(batch);
  });

  it("batchCreate invalidates the plaza aggregate cache after writing", async () => {
    const repo = makeMockWordRepo({
      insertMany: vi.fn(async () => 1),
    });
    const service = new WordService(repo);
    const invalidate = vi.spyOn(plazaCache, "invalidateAll");

    await service.batchCreate([
      { slug: "abound", title: "Abound", lemma: "abound", pos: "verb", cefr: "C1", ipa: null, short_definition: "def" },
    ]);

    expect(repo.insertMany).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    invalidate.mockRestore();
  });

  it("batchCreate fails closed when the repository has no insertMany", async () => {
    const service = new WordService(makeMockWordRepo());

    await expect(service.batchCreate([])).rejects.toThrow("insertMany not configured");
  });

  it("getWordCount and getAllSlugs delegate to the repository", async () => {
    const repo = makeMockWordRepo({
      count: vi.fn(async () => 42),
      findSlugs: vi.fn(async () => ["abound", "breach"]),
    });
    const service = new WordService(repo);

    await expect(service.getWordCount()).resolves.toBe(42);
    expect(repo.count).toHaveBeenCalledTimes(1);
    await expect(service.getAllSlugs(2)).resolves.toEqual(["abound", "breach"]);
    expect(repo.findSlugs).toHaveBeenCalledWith(2);
  });
});

describe("NoteEntryService", () => {
  const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback({} as never)) as unknown as typeof import("@/db/transaction").withTransaction;

  beforeEach(() => {
    // Reset mock repos between tests to avoid cross-test state leakage
    Object.keys(mockRepos).forEach(k => delete (mockRepos as Record<string, unknown>)[k]);
  });

  it("getEntries uses the authenticated actor transaction", async () => {
    const entries = makeMockNoteEntryRepo({
      listByWord: vi.fn(async () => [{ id: "e1", content_md: "a", hidden_at: null }] as never),
    });
    const service = makeNoteEntryService(entries, makeMockWordbookRepo(), txRunner);

    await expect(service.getEntries("u1", "w1", "wb1")).resolves.toHaveLength(1);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(entries.listByWord).toHaveBeenCalledWith("u1", "wb1", "w1");
  });

  it("addEntry creates the default wordbook inside the same transaction when not provided", async () => {
    const entryRepo = makeMockNoteEntryRepo({
      insert: vi.fn(async () => ({
        id: "e1", user_id: "u1", word_id: "w1", wordbook_id: "wb-default",
        content_md: "test", hidden_at: null,
        created_at: "2026", updated_at: "2026",
      } as NoteEntryRow)),
    });
    const wbRepo = makeMockWordbookRepo({
      getOrCreateDefault: vi.fn(async () => ({ id: "wb-default" } as WordbookRow)),
    });
    mockRepos.noteEntries = entryRepo;
    mockRepos.wordbooks = wbRepo;
    const service = makeNoteEntryService(entryRepo, wbRepo);

    await service.addEntry("u1", "w1", "test");

    expect(wbRepo.getOrCreateDefault).toHaveBeenCalledWith("u1");
    expect(entryRepo.insert).toHaveBeenCalledWith("u1", "wb-default", "w1", "test");
  });

  it("editEntry throws NotFoundError when the entry is missing or not owned", async () => {
    const entries = makeMockNoteEntryRepo({ updateContent: vi.fn(async () => null) });
    const service = makeNoteEntryService(entries, makeMockWordbookRepo(), txRunner);

    await expect(service.editEntry("u1", "missing", "new")).rejects.toMatchObject({
      httpStatus: 404, code: "NOT_FOUND",
    });
  });

  it("deleteEntry resolves ok when a row was removed and 404 otherwise", async () => {
    const entries = makeMockNoteEntryRepo({ remove: vi.fn(async () => true) });
    const service = makeNoteEntryService(entries, makeMockWordbookRepo(), txRunner);
    await expect(service.deleteEntry("u1", "e1")).resolves.toEqual({ ok: true });

    const missing = makeMockNoteEntryRepo({ remove: vi.fn(async () => false) });
    const missingService = makeNoteEntryService(missing, makeMockWordbookRepo(), txRunner);
    await expect(missingService.deleteEntry("u1", "missing")).rejects.toMatchObject({
      httpStatus: 404, code: "NOT_FOUND",
    });
  });

  it("getVisibleByWordIds groups visible entries by word_id in creation order", async () => {
    const entries = makeMockNoteEntryRepo({
      listVisibleByWordIds: vi.fn(async () => [
        { id: "e1", word_id: "w1", content_md: "a", hidden_at: null, created_at: "2026" },
        { id: "e2", word_id: "w2", content_md: "b", hidden_at: null, created_at: "2026" },
        { id: "e3", word_id: "w1", content_md: "c", hidden_at: null, created_at: "2026" },
      ] as never),
    });
    const service = makeNoteEntryService(entries, makeMockWordbookRepo(), txRunner);

    const map = await service.getVisibleByWordIds("u1", "wb1", ["w1", "w2"]);

    expect(map.get("w1")).toHaveLength(2);
    expect(map.get("w2")).toHaveLength(1);
    expect(entries.listVisibleByWordIds).toHaveBeenCalledWith("u1", "wb1", ["w1", "w2"]);
  });

  it("listEntries maps joined rows to entry summaries without version fields", async () => {
    const entries = makeMockNoteEntryRepo({
      listByUser: vi.fn(async () => [{
        id: "e1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
        content_md: "note", hidden_at: null,
        created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
        word_slug: "abound", word_lemma: "abound", word_title: "Abound",
      }]),
    });
    const service = makeNoteEntryService(entries, makeMockWordbookRepo(), txRunner);

    await expect(service.listEntries("u1", 20, 10)).resolves.toEqual([{
      id: "e1", wordSlug: "abound", wordLemma: "abound", wordTitle: "Abound",
      contentMd: "note", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z",
    }]);
    expect(entries.listByUser).toHaveBeenCalledWith("u1", 20, 10);
  });
});

describe("WordbookService", () => {
  it("create rejects empty name before opening an actor transaction", async () => {
    const repo = makeMockWordbookRepo();
    const txRunner = vi.fn();
    const repositoryFactory = vi.fn();
    const service = new WordbookService(
      repo,
      txRunner as unknown as typeof import("@/db/transaction").withTransaction,
      repositoryFactory,
    );

    await expect(service.create({ userId: "u1", name: "" }))
      .rejects.toBeInstanceOf(BusinessRuleError);
    expect(txRunner).not.toHaveBeenCalled();
    expect(repositoryFactory).not.toHaveBeenCalled();
  });

  it("create with isDefault checks the tx-scoped repository", async () => {
    const constructorRepo = makeMockWordbookRepo();
    const txRepo = makeMockWordbookRepo({
      findDefaultByUser: vi.fn(async () => ({ id: "existing" } as WordbookRow)),
    });
    const fakeTx = {} as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ wordbooks: txRepo } as unknown as IRepositories));
    const service = new WordbookService(constructorRepo, txRunner, repositoryFactory);

    await expect(service.create({ userId: "u1", name: "Test", isDefault: true }))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
    expect(txRunner).toHaveBeenCalledTimes(1);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repositoryFactory).toHaveBeenCalledWith(fakeTx);
    expect(txRepo.findDefaultByUser).toHaveBeenCalledWith("u1");
    expect(txRepo.create).not.toHaveBeenCalled();
    expect(constructorRepo.findDefaultByUser).not.toHaveBeenCalled();
  });

  it("persists a normalized description through the tx-scoped repository", async () => {
    const row = {
      id: "wb1",
      user_id: "u1",
      name: "Test",
      description: "Vocabulary for exams",
      is_default: false,
      settings: {},
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    } satisfies WordbookRow;
    const constructorRepo = makeMockWordbookRepo();
    const txRepo = makeMockWordbookRepo({ create: vi.fn(async () => row) });
    const fakeTx = {} as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ wordbooks: txRepo } as unknown as IRepositories));
    const service = new WordbookService(constructorRepo, txRunner, repositoryFactory);

    const result = await service.create({
      userId: "u1",
      name: "Test",
      description: "  Vocabulary for exams  ",
    });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repositoryFactory).toHaveBeenCalledWith(fakeTx);
    expect(txRepo.create).toHaveBeenCalledWith("u1", "Test", false, "Vocabulary for exams");
    expect(constructorRepo.create).not.toHaveBeenCalled();
    expect(result.description).toBe("Vocabulary for exams");
  });

  it("addWords skips empty arrays before opening an actor transaction", async () => {
    const repo = makeMockWordbookRepo();
    const txRunner = vi.fn();
    const repositoryFactory = vi.fn();
    const service = new WordbookService(
      repo,
      txRunner as unknown as typeof import("@/db/transaction").withTransaction,
      repositoryFactory,
    );

    await service.addWords("u1", "wb1", []);

    expect(txRunner).not.toHaveBeenCalled();
    expect(repositoryFactory).not.toHaveBeenCalled();
    expect(repo.addWords).not.toHaveBeenCalled();
  });

  it("delegates reads, additions, and counts through authenticated actor transactions", async () => {
    const first = {
      id: "wb1", user_id: "u1", name: "Default", description: null,
      is_default: true, settings: {}, created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    } satisfies WordbookRow;
    const second = { ...first, id: "wb2", name: "Extra", is_default: false } satisfies WordbookRow;
    const constructorRepo = makeMockWordbookRepo();
    const txRepo = makeMockWordbookRepo({
      getOrCreateDefault: vi.fn(async () => first),
      findAllByUser: vi.fn(async () => [first, second]),
      findById: vi.fn(async (id) => id === "wb1" ? first : null),
      countWords: vi.fn(async () => 2),
    });
    const fakeTx = {} as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ wordbooks: txRepo } as unknown as IRepositories));
    const service = new WordbookService(constructorRepo, txRunner, repositoryFactory);

    expect((await service.getOrCreateDefault("u1")).id).toBe("wb1");
    expect(await service.findAllByUser("u1")).toHaveLength(2);
    expect((await service.findById("u1", "wb1"))?.name).toBe("Default");
    expect(await service.findById("u1", "missing")).toBeNull();
    await service.addWords("u1", "wb1", ["word-1", "word-2"]);
    expect(await service.getWordCount("u1", "wb1")).toBe(2);

    expect(txRunner).toHaveBeenCalledTimes(6);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repositoryFactory).toHaveBeenCalledTimes(6);
    expect(repositoryFactory).toHaveBeenCalledWith(fakeTx);
    expect(txRepo.getOrCreateDefault).toHaveBeenCalledWith("u1");
    expect(txRepo.findAllByUser).toHaveBeenCalledWith("u1");
    expect(txRepo.findById).toHaveBeenNthCalledWith(1, "wb1");
    expect(txRepo.findById).toHaveBeenNthCalledWith(2, "missing");
    expect(txRepo.addWords).toHaveBeenCalledWith("wb1", ["word-1", "word-2"]);
    expect(txRepo.countWords).toHaveBeenCalledWith("wb1");
    expect(constructorRepo.getOrCreateDefault).not.toHaveBeenCalled();
    expect(constructorRepo.findAllByUser).not.toHaveBeenCalled();
    expect(constructorRepo.findById).not.toHaveBeenCalled();
    expect(constructorRepo.addWords).not.toHaveBeenCalled();
    expect(constructorRepo.countWords).not.toHaveBeenCalled();
  });
});

describe("StatsService", () => {
  it("getDashboardSummary uses the authenticated actor transaction repository", async () => {
    const constructorRepo = makeMockStatsRepo();
    const txRepo = makeMockStatsRepo();
    const fakeTx = {} as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ stats: txRepo } as unknown as IRepositories));
    const service = new StatsService(constructorRepo, txRunner, repositoryFactory);

    const result = await service.getDashboardSummary("u1", "wb1");

    expect(result.totalWords).toBe(100);
    expect(result.streakDays).toBe(3);
    expect(txRunner).toHaveBeenCalledTimes(1);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repositoryFactory).toHaveBeenCalledWith(fakeTx);
    expect(txRepo.getDashboardSummary).toHaveBeenCalledWith("u1", "wb1");
    expect(constructorRepo.getDashboardSummary).not.toHaveBeenCalled();
  });

  it("getRatingDistribution uses the authenticated actor transaction repository", async () => {
    const constructorRepo = makeMockStatsRepo();
    const txRepo = makeMockStatsRepo();
    const fakeTx = {} as never;
    const txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback(fakeTx)) as unknown as typeof import("@/db/transaction").withTransaction;
    const repositoryFactory = vi.fn(() => ({ stats: txRepo } as unknown as IRepositories));
    const service = new StatsService(constructorRepo, txRunner, repositoryFactory);

    await expect(service.getRatingDistribution("u1", "wb1", 7)).resolves.toEqual({
      again: 1, hard: 2, good: 5, easy: 2,
    });
    expect(txRunner).toHaveBeenCalledTimes(1);
    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repositoryFactory).toHaveBeenCalledWith(fakeTx);
    expect(txRepo.getRatingDistribution).toHaveBeenCalledWith("u1", "wb1", 7);
    expect(constructorRepo.getRatingDistribution).not.toHaveBeenCalled();
  });

  it("computeForecast derives from summary without opening a transaction", () => {
    const txRunner = vi.fn();
    const repositoryFactory = vi.fn();
    const service = new StatsService(
      makeMockStatsRepo(),
      txRunner as unknown as typeof import("@/db/transaction").withTransaction,
      repositoryFactory,
    );
    const forecast = service.computeForecast({
      totalWords: 100, trackedWords: 50, dueToday: 10,
      reviewedToday: 5, reviewed7d: 35, reviewed30d: 150,
      streakDays: 7, notesCount: 3,
      l2: { promoted: 0, dueNow: 0, weakSignal: 0 },
    });
    expect(forecast.dueNow).toBe(10);
    expect(forecast.due7d).toBe(15);
    expect(forecast.due14d).toBe(20);
    expect(txRunner).not.toHaveBeenCalled();
    expect(repositoryFactory).not.toHaveBeenCalled();
  });
});
