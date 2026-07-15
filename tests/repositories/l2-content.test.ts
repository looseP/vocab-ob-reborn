import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { L2ContentRepository, extractL2Items } from "@/repositories/l2-content.repository";

describe("L2ContentRepository", () => {
  it("insert creates an L2 content row", async () => {
    const repo = new L2ContentRepository();
    const mockRow = { id: "lc-1", word_id: "w-1", field: "collocation", content: { x: 1 } };
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(mockRow);
    const result = await repo.insert({
      word_id: "w-1",
      field: "collocation",
      content: { x: 1 },
      source: "llm",
    });
    expect(result.id).toBe("lc-1");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO word_l2_content");
    // content should be JSON-stringified for the jsonb column
    expect(params[2]).toBe(JSON.stringify({ x: 1 }));
  });

  it("insert rejects when the database returns no row", async () => {
    const repo = new L2ContentRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.insert({
      word_id: "w-1",
      field: "collocation",
      content: { x: 1 },
      source: "llm",
    })).rejects.toThrow("L2 content insert returned no row");
  });

  it("findByWord returns all active rows when field is omitted", async () => {
    const repo = new L2ContentRepository();
    const mockRows = [{ id: "lc-1" }, { id: "lc-2" }];
    vi.spyOn(repo as any, "query").mockResolvedValue(mockRows);
    const result = await repo.findByWord("w-1");
    expect(result).toHaveLength(2);
    const sql = (repo as any).query.mock.calls[0][0] as string;
    expect(sql).toContain("is_active = true");
    expect(sql).not.toContain("AND field =");
  });

  it("findByWord filters by field when provided", async () => {
    const repo = new L2ContentRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "lc-1" }]);
    await repo.findByWord("w-1", "collocation");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("AND field = $2");
    expect(params).toEqual(["w-1", "collocation"]);
  });

  it("softDelete sets is_active=false", async () => {
    const repo = new L2ContentRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([]);
    await repo.softDelete("lc-1");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("UPDATE word_l2_content SET is_active = false");
    expect(params).toEqual(["lc-1"]);
  });

  it("refreshL2Cache groups active content by field and updates words JSONB columns", async () => {
    const repo = new L2ContentRepository();
    const selectRows = [
      { field: "collocation", content: { phrase: "heavy rain" } },
      { field: "collocation", content: { phrase: "light rain" } },
      { field: "corpus", content: { sent: "It rained." } },
      { field: "synonym", content: { word: "drizzle" } },
    ];
    const querySpy = vi
      .spyOn(repo as any, "query")
      // first call: SELECT field, content ...
      .mockResolvedValueOnce(selectRows)
      // second call: UPDATE words SET ...
      .mockResolvedValueOnce([]);

    await repo.refreshL2Cache("w-1");

    // 2 query calls: SELECT then UPDATE
    expect(querySpy).toHaveBeenCalledTimes(2);

    const [selectSql, selectParams] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(selectSql).toContain("SELECT field, content FROM word_l2_content");
    expect(selectSql).toContain("is_active = true");
    expect(selectParams).toEqual(["w-1"]);

    const [updateSql, updateParams] = querySpy.mock.calls[1] as [string, string[]];
    expect(updateSql).toContain("UPDATE words SET");
    expect(updateSql).toContain("collocations = $2");
    expect(updateSql).toContain("corpus_items = $3");
    expect(updateSql).toContain("synonym_items = $4");
    expect(updateSql).toContain("antonym_items = $5");
    expect(updateParams[0]).toBe("w-1");
    // collocation group has 2 items
    expect(JSON.parse(updateParams[1])).toHaveLength(2);
    // corpus group has 1 item
    expect(JSON.parse(updateParams[2])).toHaveLength(1);
    // synonym group has 1 item
    expect(JSON.parse(updateParams[3])).toHaveLength(1);
    // antonym group absent → empty array
    expect(JSON.parse(updateParams[4])).toEqual([]);
  });

  describe("extractL2Items", () => {
    it("returns a bare array as-is", () => {
      const arr = [{ a: 1 }, { a: 2 }];
      expect(extractL2Items(arr)).toBe(arr);
    });

    it("unwraps a v1 wrapper's items", () => {
      const wrapped = {
        schemaVersion: "l2-content-v1",
        items: [{ a: 1 }, { a: 2 }],
      };
      expect(extractL2Items(wrapped)).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it("wraps a single object into a one-element array", () => {
      const obj = { phrase: "heavy rain" };
      expect(extractL2Items(obj)).toEqual([{ phrase: "heavy rain" }]);
    });

    it("returns an empty array for null / undefined / primitives", () => {
      expect(extractL2Items(null)).toEqual([]);
      expect(extractL2Items(undefined)).toEqual([]);
      expect(extractL2Items("string")).toEqual([]);
      expect(extractL2Items(42)).toEqual([]);
    });

    it("returns [] for an object that is not a v1 wrapper", () => {
      // object without schemaVersion / items → treated as single item
      expect(extractL2Items({ foo: "bar" })).toEqual([{ foo: "bar" }]);
      // wrong schemaVersion → NOT unwrapped, treated as single item
      expect(extractL2Items({ schemaVersion: "other", items: [1, 2] })).toEqual([
        { schemaVersion: "other", items: [1, 2] },
      ]);
      // v1 wrapper but items not an array → treated as single item
      expect(extractL2Items({ schemaVersion: "l2-content-v1", items: "nope" })).toEqual([
        { schemaVersion: "l2-content-v1", items: "nope" },
      ]);
    });
  });

  it("refreshL2Cache flattens a legacy array row into cache items", async () => {
    const repo = new L2ContentRepository();
    const selectRows = [
      { field: "collocation", content: [{ phrase: "heavy rain" }, { phrase: "light rain" }] },
    ];
    vi.spyOn(repo as any, "query")
      .mockResolvedValueOnce(selectRows)
      .mockResolvedValueOnce([]);

    await repo.refreshL2Cache("w-1");

    const updateParams = (repo as any).query.mock.calls[1][1] as string[];
    const collocations = JSON.parse(updateParams[1]);
    expect(collocations).toEqual([{ phrase: "heavy rain" }, { phrase: "light rain" }]);
    // not nested as a single array element
    expect(collocations).not.toEqual([[{ phrase: "heavy rain" }, { phrase: "light rain" }]]);
  });

  it("refreshL2Cache flattens a v1 wrapper row into cache items", async () => {
    const repo = new L2ContentRepository();
    const selectRows = [
      {
        field: "corpus",
        content: {
          schemaVersion: "l2-content-v1",
          items: [{ sent: "It rained." }, { sent: "It poured." }],
        },
      },
    ];
    vi.spyOn(repo as any, "query")
      .mockResolvedValueOnce(selectRows)
      .mockResolvedValueOnce([]);

    await repo.refreshL2Cache("w-1");

    const updateParams = (repo as any).query.mock.calls[1][1] as string[];
    const corpus = JSON.parse(updateParams[2]);
    expect(corpus).toEqual([{ sent: "It rained." }, { sent: "It poured." }]);
  });

  it("refreshL2Cache wraps a single object row into one cache item", async () => {
    const repo = new L2ContentRepository();
    const selectRows = [{ field: "synonym", content: { word: "drizzle" } }];
    vi.spyOn(repo as any, "query")
      .mockResolvedValueOnce(selectRows)
      .mockResolvedValueOnce([]);

    await repo.refreshL2Cache("w-1");

    const updateParams = (repo as any).query.mock.calls[1][1] as string[];
    const synonyms = JSON.parse(updateParams[3]);
    expect(synonyms).toEqual([{ word: "drizzle" }]);
    expect(synonyms).toHaveLength(1);
  });

  it("refreshL2Cache merges multiple active rows for a field in query order", async () => {
    const repo = new L2ContentRepository();
    // rows arrive in created_at order; second is a v1 wrapper, third a bare array
    const selectRows = [
      { field: "antonym", content: { word: "dry" } },
      { field: "antonym", content: { schemaVersion: "l2-content-v1", items: [{ word: "arid" }] } },
      { field: "antonym", content: [{ word: "parched" }, { word: "bone-dry" }] },
    ];
    vi.spyOn(repo as any, "query")
      .mockResolvedValueOnce(selectRows)
      .mockResolvedValueOnce([]);

    await repo.refreshL2Cache("w-1");

    const updateParams = (repo as any).query.mock.calls[1][1] as string[];
    const antonyms = JSON.parse(updateParams[4]);
    expect(antonyms).toEqual([
      { word: "dry" },
      { word: "arid" },
      { word: "parched" },
      { word: "bone-dry" },
    ]);
  });

  it("refreshL2Cache writes an empty array for a field with no rows", async () => {
    const repo = new L2ContentRepository();
    // only a collocation row; corpus/synonym/antonym absent
    const selectRows = [{ field: "collocation", content: { phrase: "heavy rain" } }];
    vi.spyOn(repo as any, "query")
      .mockResolvedValueOnce(selectRows)
      .mockResolvedValueOnce([]);

    await repo.refreshL2Cache("w-1");

    const updateParams = (repo as any).query.mock.calls[1][1] as string[];
    expect(JSON.parse(updateParams[2])).toEqual([]); // corpus
    expect(JSON.parse(updateParams[3])).toEqual([]); // synonym
    expect(JSON.parse(updateParams[4])).toEqual([]); // antonym
  });
});
