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

  it("refreshL2Cache delegates cache aggregation to the migration-owned RPC", async () => {
    const repo = new L2ContentRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await repo.refreshL2Cache("w-1");

    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledWith(
      expect.stringContaining("SELECT public.refresh_l2_cache($1::uuid)"),
      ["w-1"],
    );
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

  it("refreshL2Cache schema-qualifies the RPC to avoid search_path ambiguity", async () => {
    const repo = new L2ContentRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await repo.refreshL2Cache("w-2");

    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("public.refresh_l2_cache");
    expect(sql).not.toMatch(/SELECT\s+refresh_l2_cache/i);
  });

  it("refreshL2Cache casts the word identifier to uuid at the RPC boundary", async () => {
    const repo = new L2ContentRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await repo.refreshL2Cache("w-3");

    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/refresh_l2_cache\(\$1::uuid\)/);
  });

  it("refreshL2Cache binds the requested word identifier as the only parameter", async () => {
    const repo = new L2ContentRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await repo.refreshL2Cache("word-specific-id");

    const [, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["word-specific-id"]);
    expect(params).toHaveLength(1);
  });

  it("refreshL2Cache performs exactly one database round trip", async () => {
    const repo = new L2ContentRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await repo.refreshL2Cache("w-4");

    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("refreshL2Cache does not aggregate or update cache tables in application SQL", async () => {
    const repo = new L2ContentRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);

    await repo.refreshL2Cache("w-5");

    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("word_l2_content");
    expect(sql).not.toMatch(/UPDATE\s+words/i);
    expect(sql).not.toContain("collocations =");
  });
});
