import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";

beforeEach(() => mock.reset());

describe("L3RecommendationRepository", () => {
  it("creates runs and items only in recommendation tables", async () => {
    mock.setRowMap({
      "INSERT INTO l3_recommendation_runs": [{ id: "run-1", user_id: "u1", mode: "review_pack", status: "completed" }],
      "INSERT INTO l3_recommendation_items": [{ id: "rec-1", run_id: "run-1", user_id: "u1", recommendation_type: "review_pack", status: "pending" }],
    });
    const repos = createRepositories();

    await repos.l3Recommendation.createRun({
      user_id: "u1",
      wordbook_id: "wb-1",
      mode: "review_pack",
      stats: { itemCount: 1 },
    });
    await repos.l3Recommendation.createItem({
      run_id: "run-1",
      user_id: "u1",
      wordbook_id: "wb-1",
      recommendation_type: "review_pack",
      title: "Review pack",
      summary: "Due words",
      priority_score: 80,
      confidence: 0.8,
      reason_codes: ["fsrs_due"],
      evidence: [{ type: "fsrs_due", ref: { wordId: "w1" } }],
      payload: { words: [{ wordId: "w1" }] },
    });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_recommendation_runs");
    expect(sql).toContain("INSERT INTO l3_recommendation_items");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
    expect(sql).not.toContain("UPDATE words");
  });

  it("lists and gets recommendations scoped to the requesting user", async () => {
    mock.setRows([{ id: "rec-1", user_id: "u1", status: "pending", recommendation_type: "review_pack", created_at: "2026-07-08T00:00:00Z" }]);
    const repos = createRepositories();

    await repos.l3Recommendation.listItems({ userId: "u1", status: "pending", recommendationType: "review_pack", limit: 10 });
    expect(mock.lastQuery?.text).toContain("WHERE user_id = $1::uuid");
    expect(mock.lastQuery?.text).toContain("AND status = $3");
    expect(mock.lastQuery?.text).toContain("AND recommendation_type = $4");

    await repos.l3Recommendation.findItemByIdForUser("u1", "rec-1");
    expect(mock.lastQuery?.text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.params).toEqual(["rec-1", "u1"]);
  });

  it("rejects malformed recommendation cursors before querying", async () => {
    const repos = createRepositories();

    await expect(repos.l3Recommendation.listItems({
      userId: "u1",
      status: "pending",
      limit: 10,
      cursor: "bad-cursor",
    })).rejects.toBeInstanceOf(Error);
    expect(mock.calls).toHaveLength(0);
  });

  it("updates recommendation status scoped to owner", async () => {
    mock.setRows([{ id: "rec-1", user_id: "u1", status: "accepted", accepted_proposal_id: "prop-1" }]);
    const repos = createRepositories();

    await repos.l3Recommendation.markItemStatus("rec-1", "u1", "accepted", "prop-1");

    expect(mock.lastQuery?.text).toContain("UPDATE l3_recommendation_items");
    expect(mock.lastQuery?.text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.text).toContain("accepted_proposal_id");
    expect(mock.lastQuery?.params).toEqual(["rec-1", "u1", "accepted", "prop-1"]);
  });

  it("reads bounded deterministic recommendation signals", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await repos.l3Recommendation.findSignals({ userId: "u1", wordbookId: "wb-1", seedSlug: "vivid", horizonDays: 7, limit: 25 });

    expect(mock.lastQuery?.text).toContain("FROM wordbook_items wi");
    expect(mock.lastQuery?.text).toContain("JOIN wordbooks wb ON wb.id = wi.wordbook_id AND wb.user_id = $1::uuid");
    expect(mock.lastQuery?.text).toContain("LIMIT $3");
    expect(mock.lastQuery?.text).not.toContain("UPDATE");
    expect(mock.lastQuery?.params).toEqual(["u1", 7, 25, "wb-1", "vivid"]);
  });

  it("excludes link gaps when either directional word link already exists", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await repos.l3Recommendation.findLinkGapCandidates({
      userId: "u1",
      wordbookId: "wb-1",
      seedSlug: null,
      horizonDays: 7,
      limit: 25,
    });

    expect(mock.lastQuery?.text).toContain("(l.word_id = o1.word_id AND l.target_id = o2.word_id::text)");
    expect(mock.lastQuery?.text).toContain("(l.word_id = o2.word_id AND l.target_id = o1.word_id::text)");
    expect(mock.lastQuery?.text).not.toContain("INSERT");
    expect(mock.lastQuery?.text).not.toContain("UPDATE");
  });

  it("declares recommendation owner constraints in migration", () => {
    const migration = readFileSync(join(process.cwd(), "drizzle/0009_magenta_captain_flint.sql"), "utf8");
    const hardeningMigration = readFileSync(join(process.cwd(), "drizzle/0010_hesitant_mojo.sql"), "utf8");

    expect(migration).toContain('CREATE TABLE "l3_recommendation_runs"');
    expect(migration).toContain('CREATE TABLE "l3_recommendation_items"');
    expect(migration).toContain('CONSTRAINT "l3_recommendation_runs_id_user_id_unique" UNIQUE("id","user_id")');
    expect(migration).toContain('CONSTRAINT "l3_recommendation_items_run_owner_fk" FOREIGN KEY ("run_id","user_id")');
    expect(migration).toContain('CONSTRAINT "l3_recommendation_items_proposal_owner_fk" FOREIGN KEY ("accepted_proposal_id","user_id")');
    expect(migration).toContain('CREATE POLICY "l3_recommendation_items_own_all"');
    expect(hardeningMigration).toContain('DROP CONSTRAINT "l3_recommendation_items_proposal_owner_fk"');
    expect(hardeningMigration).toContain('ON DELETE no action');
  });
});
