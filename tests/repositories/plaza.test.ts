import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  getBatchImportPool: () => mock.pool,
  resetPool: vi.fn(),
  checkPoolHealth: vi.fn(),
}));

import { WordRepository } from "@/repositories/word.repository";

beforeEach(() => {
  mock.reset();
});

describe("WordRepository.findSemanticFieldGroups", () => {
  it("groups published L1 words by source_path prefix and filters stub rows", async () => {
    mock.setRows([
      { field: "学校教育", count: 2, updated_at: "2026-08-28T00:00:00.000Z" },
      { field: "太空探索", count: 1, updated_at: "2026-08-27T00:00:00.000Z" },
    ]);
    const repository = new WordRepository();

    const groups = await repository.findSemanticFieldGroups();

    const query = mock.lastQuery!;
    expect(query.text).toContain("FROM words w");
    expect(query.text).toContain("w.is_published = true");
    expect(query.text).toContain("w.is_deleted = false");
    expect(query.text).toContain("w.definition_md <> ''");
    expect(query.text).toContain("'L1_雅思词汇/L1_雅思词汇_%.md'");
    expect(query.text).toContain("substring(w.metadata->>'source_path'");
    expect(query.text).toContain("GROUP BY 1");
    expect(query.text).toContain("ORDER BY count DESC, field ASC");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ field: "学校教育", count: 2, updated_at: "2026-08-28T00:00:00.000Z" });
  });

  it("appends an ILIKE substring filter when q is provided", async () => {
    mock.setRows([]);
    const repository = new WordRepository();

    await repository.findSemanticFieldGroups("太空");

    const query = mock.lastQuery!;
    expect(query.text).toContain("ILIKE");
    expect(query.text).toContain("w.metadata->>'source_path' ILIKE $1");
    expect(query.params).toContain("%太空%");
  });

  it("drops rows whose extracted field is empty", async () => {
    mock.setRows([
      { field: "学校教育", count: 2, updated_at: "2026-08-28T00:00:00.000Z" },
      { field: null, count: 5, updated_at: "2026-08-28T00:00:00.000Z" },
    ]);
    const repository = new WordRepository();

    const groups = await repository.findSemanticFieldGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].field).toBe("学校教育");
  });
});

describe("WordRepository.findBySourcePathPrefix", () => {
  it("selects published words for the exact source_path prefix ordered by lemma", async () => {
    mock.setRows([{ id: "w-1", slug: "abound", lemma: "abound" }]);
    const repository = new WordRepository();

    const words = await repository.findBySourcePathPrefix("L1_雅思词汇/L1_雅思词汇_学校教育.md");

    const query = mock.lastQuery!;
    expect(query.text).toContain("SELECT w.id, w.slug, w.title, w.lemma, w.pos, w.cefr, w.ipa, w.short_definition, w.metadata, w.updated_at");
    expect(query.text).toContain("w.metadata->>'source_path' = $1");
    expect(query.text).toContain("ORDER BY w.lemma ASC");
    expect(query.params).toEqual(["L1_雅思词汇/L1_雅思词汇_学校教育.md"]);
    expect(words).toHaveLength(1);
  });
});

describe("WordRepository.findRootFamilyGroups", () => {
  it("unnests compound morphology roots, extracts tokens, and filters noise", async () => {
    mock.setRows([{ root: "chart", count: 6, updated_at: "2026-08-28T00:00:00.000Z" }]);
    const repository = new WordRepository();

    const groups = await repository.findRootFamilyGroups({ minCount: 3 });

    const query = mock.lastQuery!;
    expect(query.text).toContain("string_to_array(w.metadata->>'morphology_root', '+')");
    expect(query.text).toContain("substring(btrim(part) FROM '^[^ (（+]+')");
    expect(query.text).toContain("~ '^[a-z]{2,}$'");
    expect(query.text).toContain("HAVING count(*) >= $1");
    expect(query.text).toContain("ORDER BY count DESC, root ASC");
    expect(query.params).toEqual([3]);
    expect(groups).toEqual([{ root: "chart", count: 6, updated_at: "2026-08-28T00:00:00.000Z" }]);
  });

  it("appends q ILIKE and letter prefix filters with correct param ordering", async () => {
    mock.setRows([]);
    const repository = new WordRepository();

    await repository.findRootFamilyGroups({ minCount: 5, q: "tele", letter: "t" });

    const query = mock.lastQuery!;
    expect(query.text).toContain("ILIKE $1");
    expect(query.text).toContain("HAVING count(*) >= $2");
    expect(query.text).toContain("root LIKE $3");
    // where 的 q(%tele%) → having 的 minCount(5) → letter(t%)
    expect(query.params).toEqual(["%tele%", 5, "t%"]);
  });
});

describe("WordRepository.findByRootToken", () => {
  it("matches words whose morphology_root contains the token, ordered by lemma", async () => {
    mock.setRows([{ id: "w-1", slug: "abound", lemma: "abound" }]);
    const repository = new WordRepository();

    const words = await repository.findByRootToken("chart");

    const query = mock.lastQuery!;
    expect(query.text).toContain("EXISTS (");
    expect(query.text).toContain("string_to_array(w.metadata->>'morphology_root', '+')");
    expect(query.text).toContain("= $1");
    expect(query.params).toEqual(["chart"]);
    expect(words).toHaveLength(1);
  });
});
