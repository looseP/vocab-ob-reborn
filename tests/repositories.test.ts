import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool, type MockQueryCall } from "./helpers/mock-db";

// Mock the connection BEFORE importing repositories
const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";
import type { AnnotationRow, HighlightRow, NoteRow, ReviewRating, WordRow, WordSummary } from "@/domain";

beforeEach(() => mock.reset());

describe("AnnotationRepository", () => {
  it("findByWord queries by user+wordbook+word", async () => {
    const expected: AnnotationRow = {
      id: "a1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      content: "test note", updated_at: "2026-01-01T00:00:00Z",
    };
    mock.setRows([expected]);
    const repos = createRepositories();
    const result = await repos.annotations.findByWord("u1", "wb1", "w1");

    expect(result).toEqual(expected);
    const last = mock.lastQuery!;
    expect(last.text).toContain("FROM word_annotations");
    expect(last.text).toContain("user_id = $1");
    expect(last.text).toContain("wordbook_id = $2");
    expect(last.text).toContain("word_id = $3");
    expect(last.params).toEqual(["u1", "wb1", "w1"]);
  });

  it("upsert uses ON CONFLICT", async () => {
    mock.setRows([{ id: "a1" }]);
    const repos = createRepositories();
    await repos.annotations.upsert("u1", "w1", "wb1", "content");

    expect(mock.lastQuery!.text).toContain("ON CONFLICT");
    expect(mock.lastQuery!.text).toContain("DO UPDATE SET content");
  });

  it("delete removes by id+user+wordbook", async () => {
    const repos = createRepositories();
    await repos.annotations.delete("u1", "wb1", "a1");

    expect(mock.lastQuery!.text).toContain("DELETE FROM word_annotations");
    expect(mock.lastQuery!.text).toContain("id = $1");
    expect(mock.lastQuery!.text).toContain("user_id = $2");
  });
});

describe("HighlightRepository", () => {
  it("findByWords uses ANY() array", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await repos.highlights.findByWords("u1", "wb1", ["w1", "w2"]);

    expect(mock.lastQuery!.text).toContain("word_id = ANY($3::uuid[])");
    expect(mock.lastQuery!.params).toEqual(["u1", "wb1", ["w1", "w2"]]);
  });

  it("findByWords returns empty for empty input", async () => {
    const repos = createRepositories();
    const result = await repos.highlights.findByWords("u1", "wb1", []);
    expect(result).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });

  it("create uses ON CONFLICT for color update", async () => {
    mock.setRows([{ id: "h1" }]);
    const repos = createRepositories();
    await repos.highlights.create("u1", "w1", "wb1", "field", "snippet", "#fff");

    expect(mock.lastQuery!.text).toContain("ON CONFLICT");
    expect(mock.lastQuery!.text).toContain("DO UPDATE SET color");
  });
});

describe("WordRepository", () => {
  it("findBySlug queries by slug", async () => {
    const word: Partial<WordRow> = { id: "1", slug: "aboard", lemma: "aboard" };
    mock.setRows([word]);
    const repos = createRepositories();
    const result = await repos.words.findBySlug("aboard");

    expect(result?.slug).toBe("aboard");
    expect(mock.lastQuery!.text).toContain("WHERE slug = $1");
    expect(mock.lastQuery!.text).toContain("is_deleted = false");
  });

  it("findPublic paginates and applies filters", async () => {
    // First query = count, second = data
    mock.setRowMap({
      "count(*)": [{ total: 42 }],
      "ORDER BY lemma": [
        { id: "1", slug: "aboard", lemma: "aboard" } as WordSummary,
      ],
    });
    const repos = createRepositories();
    const result = await repos.words.findPublic({
      filters: { q: "ab", freq: "基础词" },
      pagination: { limit: 10, offset: 0 },
    });

    expect(result.total).toBe(42);
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    // Verify both queries ran
    expect(mock.calls.length).toBe(2);
    // Verify search filter applied
    expect(mock.calls[0].text).toContain("websearch_to_tsquery");
    expect(mock.calls[0].text).toContain("word_freq");
  });

  it("count returns number", async () => {
    mock.setRows([{ count: "6767" }]);
    const repos = createRepositories();
    const count = await repos.words.count();
    expect(count).toBe(6767);
  });
});

describe("NoteRepository", () => {
  it("findByWord returns null when not found", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    const result = await repos.notes.findByWord("u1", "wb1", "w1");
    expect(result).toBeNull();
  });

  it("upsert inserts revision when content changed", async () => {
    // First call: findByWord (existing note with different content)
    // Second call: upsert
    // Third call: revision insert
    mock.setRowMap({
      "FROM notes": [{ id: "n1", content_md: "old", version: 1 } as NoteRow],
      "INSERT INTO notes": [{ id: "n1", content_md: "new", version: 2 } as NoteRow],
      "INSERT INTO note_revisions": [],
    });
    const repos = createRepositories();
    const result = await repos.notes.upsert("u1", "w1", "wb1", "new");

    expect(result.note.version).toBe(2);
    expect(result.created).toBe(false);
    // 3 queries: find + upsert + revision
    expect(mock.calls.length).toBe(3);
  });
});

describe("WordbookRepository", () => {
  it("getOrCreateDefault returns existing", async () => {
    mock.setRows([{ id: "wb1", name: "Global", is_default: true }]);
    const repos = createRepositories();
    const result = await repos.wordbooks.getOrCreateDefault("u1");
    expect(result.id).toBe("wb1");
    // Only the find query, no insert
    expect(mock.calls.length).toBe(1);
  });

  it("addWords uses ON CONFLICT DO NOTHING", async () => {
    const repos = createRepositories();
    await repos.wordbooks.addWords("wb1", ["w1", "w2"]);
    expect(mock.lastQuery!.text).toContain("ON CONFLICT DO NOTHING");
    expect(mock.lastQuery!.params).toEqual(["wb1", "w1", "w2"]);
  });
});

describe("SessionRepository", () => {
  it("getOrCreateToday returns existing if started today", async () => {
    const todayIso = new Date();
    todayIso.setUTCHours(0, 0, 0, 0);
    mock.setRows([{
      id: "s1", started_at: todayIso.toISOString(), ended_at: null,
    }]);
    const repos = createRepositories();
    const result = await repos.sessions.getOrCreateToday("u1", "wb1");
    expect(result.id).toBe("s1");
    // Only the find query — no create
    expect(mock.calls.length).toBe(1);
  });

  it("incrementCardsSeen calls RPC", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await repos.sessions.incrementCardsSeen("s1");
    expect(mock.lastQuery!.text).toContain("increment_session_cards_seen");
  });
});

describe("StatsRepository", () => {
  it("getDashboardSummary aggregates 8 queries", async () => {
    // All count queries return 5
    mock.setRows([{ count: "5" }]);
    const repos = createRepositories();
    const result = await repos.stats.getDashboardSummary("u1", "wb1");

    expect(result.totalWords).toBe(5);
    expect(result.trackedWords).toBe(5);
    expect(result.dueToday).toBe(5);
    expect(result.reviewedToday).toBe(5);
    // 7 parallel queries + 1 streak query
    expect(mock.calls.length).toBe(8);
  });

  it("getRatingDistribution groups by rating", async () => {
    mock.setRows([
      { rating: "again", count: "3" },
      { rating: "good", count: "7" },
    ]);
    const repos = createRepositories();
    const dist = await repos.stats.getRatingDistribution("u1", "wb1");

    expect(dist.again).toBe(3);
    expect(dist.good).toBe(7);
    expect(dist.hard).toBe(0);
    expect(dist.easy).toBe(0);
  });
});

describe("ReviewRepository", () => {
  // H4 fix: transactional methods require a tx — create a mock tx
  const mockTx = { query: mock.pool.query } as never;
  const txRepos = createRepositories(mockTx);

  it("checkIdempotency acquires advisory lock", async () => {
    mock.setRows([]); // no existing log
    const result = await txRepos.reviews.checkIdempotency("key-123");

    expect(result).toBeNull();
    // First query = advisory lock, second = SELECT review_logs
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].text).toContain("pg_advisory_xact_lock");
    expect(mock.calls[1].text).toContain("idempotency_key = $1");
  });

  it("checkIdempotency returns existing log id", async () => {
    mock.setRows([{ id: "log-123" }]);
    const result = await txRepos.reviews.checkIdempotency("key-123");
    expect(result).toBe("log-123");
  });

  it("checkIdempotency throws when not in transaction (H4 fix)", async () => {
    const repos = createRepositories(); // no tx
    await expect(repos.reviews.checkIdempotency("key")).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
  });

  it("findProgressForUpdate uses FOR UPDATE and JOINs words", async () => {
    mock.setRows([]);
    await txRepos.reviews.findProgressForUpdate("p1");

    expect(mock.lastQuery!.text).toContain("FOR UPDATE");
    expect(mock.lastQuery!.text).toContain("JOIN words w");
    // M7 fix: verify word slug/title/lemma are selected
    expect(mock.lastQuery!.text).toContain("word_slug");
    expect(mock.lastQuery!.text).toContain("word_title");
    expect(mock.lastQuery!.text).toContain("word_lemma");
  });

  it("findProgressForUpdate throws when not in transaction (H4 fix)", async () => {
    const repos = createRepositories();
    await expect(repos.reviews.findProgressForUpdate("p1")).rejects.toMatchObject({
      code: "BUSINESS_RULE",
    });
  });

  it("markStaleForRecheck updates hash, needs_recheck, and returns count", async () => {
    mock.setRows([{ id: "p1" }, { id: "p2" }]);
    const repos = createRepositories();
    const count = await repos.reviews.markStaleForRecheck("w1", "newhash");

    expect(count).toBe(2);
    expect(mock.lastQuery!.text).toContain("content_hash_snapshot = $1");
    // B fix: needs_recheck is now set
    expect(mock.lastQuery!.text).toContain("needs_recheck = true");
    expect(mock.lastQuery!.params).toEqual(["newhash", "w1"]);
  });

  it("findDueCards joins words and orders by due_at", async () => {
    mock.setRows([{
      id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
      desired_retention: 0.9, due_at: "2026-01-01", last_reviewed_at: "2025-12-31",
      last_rating: "good", review_count: 3, lapse_count: 0,
      again_count: 0, hard_count: 0, good_count: 3, easy_count: 0,
      interval_days: 7, scheduler_payload: {}, content_hash_snapshot: null,
      skip_count: 0, created_at: "2025-01-01", updated_at: "2025-12-31",
      slug: "aboard", title: "aboard", lemma: "aboard", w_id: "w1",
    }]);
    const repos = createRepositories();
    const cards = await repos.reviews.findDueCards("u1", "wb1", 10);

    expect(cards).toHaveLength(1);
    expect(cards[0].word.slug).toBe("aboard");
    expect(cards[0].progress.state).toBe("review");
    expect(mock.lastQuery!.text).toContain("JOIN words w");
    expect(mock.lastQuery!.text).toContain("ORDER BY uwp.due_at");
  });

  it("findStaleCards queries content_hash drift", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await repos.reviews.findStaleCards("w1");

    expect(mock.lastQuery!.text).toContain("content_hash_snapshot IS NOT NULL");
    expect(mock.lastQuery!.text).toContain("content_hash_snapshot != ");
  });

  it("saveAnswer runs UPDATE then INSERT", async () => {
    mock.setRows([{ id: "log-1" }]);
    const result = await txRepos.reviews.saveAnswer({
      progressId: "p1",
      userId: "u1",
      wordId: "w1",
      wordbookId: "wb1",
      sessionId: "s1",
      rating: "good",
      contentHash: "hash123",
      scheduling: {
        difficulty: 0.3, dueAt: "2026-01-08", logDueAt: "2026-01-08",
        elapsedDays: 7, scheduledDays: 7, retrievability: 0.9,
        stability: 1.5, state: "review", nextPayload: { test: true },
      },
      idempotencyKey: "key-1",
      previousSnapshot: { old: true },
      logMetadata: { progress_id: "p1" },
    });

    expect(result.reviewLogId).toBe("log-1");
    // 2 queries: UPDATE + INSERT
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].text).toContain("UPDATE user_word_progress");
    expect(mock.calls[1].text).toContain("INSERT INTO review_logs");
    expect(mock.calls[1].text).toContain("idempotency_key");
  });
});

describe("StatsRepository (extended)", () => {
  // M5 fix: streak uses dayKeyInDisplayTz (Asia/Shanghai), not UTC.
  // Helper: build reviewed_at timestamps that fall on consecutive display-tz days.
  function buildConsecutiveReviewDates(count: number): { reviewed_at: string }[] {
    const days: { reviewed_at: string }[] = [];
    for (let i = 0; i < count; i++) {
      // Use noon Shanghai time (= 04:00 UTC) to avoid midnight boundary issues
      const d = new Date();
      d.setHours(12, 0, 0, 0); // local ≈ Shanghai noon
      d.setDate(d.getDate() - i);
      days.push({ reviewed_at: d.toISOString() });
    }
    return days;
  }

  it("calculateStreak counts consecutive days", async () => {
    mock.setRows(buildConsecutiveReviewDates(5));
    const repos = createRepositories();
    const summary = await repos.stats.getDashboardSummary("u1", "wb1");
    expect(summary.streakDays).toBe(5);
  });

  it("calculateStreak returns 0 for no reviews", async () => {
    // count queries return 0, streak query returns empty
    mock.setRowMap({
      "count(*)": [{ count: "0" }],
      "reviewed_at": [],
    });
    const repos = createRepositories();
    const summary = await repos.stats.getDashboardSummary("u1", "wb1");
    expect(summary.streakDays).toBe(0);
  });

  it("getRatingDistribution covers all 4 ratings", async () => {
    mock.setRows([
      { rating: "again", count: "3" },
      { rating: "hard", count: "2" },
      { rating: "good", count: "7" },
      { rating: "easy", count: "1" },
    ]);
    const repos = createRepositories();
    const dist = await repos.stats.getRatingDistribution("u1", "wb1");

    expect(dist).toEqual({ again: 3, hard: 2, good: 7, easy: 1 });
  });

  it("getRatingDistribution handles empty results", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    const dist = await repos.stats.getRatingDistribution("u1", "wb1");
    expect(dist).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
  });

  it("calculateStreak breaks on gap", async () => {
    // Day 0 and day 2, but NOT day 1 — streak should break at 1
    const day0 = new Date();
    day0.setHours(12, 0, 0, 0); // today noon
    const day2 = new Date();
    day2.setHours(12, 0, 0, 0);
    day2.setDate(day2.getDate() - 2);
    mock.setRows([
      { reviewed_at: day0.toISOString() },
      { reviewed_at: day2.toISOString() },
    ]);
    const repos = createRepositories();
    const summary = await repos.stats.getDashboardSummary("u1", "wb1");
    expect(summary.streakDays).toBe(1);
  });
});

describe("WordbookRepository (extended)", () => {
  it("findById queries by id", async () => {
    mock.setRows([{ id: "wb1", name: "Global" }]);
    const repos = createRepositories();
    const result = await repos.wordbooks.findById("wb1");
    expect(result?.id).toBe("wb1");
    expect(mock.lastQuery!.text).toContain("WHERE id = $1::uuid");
  });

  it("findAllByUser returns array", async () => {
    mock.setRows([{ id: "wb1" }, { id: "wb2" }]);
    const repos = createRepositories();
    const result = await repos.wordbooks.findAllByUser("u1");
    expect(result).toHaveLength(2);
    expect(mock.lastQuery!.text).toContain("WHERE user_id = $1");
  });

  it("create inserts and returns row", async () => {
    mock.setRows([{ id: "wb1", name: "Test" }]);
    const repos = createRepositories();
    const result = await repos.wordbooks.create("u1", "Test", false);
    expect(result.id).toBe("wb1");
    expect(mock.lastQuery!.text).toContain("INSERT INTO wordbooks");
  });

  it("getOrCreateDefault creates when none exists", async () => {
    // First call: findDefaultByUser returns empty
    // Second call: create returns the new wordbook
    mock.setRowMap({
      "is_default = true": [],
      "INSERT INTO wordbooks": [{ id: "wb-new", name: "Global", is_default: true }],
    });
    const repos = createRepositories();
    const result = await repos.wordbooks.getOrCreateDefault("u1");
    expect(result.id).toBe("wb-new");
    expect(mock.calls.length).toBe(2);
  });

  it("countWords returns number", async () => {
    mock.setRows([{ count: "42" }]);
    const repos = createRepositories();
    const count = await repos.wordbooks.countWords("wb1");
    expect(count).toBe(42);
  });

  it("getWordIds returns array of ids", async () => {
    mock.setRows([{ word_id: "w1" }, { word_id: "w2" }]);
    const repos = createRepositories();
    const ids = await repos.wordbooks.getWordIds("wb1");
    expect(ids).toEqual(["w1", "w2"]);
  });

  it("addWords skips empty input", async () => {
    const repos = createRepositories();
    await repos.wordbooks.addWords("wb1", []);
    expect(mock.calls.length).toBe(0);
  });
});

describe("SessionRepository (extended)", () => {
  it("findActiveByUser queries active session", async () => {
    mock.setRows([{ id: "s1", ended_at: null }]);
    const repos = createRepositories();
    const result = await repos.sessions.findActiveByUser("u1", "wb1");
    expect(result?.id).toBe("s1");
    expect(mock.lastQuery!.text).toContain("ended_at IS NULL");
  });

  it("create inserts new session", async () => {
    mock.setRows([{ id: "s1", mode: "review" }]);
    const repos = createRepositories();
    const result = await repos.sessions.create("u1", "wb1", "review");
    expect(result.id).toBe("s1");
    expect(mock.lastQuery!.text).toContain("INSERT INTO sessions");
  });

  it("endSession updates ended_at", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await repos.sessions.endSession("s1");
    expect(mock.lastQuery!.text).toContain("SET ended_at = now()");
  });

  it("getOrCreateToday creates new when old session expired", async () => {
    // Existing session started yesterday
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    mock.setRowMap({
      "ORDER BY started_at": [{ id: "s-old", started_at: yesterday.toISOString(), ended_at: null }],
      "INSERT INTO sessions": [{ id: "s-new", started_at: new Date().toISOString(), ended_at: null }],
    });
    const repos = createRepositories();
    const result = await repos.sessions.getOrCreateToday("u1", "wb1");
    expect(result.id).toBe("s-new");
    // find + create + end old = 3 queries
    expect(mock.calls.length).toBe(3);
  });
});

describe("NoteRepository (extended)", () => {
  it("findRevisions queries by word", async () => {
    mock.setRows([{ id: "r1", version: 2 }]);
    const repos = createRepositories();
    const result = await repos.notes.findRevisions("u1", "w1", "wb1");
    expect(result).toHaveLength(1);
    expect(mock.lastQuery!.text).toContain("FROM note_revisions");
    expect(mock.lastQuery!.text).toContain("ORDER BY nr.version DESC");
  });

  it("upsert does not insert revision when content unchanged", async () => {
    mock.setRowMap({
      "FROM notes": [{ id: "n1", content_md: "same", version: 1 }],
      "INSERT INTO notes": [{ id: "n1", content_md: "same", version: 1 }],
    });
    const repos = createRepositories();
    const result = await repos.notes.upsert("u1", "w1", "wb1", "same");
    expect(result.note.version).toBe(1);
    // find + upsert only, no revision insert
    expect(mock.calls.length).toBe(2);
  });
});

describe("createRepositories factory", () => {
  it("returns all 8 repositories", () => {
    const repos = createRepositories();
    expect(repos.words).toBeDefined();
    expect(repos.reviews).toBeDefined();
    expect(repos.notes).toBeDefined();
    expect(repos.wordbooks).toBeDefined();
    expect(repos.highlights).toBeDefined();
    expect(repos.annotations).toBeDefined();
    expect(repos.sessions).toBeDefined();
    expect(repos.stats).toBeDefined();
  });

  it("repositories share the same tx when provided", () => {
    const fakeTx = { query: vi.fn() } as unknown;
    const repos = createRepositories(fakeTx as never);
    expect(repos.words).toBeDefined();
  });
});

// ── H5: skip/suspend/undo tests ─────────────────────────────────────────
describe("ReviewRepository — skip/suspend/undo (H5 fix)", () => {
  const mockTx = { query: mock.pool.query } as never;
  const txRepos = createRepositories(mockTx);

  it("findProgressForSkip uses FOR UPDATE", async () => {
    mock.setRows([]);
    await txRepos.reviews.findProgressForSkip("p1", "u1");
    expect(mock.lastQuery!.text).toContain("FOR UPDATE");
    expect(mock.lastQuery!.text).toContain("user_id = $2");
  });

  it("findProgressForSkip throws without tx (H4)", async () => {
    const repos = createRepositories();
    await expect(repos.reviews.findProgressForSkip("p1", "u1"))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("skipCard updates skip_count and inserts log with action=skip", async () => {
    mock.setRows([{ id: "log-1" }]);
    const progress = { id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 3 };
    const result = await txRepos.reviews.skipCard(progress, "u1", "s1", "key-skip");

    expect(result.reviewLogId).toBe("log-1");
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].text).toContain("skip_count = skip_count + 1");
    expect(mock.calls[1].text).toContain("INSERT INTO review_logs");
    // Verify action metadata is skip
    expect(mock.calls[1].params).toContain(JSON.stringify({ action: "skip" }));
  });

  it("skipCard throws without tx (H4)", async () => {
    const repos = createRepositories();
    const progress = { id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 0 };
    await expect(repos.reviews.skipCard(progress, "u1", "s1", null))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("findProgressForSuspend uses FOR UPDATE", async () => {
    mock.setRows([]);
    await txRepos.reviews.findProgressForSuspend("p1", "u1");
    expect(mock.lastQuery!.text).toContain("FOR UPDATE");
  });

  it("suspendCard sets state=suspended and inserts log", async () => {
    mock.setRows([{ id: "log-2" }]);
    const progress = { id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 0 };
    const result = await txRepos.reviews.suspendCard(progress, "u1", null, "key-suspend");

    expect(result.reviewLogId).toBe("log-2");
    expect(mock.calls[0].text).toContain("state = 'suspended'");
    expect(mock.calls[1].text).toContain("INSERT INTO review_logs");
    expect(mock.calls[1].params).toContain(JSON.stringify({ action: "suspend" }));
  });

  it("suspendCard throws without tx (H4)", async () => {
    const repos = createRepositories();
    const progress = { id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 0 };
    await expect(repos.reviews.suspendCard(progress, "u1", null, null))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("undoReviewLog calls RPC and returns result", async () => {
    mock.setRows([{
      out_success: true,
      out_progress_id: "p1",
      out_word_id: "w1",
      out_error_message: null,
    }]);
    const result = await txRepos.reviews.undoReviewLog("log-1", "u1", "s1", null);

    expect(result.success).toBe(true);
    expect(result.progressId).toBe("p1");
    expect(result.wordId).toBe("w1");
    expect(mock.lastQuery!.text).toContain("undo_review_log");
  });

  it("undoReviewLog handles RPC failure", async () => {
    mock.setRows([{
      out_success: false,
      out_progress_id: null,
      out_word_id: null,
      out_error_message: "找不到日志",
    }]);
    const result = await txRepos.reviews.undoReviewLog("bad-id", "u1", "s1", null);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("找不到日志");
  });

  it("undoReviewLog inserts idempotency log after success", async () => {
    mock.setRows([{
      out_success: true,
      out_progress_id: "p1",
      out_word_id: "w1",
      out_error_message: null,
    }]);
    await txRepos.reviews.undoReviewLog("log-1", "u1", "s1", "undo-key");

    // 3 queries: RPC + SELECT progress (H-NEW-1 fix: fetch wordbook_id) + INSERT log
    expect(mock.calls.length).toBe(3);
    expect(mock.calls[1].text).toContain("SELECT wordbook_id");
    expect(mock.calls[2].text).toContain("INSERT INTO review_logs");
    expect(mock.calls[2].text).toContain("idempotency_key");
  });

  it("undoReviewLog throws without tx (H4)", async () => {
    const repos = createRepositories();
    await expect(repos.reviews.undoReviewLog("log-1", "u1", "s1", null))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });
});

// ── H2: counterField whitelist test ─────────────────────────────────────
describe("ReviewRepository — counterField whitelist (H2 fix)", () => {
  const mockTx = { query: mock.pool.query } as never;

  it("saveAnswer with valid rating uses correct counter column", async () => {
    mock.setRows([{ id: "log-1" }]);
    const repos = createRepositories(mockTx);
    await repos.reviews.saveAnswer({
      progressId: "p1", userId: "u1", wordId: "w1", wordbookId: "wb1",
      sessionId: "s1", rating: "again",
      contentHash: "hash123",
      scheduling: {
        difficulty: 0.5, dueAt: "2026-01-01", logDueAt: "2026-01-01",
        elapsedDays: 0, scheduledDays: 0, retrievability: 0.5,
        stability: 0.1, state: "learning", nextPayload: {},
      },
      idempotencyKey: null, previousSnapshot: {}, logMetadata: {},
    });
    // Verify "again_count = again_count + 1" is in the SQL (not injected)
    expect(mock.calls[0].text).toContain("again_count = again_count + 1");
  });

  it("saveAnswer with invalid rating throws ValidationError (H2 fix)", async () => {
    const repos = createRepositories(mockTx);
    await expect(repos.reviews.saveAnswer({
      progressId: "p1", userId: "u1", wordId: "w1", wordbookId: "wb1",
      sessionId: "s1",
      contentHash: "hash123",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rating: "malicious; DROP TABLE" as any,
      scheduling: {
        difficulty: 0, dueAt: "", logDueAt: null, elapsedDays: 0,
        scheduledDays: 0, retrievability: 0, stability: 0,
        state: "new", nextPayload: {},
      },
      idempotencyKey: null, previousSnapshot: {}, logMetadata: {},
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

// ── H3: findDueCards column prefix test ─────────────────────────────────
describe("ReviewRepository — findDueCards column prefix (H3 fix)", () => {
  it("findDueCards uses uwp. prefix to avoid ambiguous columns", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    await repos.reviews.findDueCards("u1", "wb1", 10);

    // H3 fix: all progress columns should have uwp. prefix
    expect(mock.lastQuery!.text).toContain("uwp.id");
    expect(mock.lastQuery!.text).toContain("uwp.user_id");
    expect(mock.lastQuery!.text).toContain("uwp.word_id");
    // w.id should be aliased as w_id
    expect(mock.lastQuery!.text).toContain("w.id AS w_id");
  });
});

// ── Task 5: markL1StaleForRecheck ──────────────────────────────────────
describe("markL1StaleForRecheck", () => {
  const mockTx = { query: mock.pool.query } as never;
  const txRepos = createRepositories(mockTx);

  it("updates l1_content_hash_snapshot and needs_recheck, returns count", async () => {
    mock.setRows([{ id: "p1" }]);
    const count = await txRepos.reviews.markL1StaleForRecheck("w1", "newl1hash");

    expect(count).toBe(1);
    expect(mock.lastQuery!.text).toContain("l1_content_hash_snapshot = $1");
    expect(mock.lastQuery!.text).toContain("needs_recheck = true");
    expect(mock.lastQuery!.text).toContain("due_at = now()");
    // state demotion: review -> relearning
    expect(mock.lastQuery!.text).toContain("WHEN state = 'review' THEN 'relearning'");
    expect(mock.lastQuery!.params).toEqual(["newl1hash", "w1"]);
  });

  it("returns 0 when no rows match", async () => {
    mock.setRows([]);
    const count = await txRepos.reviews.markL1StaleForRecheck("w1", "samehash");
    expect(count).toBe(0);
  });

  it("does NOT reference l2 tables or the full content_hash_snapshot", async () => {
    mock.setRows([]);
    await txRepos.reviews.markL1StaleForRecheck("w1", "newl1hash");

    expect(mock.lastQuery!.text).not.toContain("user_word_l2_progress");
    // The WHERE filter must key off the L1 snapshot, not the full one.
    // Use a word-boundary regex so "l1_content_hash_snapshot" is not a false
    // positive match for bare "content_hash_snapshot".
    expect(mock.lastQuery!.text).not.toMatch(/\bcontent_hash_snapshot\b/);
    expect(mock.lastQuery!.text).toMatch(/\bl1_content_hash_snapshot\b/);
  });

  it("keeps legacy markStaleForRecheck working (backward compat)", async () => {
    mock.setRows([{ id: "p1" }, { id: "p2" }]);
    const count = await txRepos.reviews.markStaleForRecheck("w1", "newhash");

    expect(count).toBe(2);
    // Legacy uses the full content_hash_snapshot column
    expect(mock.lastQuery!.text).toContain("content_hash_snapshot = $1");
    expect(mock.lastQuery!.text).not.toContain("l1_content_hash_snapshot");
  });
});

// ── Task 6: saveAnswer dual-track changes ──────────────────────────────
describe("saveAnswer dual-track changes", () => {
  const mockTx = { query: mock.pool.query } as never;
  const txRepos = createRepositories(mockTx);

  async function runSaveAnswer(rating: ReviewRating = "good") {
    mock.setRows([{ id: "log-1" }]);
    return txRepos.reviews.saveAnswer({
      progressId: "p1",
      userId: "u1",
      wordId: "w1",
      wordbookId: "wb1",
      sessionId: "s1",
      rating,
      contentHash: "hash123",
      scheduling: {
        difficulty: 0.3, dueAt: "2026-01-08", logDueAt: "2026-01-08",
        elapsedDays: 7, scheduledDays: 7, retrievability: 0.9,
        stability: 1.5, state: "review", nextPayload: { test: true },
      },
      idempotencyKey: "key-1",
      previousSnapshot: { old: true },
      logMetadata: { progress_id: "p1" },
    });
  }

  it("writes l1_content_hash_snapshot alongside content_hash_snapshot", async () => {
    await runSaveAnswer();
    const updateSql = mock.calls[0].text;

    expect(updateSql).toContain("content_hash_snapshot = $11");
    expect(updateSql).toContain("l1_content_hash_snapshot = $11");
  });

  it("updates recent_ratings (append + slice 5)", async () => {
    await runSaveAnswer();
    const updateSql = mock.calls[0].text;

    expect(updateSql).toContain("recent_ratings =");
    // append via || to_jsonb($5::text)
    expect(updateSql).toContain("recent_ratings || to_jsonb($5::text)");
    // cap at 5 most recent
    expect(updateSql).toContain("LIMIT 5");
    // re-aggregate in ascending order
    expect(updateSql).toContain("ORDER BY ord ASC");
  });

  it("writes track='l1' to review_logs INSERT", async () => {
    await runSaveAnswer();
    const insertSql = mock.calls[1].text;

    expect(insertSql).toContain("track");
    expect(insertSql).toContain("'l1'");
  });

  it("keeps INSERT review_logs parameters at $1-$16 (track is a literal)", async () => {
    await runSaveAnswer();
    const insertSql = mock.calls[1].text;

    // Highest placeholder should still be $16 — track is a literal, not a param
    expect(insertSql).toContain("$16, 'l1'");
    expect(insertSql).not.toContain("$17");
  });

  it("keeps UPDATE parameters at $1-$13 (l1 hash + recent_ratings reuse existing params)", async () => {
    await runSaveAnswer();
    const updateSql = mock.calls[0].text;

    // No new placeholders introduced — l1_content_hash_snapshot reuses $11,
    // recent_ratings subquery reuses $5 (rating)
    expect(updateSql).toContain("WHERE id = $13::uuid");
    expect(updateSql).not.toContain("$14");
    expect(updateSql).not.toContain("$15");
  });

  it("does not change the number of executed queries (UPDATE + INSERT)", async () => {
    await runSaveAnswer();
    expect(mock.calls.length).toBe(2);
  });

  it("does not break for 'again' rating", async () => {
    const result = await runSaveAnswer("again");
    expect(result.reviewLogId).toBe("log-1");
    expect(mock.calls[0].text).toContain("again_count = again_count + 1");
    expect(mock.calls[0].text).toContain("recent_ratings || to_jsonb($5::text)");
  });
});

// ── Task 7: markL1WeakSignal (Phase 2C L2→L1 weak-signal flag) ─────────
describe("markL1WeakSignal", () => {
  const mockTx = { query: mock.pool.query } as never;
  const txRepos = createRepositories(mockTx);

  it("sets l1_weak_signal=true scoped by (user, wordbook, word) and returns count", async () => {
    mock.setRows([{ id: "p1" }]);
    const count = await txRepos.reviews.markL1WeakSignal("u1", "wb1", "w1", true);

    expect(count).toBe(1);
    const q = mock.lastQuery!;
    expect(q.text).toContain("l1_weak_signal = $4");
    expect(q.text).toContain("user_id = $1");
    expect(q.text).toContain("wordbook_id = $2::uuid");
    expect(q.text).toContain("word_id = $3::uuid");
    expect(q.params).toEqual(["u1", "wb1", "w1", true]);
  });

  it("sets l1_weak_signal=false (clear flag)", async () => {
    mock.setRows([{ id: "p1" }]);
    await txRepos.reviews.markL1WeakSignal("u1", "wb1", "w1", false);

    expect(mock.lastQuery!.params).toEqual(["u1", "wb1", "w1", false]);
  });

  it("returns 0 when no progress row matches", async () => {
    mock.setRows([]);
    const count = await txRepos.reviews.markL1WeakSignal("u1", "wb1", "missing", true);
    expect(count).toBe(0);
  });

  // ── Decision-2: ONLY flips the flag — never re-cards ─────────────────
  it("does NOT touch due_at / needs_recheck / state (decision-2: mark only)", async () => {
    mock.setRows([{ id: "p1" }]);
    await txRepos.reviews.markL1WeakSignal("u1", "wb1", "w1", true);

    const sql = mock.lastQuery!.text;
    // Must NOT reference any re-card columns — L2 failure only marks.
    expect(sql).not.toContain("due_at");
    expect(sql).not.toContain("needs_recheck");
    expect(sql).not.toContain("state");
    expect(sql).not.toContain("relearning");
  });

  it("does NOT reference l2 tables (cross-track isolation)", async () => {
    mock.setRows([{ id: "p1" }]);
    await txRepos.reviews.markL1WeakSignal("u1", "wb1", "w1", true);

    expect(mock.lastQuery!.text).not.toContain("user_word_l2_progress");
  });
});
