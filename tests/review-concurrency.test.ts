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
      userId: "00000000-0000-4000-8000-000000000001",
      pagination: { limit: 5, offset: 0 },
    });
    expect(result.items.length).toBe(5);
    expect(result.total).toBe(6767);
    expect(result.hasMore).toBe(true);
  });

  it("findPublic with search filter works", async () => {
    const repos = createRepositories();
    const result = await repos.words.findPublic({
      userId: "00000000-0000-4000-8000-000000000001",
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

  // ── ReviewService integration tests (H-NEW-1/H-NEW-2/M-NEW-4 verified) ──

  /**
   * Test data: creates a word + wordbook + progress row, returns cleanup fn.
   * Uses fixed UUIDs to avoid collisions; cleanup in reverse FK order.
   */
  async function createTestReviewData(): Promise<{
    wordId: string;
    wordbookId: string;
    progressId: string;
    sessionId: string;
    userId: string;
    cleanup: () => Promise<void>;
  }> {
    const userId = "00000000-0000-0000-0000-000000000001";
    // Generate unique UUIDs per test run
    const { randomUUID } = await import("crypto");
    const wordId = randomUUID();
    const wordbookId = randomUUID();
    const progressId = randomUUID();
    const sessionId = randomUUID();

    const pool = (await import("@/db/connection")).getPool();

    // Create a test word (minimal fields)
    await pool.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, 'test', 'testword', 'testword', 'def', 'body')`,
      [wordId, `test-${wordId.slice(0, 8)}`, "a".repeat(64)],
    );

    // Create a wordbook
    await pool.query(
      `INSERT INTO wordbooks (id, user_id, name, is_default)
       VALUES ($1, $2, 'test-wb', false)`,
      [wordbookId, userId],
    );

    // Create progress row
    await pool.query(
      `INSERT INTO user_word_progress (id, user_id, word_id, wordbook_id, state, desired_retention)
       VALUES ($1, $2, $3, $4, 'new', 0.9)`,
      [progressId, userId, wordId, wordbookId],
    );

    // Create a session
    await pool.query(
      `INSERT INTO sessions (id, user_id, wordbook_id, mode)
       VALUES ($1, $2, $3, 'review')`,
      [sessionId, userId, wordbookId],
    );

    return {
      wordId, wordbookId, progressId, sessionId, userId,
      cleanup: async () => {
        // Reverse FK order
        await pool.query("DELETE FROM review_logs WHERE session_id = $1", [sessionId]);
        await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
        await pool.query("DELETE FROM user_word_progress WHERE id = $1", [progressId]);
        await pool.query("DELETE FROM wordbook_items WHERE wordbook_id = $1", [wordbookId]);
        await pool.query("DELETE FROM wordbooks WHERE id = $1", [wordbookId]);
        await pool.query("DELETE FROM words WHERE id = $1", [wordId]);
      },
    };
  }

  // Mock FSRS adapter for integration tests
  const testFsrsAdapter = (() => ({
    difficulty: 0.4,
    dueAt: new Date(Date.now() + 86400000).toISOString(),
    logDueAt: new Date(Date.now() + 86400000).toISOString(),
    elapsedDays: 0,
    scheduledDays: 1,
    retrievability: 0.85,
    stability: 2.0,
    state: "review" as const,
    nextPayload: { test: true } as import("@/domain").Json,
  }));

  it("submitAnswer: updates progress + creates review_log in same transaction", async () => {
    const { ReviewService } = await import("@/services/review.service");
    const data = await createTestReviewData();
    try {
      const service = new ReviewService({
        fsrsAdapter: testFsrsAdapter as never,
        loadWeights: async () => null,
      });

      const result = await service.submitAnswer({
        progressId: data.progressId,
        rating: "good",
        sessionId: data.sessionId,
        idempotencyKey: `test-answer-${data.progressId}`,
      }, data.userId);

      expect(result.ok).toBe(true);
      expect(result.reviewLogId).toBeTruthy();

      // Verify progress was updated
      const pool = (await import("@/db/connection")).getPool();
      const { rows: progress } = await pool.query(
        "SELECT state, review_count, good_count, content_hash_snapshot FROM user_word_progress WHERE id = $1",
        [data.progressId],
      );
      expect(progress[0].state).toBe("review");
      expect(progress[0].review_count).toBe(1);
      expect(progress[0].good_count).toBe(1);
      // M-NEW-4: content_hash_snapshot should be refreshed
      expect(progress[0].content_hash_snapshot).toBe("a".repeat(64));

      // Verify review_log was created
      const { rows: logs } = await pool.query(
        "SELECT rating, state FROM review_logs WHERE idempotency_key = $1",
        [`test-answer-${data.progressId}`],
      );
      expect(logs.length).toBe(1);
      expect(logs[0].rating).toBe("good");
    } finally {
      await data.cleanup();
    }
  });

  it("submitAnswer: idempotent on duplicate key", async () => {
    const { ReviewService } = await import("@/services/review.service");
    const data = await createTestReviewData();
    try {
      const service = new ReviewService({
        fsrsAdapter: testFsrsAdapter as never,
        loadWeights: async () => null,
      });

      const key = `test-idempotent-${data.progressId}`;
      const r1 = await service.submitAnswer({
        progressId: data.progressId, rating: "good", sessionId: data.sessionId, idempotencyKey: key,
      }, data.userId);
      const r2 = await service.submitAnswer({
        progressId: data.progressId, rating: "hard", sessionId: data.sessionId, idempotencyKey: key,
      }, data.userId);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r2.idempotent).toBe(true);
      expect(r2.reviewLogId).toBe(r1.reviewLogId);

      // Only ONE review_log should exist
      const pool = (await import("@/db/connection")).getPool();
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM review_logs WHERE idempotency_key = $1", [key]);
      expect(rows[0].n).toBe(1);
    } finally {
      await data.cleanup();
    }
  });

  it("skip: increments skip_count and creates log", async () => {
    const { ReviewService } = await import("@/services/review.service");
    const data = await createTestReviewData();
    try {
      const service = new ReviewService({
        fsrsAdapter: testFsrsAdapter as never,
        loadWeights: async () => null,
      });

      const result = await service.skip(
        { progressId: data.progressId, sessionId: data.sessionId, idempotencyKey: `skip-${data.progressId}` },
        data.userId,
      );

      expect(result.ok).toBe(true);

      const pool = (await import("@/db/connection")).getPool();
      const { rows: progress } = await pool.query(
        "SELECT skip_count FROM user_word_progress WHERE id = $1", [data.progressId],
      );
      expect(progress[0].skip_count).toBe(1);

      const { rows: logs } = await pool.query(
        "SELECT metadata->>'action' AS action FROM review_logs WHERE idempotency_key = $1",
        [`skip-${data.progressId}`],
      );
      expect(logs[0].action).toBe("skip");
    } finally {
      await data.cleanup();
    }
  });

  it("suspend: sets state to suspended", async () => {
    const { ReviewService } = await import("@/services/review.service");
    const data = await createTestReviewData();
    try {
      const service = new ReviewService({
        fsrsAdapter: testFsrsAdapter as never,
        loadWeights: async () => null,
      });

      const result = await service.suspend(
        { progressId: data.progressId, sessionId: data.sessionId, idempotencyKey: `suspend-${data.progressId}` },
        data.userId,
      );

      expect(result.ok).toBe(true);

      const pool = (await import("@/db/connection")).getPool();
      const { rows: progress } = await pool.query(
        "SELECT state FROM user_word_progress WHERE id = $1", [data.progressId],
      );
      expect(progress[0].state).toBe("suspended");
    } finally {
      await data.cleanup();
    }
  });
});
