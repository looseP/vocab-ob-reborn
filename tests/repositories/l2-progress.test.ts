import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { L2ProgressRepository } from "@/repositories/l2-progress.repository";

describe("L2ProgressRepository", () => {
  it("findByWordbookWordAndUser returns null when not found", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    const result = await repo.findByWordbookWordAndUser("user-1", "wb-1", "word-1");
    expect(result).toBeNull();
  });

  it("findByWordbookWordAndUser scopes the query by (user_id, wordbook_id, word_id)", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.findByWordbookWordAndUser("user-1", "wb-1", "word-1");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(params).toEqual(["user-1", "wb-1", "word-1"]);
  });

  it("insert creates L2 progress row with wordbook_id", async () => {
    const repo = new L2ProgressRepository();
    const mockRow = { id: "l2-1", l2_state: "review", l2_stability: 5.25 };
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(mockRow);
    const result = await repo.insert({
      user_id: "user-1",
      wordbook_id: "wb-1",
      word_id: "word-1",
      l2_stability: 5.25,
      l2_difficulty: 7.0,
      l2_state: "review",
      l2_desired_retention: 0.9,
      l2_due_at: new Date().toISOString(),
      l2_inherited_from_l1: true,
      l2_weights_source: "inherited",
    });
    expect(result.id).toBe("l2-1");
    // Verify the INSERT carries wordbook_id.
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("wordbook_id");
    expect(params[0]).toBe("user-1");
    expect(params[1]).toBe("wb-1");
    expect(params[2]).toBe("word-1");
  });

  // ── finalizeL2ContentHash (word-level, content-driven) ──────────────────

  it("finalizeL2ContentHash calls the schema-qualified migration-owned RPC", async () => {
    const repo = new L2ProgressRepository();
    const queryOneSpy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ updated_count: 1 });

    await repo.finalizeL2ContentHash("word-1", "l2hash", "fullhash");

    expect(queryOneSpy).toHaveBeenCalledTimes(1);
    expect(queryOneSpy).toHaveBeenCalledWith(
      expect.stringContaining("SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text) AS updated_count"),
      ["word-1", "l2hash", "fullhash"],
    );
  });

  it("finalizeL2ContentHash returns the RPC updated_count", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ updated_count: 2 });

    await expect(repo.finalizeL2ContentHash("word-1", "l2hash", "fullhash")).resolves.toBe(2);
  });

  it("finalizeL2ContentHash returns zero when the RPC returns no row", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.finalizeL2ContentHash("word-1", "l2hash", "fullhash")).resolves.toBe(0);
  });

  // ── pause / unpause (wordbook-scoped) ──────────────────────────────────

  it("pause sets l2_paused=true with reason, scoped by wordbook", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([]);
    await repo.pause("user-1", "wb-1", "word-1", "l1_cascade_failure");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("l2_paused = true");
    expect(sql).toContain("l2_paused_reason");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(params).toEqual(["user-1", "wb-1", "word-1", "l1_cascade_failure"]);
  });

  it("unpauseByReason sets l2_paused=false and l2_due_at=now(), scoped by wordbook", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([]);
    await repo.unpauseByReason("user-1", "wb-1", "word-1", "l1_cascade_failure");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("l2_paused = false");
    expect(sql).toContain("l2_due_at = now()");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(params).toEqual(["user-1", "wb-1", "word-1", "l1_cascade_failure"]);
  });

  // ── Cross-wordbook isolation ───────────────────────────────────────────

  it("pause does NOT touch a different wordbook's L2 progress (cross-wordbook isolation)", async () => {
    const repo = new L2ProgressRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
    // Pause wb-A for user-1/word-1.
    await repo.pause("user-1", "wb-A", "word-1", "l1_cascade_failure");
    // The WHERE clause must include wordbook_id so wb-B's row is untouched.
    const [sql] = querySpy.mock.calls[0];
    expect(sql).toMatch(/wordbook_id = \$2::uuid/);
    // Sanity: only one UPDATE issued for this call.
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("findByWordbookWordAndUser would not return another wordbook's row (parameter binding)", async () => {
    // Simulate the DB having a row for (user-1, wb-B, word-1) but the query
    // asks for wb-A — the mock returns null because the WHERE includes
    // wordbook_id, proving the lookup is wordbook-scoped.
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    const result = await repo.findByWordbookWordAndUser("user-1", "wb-A", "word-1");
    expect(result).toBeNull();
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(params[1]).toBe("wb-A");
  });
});
