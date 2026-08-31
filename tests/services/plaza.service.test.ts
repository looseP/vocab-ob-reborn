import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import type {
  IRepositories,
  IWordRepository,
} from "@/repositories/interfaces";
import { PlazaService, toPlazaSlug, fieldFromPlazaSlug, toRootSlug, tokenFromRootSlug, extractRootTokens } from "@/services/plaza.service";
import { PlazaCache } from "@/services/plaza-cache";
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
    findRootFamilyGroups: vi.fn(async () => []),
    findBySourcePathPrefix: vi.fn(async () => []),
    findByRootToken: vi.fn(async () => []),
    countReviewStatsByWordIds: vi.fn(async () => ({ tracked: 0, due: 0 })),
    count: vi.fn(async () => 0),
    findSlugs: vi.fn(async () => []),
    ...overrides,
  };
}

/** 注入不触库的 txRunner + repositoryFactory，让服务在测试中走 mock 仓库。 */
function makeService(repo: IWordRepository, cache: PlazaCache = new PlazaCache()): { service: PlazaService; cache: PlazaCache } {
  const txRunner = (async (cb: (tx: PoolClient) => Promise<unknown>) => cb({} as PoolClient)) as typeof import("@/db/transaction").withTransaction;
  const repositoryFactory = (() => ({ words: repo })) as unknown as (tx?: PoolClient) => IRepositories;
  return { service: new PlazaService(repo, txRunner, repositoryFactory, cache), cache };
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
    const { service } = makeService(repo);

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
    const { service } = makeService(repo);

    const result = await service.getOverview({ userId: "user-1", q: "太空" });

    expect(repo.findSemanticFieldGroups).toHaveBeenNthCalledWith(1, undefined);
    expect(repo.findSemanticFieldGroups).toHaveBeenNthCalledWith(2, "太空");
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ showing: 0, total: 1 });
    expect(result.groups).toHaveLength(0);
  });

  it("serves repeated calls from cache without re-querying the repository", async () => {
    const repo = makeMockWordRepo({
      findSemanticFieldGroups: vi.fn(async () => [GROUP_ROW]),
    });
    const { service } = makeService(repo);

    const first = await service.getOverview({ userId: "user-1" });
    const second = await service.getOverview({ userId: "user-1" });

    expect(second).toEqual(first);
    // 缓存命中：第二次不再查库（一次调用 = total+showing 各一次）
    expect(repo.findSemanticFieldGroups).toHaveBeenCalledTimes(2);
  });

  it("re-queries after cache invalidation", async () => {
    const repo = makeMockWordRepo({
      findSemanticFieldGroups: vi.fn(async () => [GROUP_ROW]),
    });
    const { service, cache } = makeService(repo);
    await service.getOverview({ userId: "user-1" });
    expect(cache.size).toBe(1);

    cache.invalidateAll();

    await service.getOverview({ userId: "user-1" });
    expect(repo.findSemanticFieldGroups).toHaveBeenCalledTimes(4);
  });
});

describe("PlazaService.getCollection", () => {
  it("returns detail with word cards for a valid semantic slug", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => [WORD_ROW]),
    });
    const { service } = makeService(repo);

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
    const { service } = makeService(repo);

    await expect(service.getCollection({ userId: "user-1", slug: "root-chart" })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.findBySourcePathPrefix).not.toHaveBeenCalled();
  });

  it("throws NotFound when the derived source path has no words", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => []),
    });
    const { service } = makeService(repo);

    await expect(service.getCollection({ userId: "user-1", slug: "semantic-不存在" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("serves repeated semantic collection details from cache without re-querying", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => [WORD_ROW]),
    });
    const { service } = makeService(repo);

    const first = await service.getCollection({ userId: "user-1", slug: "semantic-学校教育" });
    const second = await service.getCollection({ userId: "user-1", slug: "semantic-学校教育" });

    expect(second).toEqual(first);
    expect(repo.findBySourcePathPrefix).toHaveBeenCalledTimes(1);
  });
});

describe("plaza slug & root token helpers", () => {
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

  it("round-trips root token through root slug", () => {
    expect(toRootSlug("chart")).toBe("root-chart");
    expect(tokenFromRootSlug("root-chart")).toBe("chart");
    expect(tokenFromRootSlug("semantic-学校教育")).toBeNull();
    expect(tokenFromRootSlug("root-")).toBeNull();
    expect(tokenFromRootSlug("root-1x")).toBeNull();
  });

  it("extracts root tokens handling compound, full-width parens, and noise", () => {
    expect(extractRootTokens("chart (from Late Latin charta)")).toEqual(["chart"]);
    expect(extractRootTokens("german（Germania，罗马称谓）")).toEqual(["german"]);
    expect(extractRootTokens("air + condition (air < Latin aer)")).toEqual(["air", "condition"]);
    expect(extractRootTokens("nostos (Greek 'homecoming') + algos (Greek 'pain')")).toEqual(["nostos", "algos"]);
    // 含连字符的专名（al-khwarizmi）被纯字母噪声过滤剔除（JS 与 SQL 一致）
    expect(extractRootTokens("al-Khwarizmi (borrowed Arabic proper name)")).toEqual([]);
    expect(extractRootTokens("cogn (know)")).toEqual(["cogn"]);
    expect(extractRootTokens("")).toEqual([]);
    expect(extractRootTokens("EMPTY")).toEqual([]);
    expect(extractRootTokens(null)).toEqual([]);
    // 噪声：单字符、纯中文/符号被剔除
    expect(extractRootTokens("a (x) + 中国人")).toEqual([]);
    // 同词内去重
    expect(extractRootTokens("leg (Latin) + leg (PIE)")).toEqual(["leg"]);
  });
});

describe("PlazaService.getRootsOverview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns root families with minCount applied to both total and showing", async () => {
    const repo = makeMockWordRepo({
      findRootFamilyGroups: vi.fn(async () => [{ root: "chart", count: 6, updatedAt: "2026-08-28T00:00:00.000Z" }]),
    });
    const { service } = makeService(repo);

    const result = await service.getRootsOverview({ userId: "user-1", minCount: 3 });

    expect(repo.findRootFamilyGroups).toHaveBeenNthCalledWith(1, { minCount: 3 });
    expect(repo.findRootFamilyGroups).toHaveBeenNthCalledWith(2, { minCount: 3, q: undefined, letter: undefined });
    expect(result.available).toBe(true);
    expect(result.counts).toEqual({ showing: 1, total: 1 });
    expect(result.collections[0]).toMatchObject({
      slug: "root-chart",
      title: "chart",
      kind: "root_affix",
      count: 6,
    });
  });

  it("passes q and letter through for root families and defaults minCount to 3", async () => {
    const repo = makeMockWordRepo({
      findRootFamilyGroups: vi.fn(async () => []),
    });
    const { service } = makeService(repo);

    await service.getRootsOverview({ userId: "user-1", q: "tele", letter: "t" });

    expect(repo.findRootFamilyGroups).toHaveBeenNthCalledWith(2, { minCount: 3, q: "tele", letter: "t" });
  });

  it("serves repeated roots overviews from cache without re-querying", async () => {
    const repo = makeMockWordRepo({
      findRootFamilyGroups: vi.fn(async () => [{ root: "chart", count: 6, updatedAt: "2026-08-28T00:00:00.000Z" }]),
    });
    const { service } = makeService(repo);

    const first = await service.getRootsOverview({ userId: "user-1", minCount: 3 });
    const second = await service.getRootsOverview({ userId: "user-1", minCount: 3 });

    expect(second).toEqual(first);
    // 缓存命中：一次调用 = total+showing 各一次，共 2 次查库
    expect(repo.findRootFamilyGroups).toHaveBeenCalledTimes(2);
  });

  it("isolates cache entries by filter parameters (minCount/q/letter)", async () => {
    const repo = makeMockWordRepo({
      findRootFamilyGroups: vi.fn(async () => [{ root: "chart", count: 6, updatedAt: "2026-08-28T00:00:00.000Z" }]),
    });
    const { service } = makeService(repo);

    await service.getRootsOverview({ userId: "user-1", minCount: 3 });
    await service.getRootsOverview({ userId: "user-1", minCount: 10 });
    await service.getRootsOverview({ userId: "user-1", minCount: 3, q: "chart" });

    // 三种不同 key → 各触发一次全量+过滤查库
    expect(repo.findRootFamilyGroups).toHaveBeenCalledTimes(6);
  });
});

describe("PlazaService.getRootCollection", () => {
  it("returns a root collection detail with root structure cards", async () => {
    const repo = makeMockWordRepo({
      findByRootToken: vi.fn(async () => [
        {
          ...WORD_ROW,
          metadata: {
            semantic_chain: "纸 -> 图表",
            morphology_root: "chart (from Late Latin charta)",
            morphology_prefix: "EMPTY",
            morphology_suffix: "",
          },
        },
      ]),
    });
    const { service } = makeService(repo);

    const result = await service.getRootCollection({ userId: "user-1", slug: "root-chart" });

    expect(repo.findByRootToken).toHaveBeenCalledWith("chart");
    expect(result).toMatchObject({
      slug: "root-chart",
      title: "chart",
      kind: "root_affix",
      count: 1,
      type: "simple",
    });
    expect(result.words[0]).toEqual({
      id: "w-1",
      slug: "abound",
      lemma: "abound",
      cefr: "B2",
      short_definition: "大量存在",
      semantic_chain: "纸 -> 图表",
      root: "chart (from Late Latin charta)",
      prefix: null,
      suffix: null,
    });
  });

  it("throws NotFound for an unknown root token", async () => {
    const repo = makeMockWordRepo({
      findByRootToken: vi.fn(async () => []),
    });
    const { service } = makeService(repo);

    await expect(service.getRootCollection({ userId: "user-1", slug: "root-unknown" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("serves repeated root collection details from cache without re-querying", async () => {
    const repo = makeMockWordRepo({
      findByRootToken: vi.fn(async () => [WORD_ROW]),
    });
    const { service } = makeService(repo);

    const first = await service.getRootCollection({ userId: "user-1", slug: "root-chart" });
    const second = await service.getRootCollection({ userId: "user-1", slug: "root-chart" });

    expect(second).toEqual(first);
    expect(repo.findByRootToken).toHaveBeenCalledTimes(1);
  });
});

describe("PlazaService.getReviewStats", () => {
  it("aggregates review stats for a semantic-field slug", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => [WORD_ROW]),
      countReviewStatsByWordIds: vi.fn(async () => ({ tracked: 3, due: 1 })),
    });
    const { service } = makeService(repo);

    const stats = await service.getReviewStats({ userId: "user-1", slug: "semantic-学校教育" });

    expect(repo.findBySourcePathPrefix).toHaveBeenCalledWith("L1_雅思词汇/L1_雅思词汇_学校教育.md");
    expect(repo.countReviewStatsByWordIds).toHaveBeenCalledWith("user-1", ["w-1"]);
    expect(stats).toEqual({ tracked: 3, due: 1 });
  });

  it("aggregates review stats for a root-family slug", async () => {
    const repo = makeMockWordRepo({
      findByRootToken: vi.fn(async () => [WORD_ROW]),
      countReviewStatsByWordIds: vi.fn(async () => ({ tracked: 2, due: 0 })),
    });
    const { service } = makeService(repo);

    const stats = await service.getReviewStats({ userId: "user-1", slug: "root-chart" });

    expect(repo.findByRootToken).toHaveBeenCalledWith("chart");
    expect(stats).toEqual({ tracked: 2, due: 0 });
  });

  it("throws NotFound for an unknown collection", async () => {
    const repo = makeMockWordRepo({
      findBySourcePathPrefix: vi.fn(async () => []),
    });
    const { service } = makeService(repo);

    await expect(service.getReviewStats({ userId: "user-1", slug: "semantic-不存在" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
