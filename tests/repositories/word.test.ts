import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createMockPool } from "../helpers/mock-db";

// insertMany writes through the dedicated batch-import pool, so the mock has
// to provide both pools and the tests assert the app pool stays untouched.
const mock = createMockPool();
const batchMock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  getBatchImportPool: () => batchMock.pool,
  resetPool: vi.fn(),
  checkPoolHealth: vi.fn(),
}));

import { WordRepository } from "@/repositories/word.repository";

beforeEach(() => {
  mock.reset();
  batchMock.reset();
});

describe("WordRepository.insertMany", () => {
  it("returns 0 without querying for an empty batch", async () => {
    const repository = new WordRepository();

    await expect(repository.insertMany([])).resolves.toBe(0);
    expect(batchMock.calls).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("writes one 13-column row per word via the batch pool and returns the row count", async () => {
    batchMock.setRows([{ id: "w-1" }, { id: "w-2" }]);
    const repository = new WordRepository();

    const inserted = await repository.insertMany([
      { slug: "abound", title: "Abound", lemma: "abound", pos: "verb", cefr: "C1", ipa: "/əˈbaʊnd/", short_definition: "exist in large numbers" },
      { slug: "breach", title: "Breach", lemma: "breach", pos: null, cefr: null, ipa: null, short_definition: null },
    ]);

    expect(inserted).toBe(2);
    const query = batchMock.lastQuery!;
    expect(query.text).toContain("INSERT INTO words");
    expect(query.text).toContain("ON CONFLICT (slug) DO UPDATE");
    expect(query.params).toHaveLength(26);

    expect(query.params.slice(0, 7)).toEqual([
      "abound", "Abound", "abound", "verb", "C1", "/əˈbaʊnd/", "exist in large numbers",
    ]);
    // content_hash is a sha256 hex digest; markdown columns derive from the short definition
    expect(query.params[7]).toMatch(/^[0-9a-f]{64}$/);
    expect(query.params[8]).toBe("batch-import/abound.md");
    expect(query.params[9]).toBe("exist in large numbers");
    expect(query.params[10]).toBe("exist in large numbers");
    // 英文释义无汉字 → 拼音列为 null
    expect(query.params[11]).toBeNull();
    expect(query.params[12]).toBeNull();

    // second row: nullable fields stay null, empty short definition becomes ""
    expect(query.params.slice(13, 20)).toEqual(["breach", "Breach", "breach", null, null, null, ""]);
    expect(query.params[21]).toBe("batch-import/breach.md");
    expect(query.params[22]).toBe("");
    expect(query.params[23]).toBe("");
    // 空释义 → 拼音列仍为 null
    expect(query.params[24]).toBeNull();
    expect(query.params[25]).toBeNull();

    // the read-only vocab_app pool must never see the bulk write
    expect(mock.calls).toHaveLength(0);
  });

  it("computes pinyin columns from Chinese short definitions on insert", async () => {
    batchMock.setRows([{ id: "w-1" }]);
    const repository = new WordRepository();

    await repository.insertMany([
      { slug: "courage", title: "Courage", lemma: "courage", pos: "n", cefr: "B2", ipa: "/ˈkʌrɪdʒ/", short_definition: "勇气，胆量" },
    ]);

    const query = batchMock.lastQuery!;
    expect(query.params[11]).toBe("yongqidanliang");
    expect(query.params[12]).toBe("yqdl");
  });

  it("derives a deterministic sha256 content hash from all batch fields", async () => {
    batchMock.setRows([{ id: "w-1" }]);
    const repository = new WordRepository();

    await repository.insertMany([
      { slug: "abound", title: "Abound", lemma: "abound", pos: "verb", cefr: "C1", ipa: "ipa", short_definition: "def" },
    ]);

    const expected = createHash("sha256")
      .update(["abound", "Abound", "abound", "verb", "C1", "ipa", "def"].join("\u0000"))
      .digest("hex");
    expect(batchMock.lastQuery!.params[7]).toBe(expected);
  });

  it("propagates a 500-level failure from the batch pool", async () => {
    batchMock.pool.query = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const repository = new WordRepository();

    await expect(repository.insertMany([
      { slug: "abound", title: "Abound", lemma: "abound", pos: null, cefr: null, ipa: null, short_definition: null },
    ])).rejects.toThrow("connection refused");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("WordRepository.findPublic", () => {
  it("adds a cefr predicate and binds the value when a cefr filter is provided", async () => {
    mock.setRowMap({
      "count(*)": [{ total: 1 }],
      "ORDER BY w.lemma": [
        { id: "w-1", slug: "farcical", title: "farcical", lemma: "farcical", pos: "adj", cefr: "C2", ipa: null, short_definition: null },
      ],
    });
    const repository = new WordRepository();

    const result = await repository.findPublic({
      filters: { cefr: "C2" },
      pagination: { limit: 50, offset: 0 },
      userId: "u-1",
    });

    expect(result.total).toBe(1);
    // 最后执行的 data 查询应带 cefr 过滤条件，且参数绑定传入 C2
    const dataQuery = mock.lastQuery!;
    expect(dataQuery.text).toContain("w.cefr = $");
    expect(dataQuery.params).toContain("C2");
    // count 查询同样带 cefr 过滤
    expect(mock.calls[0]!.text).toContain("w.cefr = $");
    expect(mock.calls[0]!.params).toContain("C2");
  });

  it("omits the cefr predicate when no cefr filter is provided", async () => {
    mock.setRowMap({
      "count(*)": [{ total: 0 }],
      "ORDER BY w.lemma": [],
    });
    const repository = new WordRepository();

    await repository.findPublic({
      filters: {},
      pagination: { limit: 50, offset: 0 },
      userId: "u-1",
    });

    // SELECT 列表本身含 w.cefr 列，这里断言的是"无过滤条件"（WHERE 中无 w.cefr = 谓词）
    expect(mock.calls[0]!.text).not.toContain("w.cefr = ");
    expect(mock.lastQuery!.text).not.toContain("w.cefr = ");
  });

  it("adds Chinese substring, pinyin, and typo-tolerance predicates with relevance ordering when a q filter is provided", async () => {
    mock.setRowMap({
      "count(*)": [{ total: 3 }],
      "ORDER BY CASE": [
        { id: "w-1", slug: "courage", title: "courage", lemma: "courage", pos: "n", cefr: "B2", ipa: null, short_definition: "勇气" },
      ],
    });
    const repository = new WordRepository();

    const result = await repository.findPublic({
      filters: { q: "勇气" },
      pagination: { limit: 20, offset: 0 },
      userId: "u-1",
    });

    expect(result.total).toBe(3);
    const dataQuery = mock.lastQuery!;
    // 中文释义子串 + 拼音 + 拼写容错谓词
    expect(dataQuery.text).toContain("short_definition ILIKE $");
    expect(dataQuery.text).toContain("definition_md ILIKE $");
    expect(dataQuery.text).toContain("pinyin ILIKE $");
    expect(dataQuery.text).toContain("pinyin_initial ILIKE $");
    expect(dataQuery.text).toContain("word_similarity($");
    // 相关性排序：精确 > 前缀 > 全文 > 拼音 > 子串，GREATEST(ts_rank, word_similarity) 兜底
    expect(dataQuery.text).toContain("WHEN w.lemma ILIKE $");
    expect(dataQuery.text).toContain("ts_rank(");
    expect(dataQuery.text).toContain("GREATEST(");
    // WHERE(7) + ORDER(7) + limit + offset = 16 个参数；%q% 通配：WHERE 5 + ORDER 2 = 7
    expect(dataQuery.params).toHaveLength(16);
    expect(dataQuery.params.filter((p) => p === "%勇气%")).toHaveLength(7);
    expect(dataQuery.params).toContain("勇气%");
    expect(dataQuery.params[dataQuery.params.length - 2]).toBe(20);
    expect(dataQuery.params[dataQuery.params.length - 1]).toBe(0);
    // count 查询只带 WHERE 参数（不含排序参数）
    expect(mock.calls[0]!.params).toEqual(["勇气", "%勇气%", "%勇气%", "%勇气%", "%勇气%", "%勇气%", "勇气"]);
  });

  it("strips spaces from the query when matching pinyin columns", async () => {
    mock.setRowMap({
      "count(*)": [{ total: 1 }],
      "ORDER BY CASE": [],
    });
    const repository = new WordRepository();

    await repository.findPublic({
      filters: { q: "yong qi" },
      pagination: { limit: 20, offset: 0 },
      userId: "u-1",
    });

    const dataQuery = mock.lastQuery!;
    // 拼音列用去空格后的查询词匹配（与无空格存储对齐）；lemma/释义 ILIKE 仍保留空格原样
    expect(dataQuery.params).toContain("%yongqi%");
    expect(dataQuery.params).toContain("%yong qi%");
  });

  it("keeps lemma ordering and no search predicates when no q is provided", async () => {
    mock.setRowMap({
      "count(*)": [{ total: 0 }],
      "ORDER BY w.lemma": [],
    });
    const repository = new WordRepository();

    await repository.findPublic({
      filters: {},
      pagination: { limit: 50, offset: 0 },
      userId: "u-1",
    });

    expect(mock.lastQuery!.text).toContain("ORDER BY w.lemma ASC");
    expect(mock.lastQuery!.text).not.toContain("short_definition ILIKE");
    expect(mock.lastQuery!.text).not.toContain("ts_rank(");
  });
});
