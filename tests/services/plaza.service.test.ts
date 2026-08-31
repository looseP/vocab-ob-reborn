import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import type {
  IRepositories,
  IWordRepository,
} from "@/repositories/interfaces";
import { PlazaService, toPlazaSlug, fieldFromPlazaSlug } from "@/services/plaza.service";
import { NotFoundError } from "@/errors";
import type {
  PlazaWordRow,
  SemanticFieldGroupRow,
  WordSummary,
} from "@/domain";

function makeMockWordRepo(overrides: Partial<IWordRepository> = {}): IWordRepository {
  return {
    findById: vi.fn(async () => null),
    findBySlug: vi.fn(async () => null),
    findPublic: vi.fn(async () => ({ items: [], total: 0, limit: 10, offset: 0, hasMore: false })),
    suggest: vi.fn(async () => []),
    findSemanticFieldGroups: vi.fn(async () => []),
    findBySourcePathPrefix: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    findSlugs: vi.fn(async () => []),
    ...overrides,
  };
}

/** 注入不触库的 txRunner + repositoryFactory，让服务在测试中走 mock 仓库。 */
function makeService(repo: IWordRepository): PlazaService {
  const txRunner = (async (cb: (tx: PoolClient) => Promise<unknown>) => cb({} as PoolClient)) as typeof import("@/db/transaction").withTransaction;
  const repositoryFactory = (() => ({ words: repo })) as unknown as (tx?: PoolClient) => IRepositories;
  return new PlazaService(repo, txRunner, repositoryFactory);
}

const GROUP_ROW: SemanticFieldGroupRow = { field: "学校教育", count: 401, updatedAt: "2026-08-28T00:00:00.000Z" };
const WORD_ROW: PlazaWordRow = {
  id: "w-1",
  slug: "abound",
  title: "Abound",
  lemma: "abound",
  pos: "verb",
  cefr: "B2",
  ipa: null,
  short_definition: "大量存在",
  metadata: { semantic_chain: "丰富 -> 大量存在" },
  updated_at: "2026-08-28T00:00:00.000Z",
} as WordSummary & { updated_at: string };

describe("PlazaService.getOverview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a semantic_field group built from derived word groups", async () => {
    const repo = makeMockWordRepo({
      findSemanticFieldGroups: vi.fn(async () => [GROUP_ROW]),
    });
    const service = makeService(repo);

    const result = await service.getOverview({ userId: "user-1" });

    // total 用全量分组、showing 用过滤后分组，两次调用
    expect(repo.findSemanticFieldGroups).toHaveBeenNthCalledWith(1, undefined);
    expect(repo.findSemanticFieldGroups).toHaveBeenNthCalledWith(2, undefined);
    expect(result.available).toBe(true);
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ showing: 1, total: 1 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      kind: "semantic_field",
      label: "语义场",
      count: 1,
    });
    expect(result.groups[0].collections[0]).toMatchObject({
      slug: "semantic-学校教育",
      title: "学校教育",
      kind: "semantic_field",
      count: 401,
      updatedAt: GROUP_ROW.updatedAt,
    });
  });

  it("separates filtered showing count from total, enabling the no-match empty state", async () => {
    const repo = makeMockWordRepo({
      findSemanticFieldGroups: vi
        .fn()
        .mockImplementation(async (q?: string) => (q ? [] : [GROUP_ROW])),
    });
    const service = makeService(repo);

    const result = await service.getOverview({ userId: "user-1", q: "太空" });

    expect(repo.findSemanticFieldGroups).toHaveBeenNthCalledWith(1, undefined);
    expect(repo.findSemanticFieldGroups).toHaveBeenNthCalledWith(2, "太空");
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ showing: 0, total: 1 });
    expect(result.groups).toHaveLength(0);
  });
});

describe("PlazaService.getCollection", () => {
  it("returns detail with word cards for a valid semantic slug", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => [WORD_ROW]),
    });
    const service = makeService(repo);

    const result = await service.getCollection({ userId: "user-1", slug: "semantic-学校教育" });

    expect(repo.findBySourcePathPrefix).toHaveBeenCalledWith("L1_雅思词汇/L1_雅思词汇_学校教育.md");
    expect(result).toMatchObject({
      slug: "semantic-学校教育",
      title: "学校教育",
      kind: "semantic_field",
      count: 1,
    });
    expect(result.words[0]).toEqual({
      id: "w-1",
      slug: "abound",
      lemma: "abound",
      cefr: "B2",
      short_definition: "大量存在",
      semantic_chain: "丰富 -> 大量存在",
    });
  });

  it("throws NotFound for a slug without the semantic- prefix", async () => {
    const repo = makeMockWordRepo();
    const service = makeService(repo);

    await expect(service.getCollection({ userId: "user-1", slug: "root-chart" })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.findBySourcePathPrefix).not.toHaveBeenCalled();
  });

  it("throws NotFound when the derived source path has no words", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => []),
    });
    const service = makeService(repo);

    await expect(service.getCollection({ userId: "user-1", slug: "semantic-不存在" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("plaza slug helpers", () => {
  it("round-trips field name through slug", () => {
    expect(toPlazaSlug("学校教育")).toBe("semantic-学校教育");
    expect(fieldFromPlazaSlug("semantic-学校教育")).toBe("学校教育");
  });

  it("normalizes whitespace to dashes and rejects wrong prefixes", () => {
    expect(toPlazaSlug(" 太空 探索 ")).toBe("semantic-太空-探索");
    expect(fieldFromPlazaSlug("root-学校教育")).toBeNull();
    expect(fieldFromPlazaSlug("semantic-")).toBeNull();
    expect(fieldFromPlazaSlug("")).toBeNull();
  });
});
