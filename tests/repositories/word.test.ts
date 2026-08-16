import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  resetPool: vi.fn(),
  checkPoolHealth: vi.fn(),
}));

import { WordRepository } from "@/repositories/word.repository";

beforeEach(() => mock.reset());

describe("WordRepository.insertMany", () => {
  it("returns 0 without querying for an empty batch", async () => {
    const repository = new WordRepository();

    await expect(repository.insertMany([])).resolves.toBe(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("writes one 11-column row per word and returns the row count", async () => {
    mock.setRows([{ id: "w-1" }, { id: "w-2" }]);
    const repository = new WordRepository();

    const inserted = await repository.insertMany([
      { slug: "abound", title: "Abound", lemma: "abound", pos: "verb", cefr: "C1", ipa: "/əˈbaʊnd/", short_definition: "exist in large numbers" },
      { slug: "breach", title: "Breach", lemma: "breach", pos: null, cefr: null, ipa: null, short_definition: null },
    ]);

    expect(inserted).toBe(2);
    const query = mock.lastQuery!;
    expect(query.text).toContain("INSERT INTO words");
    expect(query.text).toContain("ON CONFLICT (slug) DO UPDATE");
    expect(query.params).toHaveLength(22);

    expect(query.params.slice(0, 7)).toEqual([
      "abound", "Abound", "abound", "verb", "C1", "/əˈbaʊnd/", "exist in large numbers",
    ]);
    // content_hash is a sha256 of the slug; markdown columns are placeholders
    expect(query.params[7]).toBe(createHash("sha256").update("abound").digest("hex"));
    expect(query.params.slice(8, 11)).toEqual(["", "", ""]);

    expect(query.params.slice(11, 18)).toEqual([
      "breach", "Breach", "breach", null, null, null, null,
    ]);
    expect(query.params[18]).toBe(createHash("sha256").update("breach").digest("hex"));
    expect(query.params.slice(19, 22)).toEqual(["", "", ""]);
  });

  it("propagates a database failure from the pool", async () => {
    mock.pool.query = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const repository = new WordRepository();

    await expect(repository.insertMany([
      { slug: "abound", title: "Abound", lemma: "abound", pos: null, cefr: null, ipa: null, short_definition: null },
    ])).rejects.toThrow("connection refused");
  });
});
