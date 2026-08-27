/**
 * Coverage for the repository methods added by the frontend rebuild series:
 * review queue/leeches/timeline/heatmap reads, session lifecycle helpers,
 * and the note list read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool({ recordTxControl: false });
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  resetPool: vi.fn(),
  checkPoolHealth: vi.fn(),
}));

import { createRepositories } from "@/index";

beforeEach(() => mock.reset());

function dueCardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
    state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
    desired_retention: 0.9, due_at: "2026-01-01T00:00:00Z", last_reviewed_at: null,
    last_rating: "good", review_count: 3, lapse_count: 0, again_count: 0,
    hard_count: 0, good_count: 3, easy_count: 0, interval_days: 7,
    scheduler_payload: {},
    slug: "abound", title: "Abound", lemma: "abound", w_id: "w-9",
    short_definition: "exist in large numbers", ipa: null, pos: "verb", cefr: "C1",
    ...overrides,
  };
}

describe("ReviewRepository 鈥?rebuild read methods", () => {
  it("findDueCards splits progress and word columns (H3 prefixed join)", async () => {
    mock.setRows([dueCardRow()]);
    const repos = createRepositories();

    const cards = await repos.reviews.findDueCards("u1", "wb1", 10);

    expect(cards).toHaveLength(1);
    expect(cards[0].word).toEqual({
      id: "w-9", slug: "abound", title: "Abound", lemma: "abound",
      short_definition: "exist in large numbers", ipa: null, pos: "verb", cefr: "C1",
    });
    expect(cards[0].progress.id).toBe("p1");
    expect(cards[0].progress).not.toHaveProperty("slug");
    expect(cards[0].progress).not.toHaveProperty("w_id");

    const q = mock.lastQuery!;
    expect(q.text).toContain("state != 'suspended'");
    expect(q.text).toContain("due_at IS NULL OR uwp.due_at <= now()");
    expect(q.text).toContain("NULLS FIRST");
    expect(q.params).toEqual(["u1", "wb1", 10]);
  });

  it("findDueCards maps an empty queue without error", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await expect(repos.reviews.findDueCards("u1", "wb1", 10)).resolves.toEqual([]);
  });

  it("findLeeches filters lapse_count >= LEECH_LAPSE_THRESHOLD ordered by worst first", async () => {
    mock.setRows([dueCardRow({ id: "p2", lapse_count: 9 })]);
    const repos = createRepositories();

    const leeches = await repos.reviews.findLeeches!("u1", "wb1", 5);

    // raw joined rows are returned; the service maps them
    expect(leeches[0]).toMatchObject({ id: "p2", lapse_count: 9, slug: "abound", w_id: "w-9" });
    const q = mock.lastQuery!;
    // 统一漏词阈值：与域实体共用 LEECH_LAPSE_THRESHOLD（项目决策 = 2）
    expect(q.text).toContain("uwp.lapse_count >= $4");
    expect(q.text).toContain("ORDER BY uwp.lapse_count DESC");
    expect(q.params).toEqual(["u1", "wb1", 5, 2]);
  });

  it("getTimeline joins review logs with word slugs newest first", async () => {
    const row = { id: "rl1", rating: "good", created_at: "2026-08-01T00:00:00Z", word_slug: "abound", word_lemma: "abound" };
    mock.setRows([row]);
    const repos = createRepositories();

    const timeline = await repos.reviews.getTimeline!("u1", "wb1", 50);

    expect(timeline).toEqual([row]);
    const q = mock.lastQuery!;
    expect(q.text).toContain("FROM review_logs rl");
    expect(q.text).toContain("JOIN words w ON w.id = rl.word_id");
    // 统一口径：时间线时间字段为 reviewed_at（响应仍以 created_at 字段名暴露）
    expect(q.text).toContain("rl.reviewed_at AS created_at");
    expect(q.text).toContain("ORDER BY rl.reviewed_at DESC");
    // 过滤非评分动作（skip/suspend/undo 的 rating=NULL），避免 "null" 徽标
    expect(q.text).toContain("rl.rating IS NOT NULL");
    expect(q.params).toEqual(["u1", "wb1", 50]);
  });

  it("getHeatmap aggregates per-day counts as text", async () => {
    mock.setRows([{ date: "2026-08-01", count: "7" }]);
    const repos = createRepositories();

    const heatmap = await repos.reviews.getHeatmap!("u1", "wb1", 365);

    expect(heatmap).toEqual([{ date: "2026-08-01", count: "7" }]);
    const q = mock.lastQuery!;
    // 统一口径：按显示时区(Asia/Shanghai)切日分组，时间字段用 reviewed_at
    expect(q.text).toContain("(rl.reviewed_at AT TIME ZONE 'Asia/Shanghai')::date::text AS date");
    expect(q.text).toContain("COUNT(*)::text AS count");
    expect(q.text).toContain("GROUP BY (rl.reviewed_at AT TIME ZONE 'Asia/Shanghai')::date");
    expect(q.params).toEqual(["u1", "wb1", 365]);
  });

  it("getStats uses the display-timezone day boundary and parses counts", async () => {
    const repos = createRepositories();

    mock.setRows([{ today_count: "3", total_count: "30", again_count: "1", hard_count: "2", good_count: "5", easy_count: "2" }]);
    await expect(repos.reviews.getStats!("u1", "wb1")).resolves.toEqual({
      todayCount: 3, totalCount: 30,
      ratingDist: { again: 1, hard: 2, good: 5, easy: 2 },
    });

    // 统一口径：today 边界来自显示时区(Asia/Shanghai)当日零点，时间字段为 reviewed_at。
    // 上海零点 = 前一日 16:00 UTC（Asia/Shanghai = UTC+8）。
    const q = mock.lastQuery!;
    expect(q.text).toContain("rl.reviewed_at >= $3");
    expect(q.text).not.toContain("rl.created_at");
    expect(typeof q.params[2]).toBe("string");
    expect(q.params[2]).toMatch(/^\d{4}-\d{2}-\d{2}T16:00:00\.000Z$/);

    mock.setRows([]);
    await expect(repos.reviews.getStats!("u1", "wb1")).resolves.toEqual({
      todayCount: 0, totalCount: 0,
      ratingDist: { again: 0, hard: 0, good: 0, easy: 0 },
    });
  });

  it("findProgressForUpdate locks one row inside a transaction", async () => {
    const mockTx = { query: mock.pool.query } as never;
    const txRepos = createRepositories(mockTx);

    mock.setRows([dueCardRow()]);
    const progress = await txRepos.reviews.findProgressForUpdate("p1", "u1");
    expect(progress).toMatchObject({ id: "p1", user_id: "u1" });
    expect(mock.lastQuery!.text).toContain("FOR UPDATE OF uwp");

    mock.setRows([]);
    await expect(txRepos.reviews.findProgressForUpdate("p1", "u1")).resolves.toBeNull();
  });

  it("findReviewLogWordbookForUndo returns the wordbook or null", async () => {
    const mockTx = { query: mock.pool.query } as never;
    const txRepos = createRepositories(mockTx);

    mock.setRows([{ wordbook_id: "wb1" }]);
    await expect(txRepos.reviews.findReviewLogWordbookForUndo("rl1", "u1")).resolves.toBe("wb1");

    mock.setRows([]);
    await expect(txRepos.reviews.findReviewLogWordbookForUndo("rl1", "u1")).resolves.toBeNull();
  });

  it("undoReviewLog maps RPC absence, failure, and error-message fallbacks", async () => {
    const mockTx = { query: mock.pool.query } as never;
    const txRepos = createRepositories(mockTx);

    mock.setRows([]);
    await expect(txRepos.reviews.undoReviewLog("rl1", "u1", "wb1", "s1", null)).resolves.toEqual({
      success: false, progressId: null, wordId: null, errorMessage: "RPC returned no result",
    });

    mock.setRows([{ out_success: false, out_progress_id: "p1", out_word_id: "w1", out_error_message: "stale" }]);
    await expect(txRepos.reviews.undoReviewLog("rl1", "u1", "wb1", "s1", null)).resolves.toEqual({
      success: false, progressId: "p1", wordId: "w1", errorMessage: "stale",
    });

    mock.setRows([{ out_success: false, out_progress_id: null, out_word_id: null, out_error_message: null }]);
    await expect(txRepos.reviews.undoReviewLog("rl1", "u1", "wb1", "s1", null)).resolves.toMatchObject({
      errorMessage: "Undo failed",
    });
  });
});

describe("SessionRepository 鈥?lifecycle helpers", () => {
  const sessionRow = {
    id: "s1", user_id: "u1", wordbook_id: "wb1", mode: "cram",
    cards_seen: 2, started_at: "2026-08-16T00:00:00Z", ended_at: null,
  };

  it("getOrCreateToday passes mode and the display-timezone day boundary", async () => {
    mock.setRows([sessionRow]);
    const repos = createRepositories();

    await expect(repos.sessions.getOrCreateToday("00000000-0000-4000-8000-000000000001", "wb1", "cram")).resolves.toEqual(sessionRow);
    const q = mock.lastQuery!;
    expect(q.text).toContain("get_or_create_today_session($1::uuid, $2::uuid, $3, $4::timestamptz)");
    expect(q.params[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(q.params[2]).toBe("cram");
    expect(typeof q.params[3]).toBe("string");
  });

  it("getOrCreateToday fails closed when the RPC returns no row", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await expect(repos.sessions.getOrCreateToday("00000000-0000-4000-8000-000000000001", "wb1")).rejects.toThrow("session get-or-create returned no row");
  });

  it("create inserts a session row and fails closed on empty result", async () => {
    mock.setRows([sessionRow]);
    const repos = createRepositories();
    await expect(repos.sessions.create!("u1", "wb1", "cram")).resolves.toEqual(sessionRow);
    expect(mock.lastQuery!.text).toContain("INSERT INTO sessions (user_id, wordbook_id, mode)");
    expect(mock.lastQuery!.params).toEqual(["u1", "wb1", "cram"]);

    mock.setRows([]);
    await expect(repos.sessions.create!("u1", "wb1")).rejects.toThrow("session create returned no row");
  });

  it("assertActiveOwned locks an active owned session and rejects foreign/ended ones", async () => {
    const mockTx = { query: mock.pool.query } as never;
    const txRepos = createRepositories(mockTx);

    mock.setRows([{ id: "s1" }]);
    await expect(txRepos.sessions.assertActiveOwned("s1", "u1", "wb1")).resolves.toBeUndefined();
    const q = mock.lastQuery!;
    expect(q.text).toContain("ended_at IS NULL");
    expect(q.text).toContain("FOR UPDATE");
    expect(q.params).toEqual(["s1", "u1", "wb1"]);

    mock.setRows([]);
    await expect(txRepos.sessions.assertActiveOwned("s1", "u1", "wb1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("incrementCardsSeenFromOutbox bumps cards_seen inside the transaction", async () => {
    const mockTx = { query: mock.pool.query } as never;
    const txRepos = createRepositories(mockTx);

    mock.setRows([{ id: "s1" }]);
    await expect(txRepos.sessions.incrementCardsSeenFromOutbox("s1", "u1", "wb1")).resolves.toBeUndefined();
    expect(mock.lastQuery!.text).toContain("cards_seen = cards_seen + 1");
    expect(mock.lastQuery!.text).not.toContain("increment_session_cards_seen");

    mock.setRows([]);
    await expect(txRepos.sessions.incrementCardsSeenFromOutbox("s1", "u1", "wb1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("NoteRepository 鈥?listByUser", () => {
  it("lists a user's notes joined with word slugs, newest first", async () => {
    const row = {
      id: "n1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      content_md: "note", version: 2,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
      word_slug: "abound", word_lemma: "abound", word_title: "Abound",
    };
    mock.setRows([row]);
    const repos = createRepositories();

    const notes = await repos.notes.listByUser!("u1", 50, 10);

    expect(notes).toEqual([row]);
    const q = mock.lastQuery!;
    expect(q.text).toContain("JOIN words w ON w.id = n.word_id");
    expect(q.text).toContain("WHERE n.user_id = $1");
    expect(q.text).toContain("ORDER BY n.updated_at DESC");
    expect(q.text).toContain("LIMIT $2 OFFSET $3");
    expect(q.params).toEqual(["u1", 50, 10]);
  });

  it("upsert fails closed when the CTE returns no row", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await expect(repos.notes.upsert("u1", "w1", "wb1", "content")).rejects.toThrow("note upsert returned no row");
  });
});

