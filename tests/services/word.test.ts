import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WordRow } from "@/domain";
import type { IRepositories, IWordRepository } from "@/repositories/interfaces";
import { WordService } from "@/services/word.service";
import type { PoolClient } from "pg";

const STUB_ROW: WordRow = {
  id: "w-1",
  slug: "wibble",
  title: "Wibble",
  lemma: "wibble",
  definition_md: "",
  content_hash: "a".repeat(64),
} as unknown as WordRow;

function makeWordRepo(overrides: Partial<IWordRepository> = {}): IWordRepository {
  return {
    findById: vi.fn(async () => null),
    findBySlug: vi.fn(async () => STUB_ROW),
    findPublic: vi.fn(async () => ({ items: [], total: 0, limit: 10, offset: 0, hasMore: false })),
    suggest: vi.fn(async () => []),
    findSemanticFieldGroups: vi.fn(async () => []),
    findRootFamilyGroups: vi.fn(async () => []),
    findBySourcePathPrefix: vi.fn(async () => []),
    findByRootToken: vi.fn(async () => []),
    countReviewStatsByWordIds: vi.fn(async () => ({ tracked: 0, due: 0 })),
    count: vi.fn(async () => 0),
    findSlugs: vi.fn(async () => []),
    lockStubWordById: vi.fn(async () => STUB_ROW),
    getWordDeleteBlockers: vi.fn(async () => ({ l3OccurrenceCount: 0, noteEntryCount: 0, inboundWordLinkCount: 0 })),
    deleteWordById: vi.fn(async () => STUB_ROW),
    ...overrides,
  } as IWordRepository;
}

function makeService(
  repository: IWordRepository,
  txRepository = repository,
): WordService {
  const txRunner = (async (callback: (tx: PoolClient) => Promise<unknown>) =>
    callback({} as PoolClient)) as unknown as typeof import("@/db/transaction").withTransaction;
  return new WordService(
    repository,
    txRunner,
    () => ({ words: txRepository, l3Context: { lockActiveL3TargetReference: vi.fn(async () => undefined) } } as unknown as IRepositories),
  );
}

let repo: IWordRepository;
let service: WordService;

beforeEach(() => {
  repo = makeWordRepo();
  service = makeService(repo);
});

describe("WordService.deleteStubWord", () => {
  it("deletes a stub with no blockers and returns the shared delete result shape", async () => {
    await expect(service.deleteStubWord({ slug: "wibble", userId: "u1" })).resolves.toEqual({
      deleted: { entityType: "word", id: "w-1" },
      activeReadInvalidation: true,
    });

    expect(repo.findBySlug).toHaveBeenCalledWith("wibble");
    expect(repo.lockStubWordById).toHaveBeenCalledWith("w-1");
    expect(repo.getWordDeleteBlockers).toHaveBeenCalledWith("u1", "w-1");
    expect(repo.deleteWordById).toHaveBeenCalledWith("u1", "w-1");
  });

  it("runs the delete inside a transaction scoped to the actor", async () => {
    const txRunner = vi.fn(
      async (callback: (tx: PoolClient) => Promise<unknown>) => callback({} as PoolClient),
    ) as unknown as typeof import("@/db/transaction").withTransaction;
    const factory = vi.fn(() => ({ words: repo, l3Context: { lockActiveL3TargetReference: vi.fn(async () => undefined) } } as unknown as IRepositories));
    const serviceWithSpy = new WordService(repo, txRunner as never, factory as never);

    await serviceWithSpy.deleteStubWord({ slug: "wibble", userId: "u1" });

    expect(txRunner).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({} as PoolClient);
  });

  it("maps an unknown slug to NotFoundError without locking", async () => {
    repo = makeWordRepo({ findBySlug: vi.fn(async () => null) });
    service = makeService(repo);

    await expect(service.deleteStubWord({ slug: "missing", userId: "u1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(repo.lockStubWordById).not.toHaveBeenCalled();
    expect(repo.deleteWordById).not.toHaveBeenCalled();
  });

  it("rejects non-stub words before entering a transaction", async () => {
    repo = makeWordRepo({ findBySlug: vi.fn(async () => ({ ...STUB_ROW, definition_md: "real content" }) as WordRow) });
    service = makeService(repo);

    await expect(service.deleteStubWord({ slug: "wibble", userId: "u1" }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    expect(repo.lockStubWordById).not.toHaveBeenCalled();
    expect(repo.deleteWordById).not.toHaveBeenCalled();
  });

  it("rejects with ConflictError and the blocker set when dependencies remain", async () => {
    repo = makeWordRepo({
      getWordDeleteBlockers: vi.fn(async () => ({ l3OccurrenceCount: 2, noteEntryCount: 1, inboundWordLinkCount: 0 })),
    });
    service = makeService(repo);

    await expect(service.deleteStubWord({ slug: "wibble", userId: "u1" }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        meta: {
          entityType: "word",
          id: "w-1",
          blockers: { l3OccurrenceCount: 2, noteEntryCount: 1, inboundWordLinkCount: 0 },
        },
      });

    expect(repo.deleteWordById).not.toHaveBeenCalled();
  });

  it("maps a guarded-delete miss with a vanished row to NotFoundError", async () => {
    repo = makeWordRepo({ deleteWordById: vi.fn(async () => null) });
    service = makeService(repo);

    await expect(service.deleteStubWord({ slug: "wibble", userId: "u1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("re-reads blockers and conflicts with the latest set when the guarded delete misses but the row persists", async () => {
    repo = makeWordRepo({
      findById: vi.fn(async () => STUB_ROW),
      deleteWordById: vi.fn(async () => null),
      getWordDeleteBlockers: vi
        .fn()
        .mockResolvedValueOnce({ l3OccurrenceCount: 0, noteEntryCount: 0, inboundWordLinkCount: 0 })
        .mockResolvedValueOnce({ l3OccurrenceCount: 1, noteEntryCount: 0, inboundWordLinkCount: 2 }),
    });
    service = makeService(repo);

    await expect(service.deleteStubWord({ slug: "wibble", userId: "u1" }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        meta: {
          entityType: "word",
          id: "w-1",
          blockers: { l3OccurrenceCount: 1, noteEntryCount: 0, inboundWordLinkCount: 2 },
        },
      });
  });
});
