/**
 * Integration test — connects to the real PostgreSQL DB.
 * Skipped unless TEST_DATABASE_URL is set.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRepositories, resetDb, withTransaction } from "@/index";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)("ReviewRepository (integration)", () => {
  let seededWordCount = 0;

  beforeAll(() => {
    process.env.DATABASE_URL = TEST_DB_URL!;
  });

  afterAll(async () => {
    await resetDb();
  });

  it("has seeded words available", async () => {
    const repos = createRepositories();
    seededWordCount = await repos.words.count();
    expect(seededWordCount).toBeGreaterThan(0);
  });

  it("finds a word by slug", async () => {
    const { createHash, randomUUID } = await import("node:crypto");
    const pool = (await import("@/db/connection")).getPool();
    const wordId = randomUUID();
    const slug = `test-find-${wordId.slice(0, 8)}`;
    const contentHash = createHash("sha256").update(wordId).digest("hex");
    await pool.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, 'test', 'testword', 'testword', 'def', 'body')`,
      [wordId, slug, contentHash],
    );
    try {
      const repos = createRepositories();
      const word = await repos.words.findBySlug(slug);
      expect(word).not.toBeNull();
      expect(word!.lemma).toBe("testword");
      expect(word!.definition_md).toBeTruthy();
    } finally {
      await pool.query("DELETE FROM words WHERE id = $1", [wordId]);
    }
  });

  it("findPublic returns paginated results", async () => {
    const repos = createRepositories();
    const result = await repos.words.findPublic({
      userId: randomUUID(),
      pagination: { limit: 5, offset: 0 },
    });
    expect(result.items.length).toBe(Math.min(5, seededWordCount));
    expect(result.total).toBe(seededWordCount);
    expect(result.hasMore).toBe(seededWordCount > 5);
  });

  it("findPublic with search filter works", async () => {
    const { createHash, randomUUID } = await import("node:crypto");
    const pool = (await import("@/db/connection")).getPool();
    const wordId = randomUUID();
    const slug = `test-search-${wordId.slice(0, 8)}`;
    const contentHash = createHash("sha256").update(wordId).digest("hex");
    await pool.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, 'test', 'searchableterm', 'searchableterm', 'def', 'body')`,
      [wordId, slug, contentHash],
    );
    try {
      const repos = createRepositories();
      const result = await repos.words.findPublic({
        userId: randomUUID(),
        filters: { q: "searchableterm" },
        pagination: { limit: 10, offset: 0 },
      });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.some((w) => w.lemma.includes("searchableterm"))).toBe(true);
    } finally {
      await pool.query("DELETE FROM words WHERE id = $1", [wordId]);
    }
  });

  it("findSlugs returns ordered slugs", async () => {
    const repos = createRepositories();
    const limit = Math.min(100, seededWordCount);
    const slugs = await repos.words.findSlugs(limit);
    expect(slugs.length).toBe(limit);
    expect(slugs).toEqual([...slugs].sort());
  });

  it("transaction commits successfully", async () => {
    const result = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      const count = await repos.words.count();
      return count;
    });
    expect(result).toBe(seededWordCount);
  });

  it("dashboard summary returns valid data", async () => {
    const repos = createRepositories();
    const summary = await repos.stats.getDashboardSummary(
      randomUUID(),
      randomUUID(),
    );
    expect(summary.totalWords).toBe(seededWordCount);
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
    contentHash: string;
    cleanup: () => Promise<void>;
  }> {
    const userId = randomUUID();
    const wordId = randomUUID();
    const wordbookId = randomUUID();
    const progressId = randomUUID();
    const sessionId = randomUUID();
    const contentHash = createHash("sha256").update(wordId).digest("hex");

    const pool = (await import("@/db/connection")).getPool();

    // Create user + profile (required by wordbooks FK)
    await pool.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [userId, `test-${userId.slice(0, 8)}@example.test`],
    );
    await pool.query(
      "INSERT INTO profiles (id, email) VALUES ($1, $2)",
      [userId, `test-${userId.slice(0, 8)}@example.test`],
    );

    // Create a test word (minimal fields)
    await pool.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, 'test', 'testword', 'testword', 'def', 'body')`,
      [wordId, `test-${wordId.slice(0, 8)}`, contentHash],
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
      wordId, wordbookId, progressId, sessionId, userId, contentHash,
      cleanup: async () => {
        // Reverse FK order
        await pool.query("DELETE FROM review_logs WHERE session_id = $1", [sessionId]);
        await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
        await pool.query("DELETE FROM user_word_progress WHERE id = $1", [progressId]);
        await pool.query("DELETE FROM wordbook_items WHERE wordbook_id = $1", [wordbookId]);
        await pool.query("DELETE FROM wordbooks WHERE id = $1", [wordbookId]);
        await pool.query("DELETE FROM words WHERE id = $1", [wordId]);
        await pool.query("DELETE FROM profiles WHERE id = $1", [userId]);
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
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
      expect(progress[0].content_hash_snapshot).toBe(data.contentHash);

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
