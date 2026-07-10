import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  IWordRepository,
  INoteRepository,
  IWordbookRepository,
  IStatsRepository,
  IRepositories,
} from "@/repositories/interfaces";
import { WordService } from "@/services/word.service";
import { NoteService } from "@/services/note.service";
import { WordbookService } from "@/services/wordbook.service";
import { StatsService } from "@/services/stats.service";
import { NotFoundError, BusinessRuleError } from "@/errors";
import type { WordRow, WordSummary, NoteRow, WordbookRow } from "@/domain";

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
    count: vi.fn(async () => 0),
    findSlugs: vi.fn(async () => []),
    ...overrides,
  };
}

function makeMockNoteRepo(overrides: Partial<INoteRepository> = {}): INoteRepository {
  return {
    findByWord: vi.fn(async () => null),
    upsert: vi.fn(async () => ({
      note: {} as NoteRow, created: true,
    })),
    findRevisions: vi.fn(async () => []),
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

function makeMockStatsRepo(overrides: Partial<IStatsRepository> = {}): IStatsRepository {
  return {
    getDashboardSummary: vi.fn(async () => ({
      totalWords: 100, trackedWords: 50, dueToday: 5,
      reviewedToday: 10, reviewed7d: 70, reviewed30d: 300,
      streakDays: 3, notesCount: 20,
    })),
    getRatingDistribution: vi.fn(async () => ({ again: 1, hard: 2, good: 5, easy: 2 })),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("WordService", () => {
  it("getPublicWords delegates to repository", async () => {
    const repo = makeMockWordRepo({
      findPublic: vi.fn(async () => ({
        items: [{ id: "1", slug: "aboard" } as WordSummary],
        total: 1, limit: 10, offset: 0, hasMore: false,
      })),
    });
    const service = new WordService(repo);
    const result = await service.getPublicWords({
      userId: "u1", q: "ab", limit: 10, offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(repo.findPublic).toHaveBeenCalledWith(expect.objectContaining({
      filters: { q: "ab", freq: undefined, semantic: undefined, review: undefined },
      pagination: { limit: 10, offset: 0 },
      userId: "u1",
    }));
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
});

describe("NoteService", () => {
  beforeEach(() => {
    // Reset mock repos between tests to avoid cross-test state leakage
    Object.keys(mockRepos).forEach(k => delete (mockRepos as Record<string, unknown>)[k]);
  });

  it("getNote returns empty when not found", async () => {
    const service = new NoteService(makeMockNoteRepo(), makeMockWordbookRepo());
    const result = await service.getNote("u1", "w1", "wb1");
    expect(result.contentMd).toBe("");
    expect(result.version).toBe(0);
  });

  it("upsertNote creates default wordbook when not provided", async () => {
    const noteRepo = makeMockNoteRepo({
      upsert: vi.fn(async () => ({
        note: { id: "n1", content_md: "test", version: 1, updated_at: "2026" } as NoteRow,
        created: true,
      })),
    });
    const wbRepo = makeMockWordbookRepo({
      getOrCreateDefault: vi.fn(async () => ({ id: "wb-default" } as WordbookRow)),
    });
    // M4 fix: upsertNote uses createRepositories(tx) inside withTransaction,
    // so we inject mock repos into the mocked createRepositories return.
    // H-NEW-2 fix: getOrCreateDefault is now called inside tx via repos.wordbooks
    mockRepos.notes = noteRepo;
    mockRepos.wordbooks = wbRepo;
    const service = new NoteService(noteRepo, wbRepo);
    const result = await service.upsertNote({
      userId: "u1", wordId: "w1", contentMd: "test",
    });

    expect(wbRepo.getOrCreateDefault).toHaveBeenCalledWith("u1");
    expect(noteRepo.upsert).toHaveBeenCalledWith("u1", "wb-default", "w1", "test");
    expect(result.version).toBe(1);
  });
});

describe("WordbookService", () => {
  it("create rejects empty name", async () => {
    const service = new WordbookService(makeMockWordbookRepo());
    await expect(service.create({ userId: "u1", name: "" }))
      .rejects.toBeInstanceOf(BusinessRuleError);
  });

  it("create with isDefault checks existing default", async () => {
    const repo = makeMockWordbookRepo({
      findDefaultByUser: vi.fn(async () => ({ id: "existing" } as WordbookRow)),
    });
    const service = new WordbookService(repo);
    await expect(service.create({ userId: "u1", name: "Test", isDefault: true }))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("persists a normalized description when creating a wordbook", async () => {
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
    const repo = makeMockWordbookRepo({ create: vi.fn(async () => row) });
    const service = new WordbookService(repo);

    const result = await service.create({
      userId: "u1",
      name: "Test",
      description: "  Vocabulary for exams  ",
    });

    expect(repo.create).toHaveBeenCalledWith("u1", "Test", false, "Vocabulary for exams");
    expect(result.description).toBe("Vocabulary for exams");
  });

  it("addWords skips empty array", async () => {
    const repo = makeMockWordbookRepo();
    const service = new WordbookService(repo);
    await service.addWords("wb1", []);
    expect(repo.addWords).not.toHaveBeenCalled();
  });
});

describe("StatsService", () => {
  it("getDashboardSummary delegates to repo", async () => {
    const repo = makeMockStatsRepo();
    const service = new StatsService(repo);
    const result = await service.getDashboardSummary("u1", "wb1");
    expect(result.totalWords).toBe(100);
    expect(result.streakDays).toBe(3);
  });

  it("computeForecast derives from summary", () => {
    const service = new StatsService(makeMockStatsRepo());
    const forecast = service.computeForecast({
      totalWords: 100, trackedWords: 50, dueToday: 10,
      reviewedToday: 5, reviewed7d: 35, reviewed30d: 150,
      streakDays: 7, notesCount: 3,
    });
    expect(forecast.dueNow).toBe(10);
    expect(forecast.due7d).toBe(15);
    expect(forecast.due14d).toBe(20);
  });
});
