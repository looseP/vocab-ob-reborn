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

  it("writes one 11-column row per word via the batch pool and returns the row count", async () => {
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
    expect(query.params).toHaveLength(22);

    expect(query.params.slice(0, 7)).toEqual([
      "abound", "Abound", "abound", "verb", "C1", "/əˈbaʊnd/", "exist in large numbers",
    ]);
    // content_hash is a sha256 hex digest; markdown columns derive from the short definition
    expect(query.params[7]).toMatch(/^[0-9a-f]{64}$/);
    expect(query.params[8]).toBe("batch-import/abound.md");
    expect(query.params[9]).toBe("exist in large numbers");
    expect(query.params[10]).toBe("exist in large numbers");

    // second row: nullable fields stay null, empty short definition becomes ""
    expect(query.params.slice(11, 18)).toEqual(["breach", "Breach", "breach", null, null, null, ""]);
    expect(query.params[19]).toBe("batch-import/breach.md");
    expect(query.params[20]).toBe("");
    expect(query.params[21]).toBe("");

    // the read-only vocab_app pool must never see the bulk write
    expect(mock.calls).toHaveLength(0);
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
