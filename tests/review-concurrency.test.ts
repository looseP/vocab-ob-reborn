/**
 * Integration test — connects to the real PostgreSQL DB (the same one v1
 * imported 6767 words into). Skipped unless TEST_DATABASE_URL is set.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRepositories, resetDb, withTransaction } from "@/index";
import type { Pool } from "pg";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)("ReviewRepository (integration)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DB_URL!;
  });

  afterAll(async () => {
    await resetDb();
  });

  it("finds the 6767 imported words", async () => {
    const repos = createRepositories();
    const count = await repos.words.count();
    expect(count).toBe(6767);
  });

  it("finds a word by slug (aboard)", async () => {
    const repos = createRepositories();
    const word = await repos.words.findBySlug("aboard");
    expect(word).not.toBeNull();
    expect(word!.lemma).toBe("aboard");
    expect(word!.definition_md).toBeTruthy();
  });

  it("findPublic returns paginated results", async () => {
    const repos = createRepositories();
    const result = await repos.words.findPublic({
      pagination: { limit: 5, offset: 0 },
    });
    expect(result.items.length).toBe(5);
    expect(result.total).toBe(6767);
    expect(result.hasMore).toBe(true);
  });

  it("findPublic with search filter works", async () => {
    const repos = createRepositories();
    const result = await repos.words.findPublic({
      filters: { q: "abandon" },
      pagination: { limit: 10, offset: 0 },
    });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((w) => w.lemma.includes("abandon"))).toBe(true);
  });

  it("findSlugs returns ordered slugs", async () => {
    const repos = createRepositories();
    const slugs = await repos.words.findSlugs(100);
    expect(slugs.length).toBe(100);
    expect(slugs).toEqual([...slugs].sort());
  });

  it("transaction commits successfully", async () => {
    const result = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      const count = await repos.words.count();
      return count;
    });
    expect(result).toBe(6767);
  });

  it("dashboard summary returns valid data", async () => {
    const repos = createRepositories();
    const summary = await repos.stats.getDashboardSummary(
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    );
    expect(summary.totalWords).toBe(6767);
    expect(summary.trackedWords).toBeGreaterThanOrEqual(0);
  });
});
