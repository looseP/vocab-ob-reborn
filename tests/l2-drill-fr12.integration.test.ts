/**
 * FR-12 E2E 集成测试 —— 连接真实 PostgreSQL，验证全链路。
 *
 * Run with: npm run test:integration
 *
 * 覆盖三大流程：
 * 1. L2 应答 → outbox track='l2' 事件 → worker → l2_weak_signal → L1 flag
 * 2. L3ContextSourceAdapter 从真实 L3 表读取语境片段
 * 3. L3 无语境时适配器返回空数组（回退由 buildL2ProductionTask 处理）
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)("FR-12 E2E: L2 review loop + L3 context consumption (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL!;
    pool = (await import("@/db/connection")).getPool();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  // ─── 测试数据构建器 ──────────────────────────────────────────────────

  async function seedFullStack(opts: {
    l2RecentRatings?: string[];
    l3ContextText?: string;
    wordLemma?: string;
  } = {}): Promise<{
    userId: string;
    wordId: string;
    wordbookId: string;
    l1ProgressId: string;
    l2ProgressId: string;
    sessionId: string;
    l3ContextId?: string;
    cleanup: () => Promise<void>;
  }> {
    const userId = randomUUID();
    const wordId = randomUUID();
    const wordbookId = randomUUID();
    const l1ProgressId = randomUUID();
    const l2ProgressId = randomUUID();
    const sessionId = randomUUID();
    const contentHash = createHash("sha256").update(wordId).digest("hex");
    const slug = `e2e-${wordId.slice(0, 8)}`;
    const lemma = opts.wordLemma ?? "vivid";

    // user + profile
    await pool.query(
      "INSERT INTO users (id, email) VALUES ($1, $2)",
      [userId, `e2e-${userId.slice(0, 8)}@test.com`],
    );
    await pool.query(
      "INSERT INTO profiles (id, email) VALUES ($1, $2)",
      [userId, `e2e-${userId.slice(0, 8)}@test.com`],
    );

    // word
    await pool.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, 'test', $4, $4, 'def', 'body')`,
      [wordId, slug, contentHash, lemma],
    );

    // wordbook
    await pool.query(
      `INSERT INTO wordbooks (id, user_id, name, is_default)
       VALUES ($1, $2, 'e2e-wb', false)`,
      [wordbookId, userId],
    );

    // L1 progress (user_word_progress)
    await pool.query(
      `INSERT INTO user_word_progress (id, user_id, word_id, wordbook_id, state, desired_retention, l1_weak_signal)
       VALUES ($1, $2, $3, $4, 'review', 0.85, false)`,
      [l1ProgressId, userId, wordId, wordbookId],
    );

    // L2 progress
    const recentRatings = JSON.stringify(opts.l2RecentRatings ?? []);
    await pool.query(
      `INSERT INTO user_word_l2_progress
         (id, user_id, word_id, wordbook_id, l2_state, l2_due_at, l2_review_count,
          recent_ratings, l2_scheduler_payload, l2_paused)
       VALUES ($1, $2, $3, $4, 'review', NOW() - INTERVAL '1 day', 2, $5::jsonb, $6::jsonb, false)`,
      [
        l2ProgressId, userId, wordId, wordbookId,
        recentRatings,
        JSON.stringify({ due: new Date(Date.now() - 86400000).toISOString(), stability: 3, difficulty: 5, state: 2 }),
      ],
    );

    // session
    await pool.query(
      `INSERT INTO sessions (id, user_id, wordbook_id, mode)
       VALUES ($1, $2, $3, 'l2_drill')`,
      [sessionId, userId, wordbookId],
    );

    // L3 data (optional)
    let l3ContextId: string | undefined;
    if (opts.l3ContextText) {
      const sourceId = randomUUID();
      l3ContextId = randomUUID();
      const occurrenceId = randomUUID();
      await pool.query(
        `INSERT INTO l3_sources (id, user_id, source_type, title)
         VALUES ($1, $2, 'article', 'E2E Test Source')`,
        [sourceId, userId],
      );
      await pool.query(
        `INSERT INTO l3_contexts (id, source_id, user_id, context_type, text)
         VALUES ($1, $2, $3, 'sentence', $4)`,
        [l3ContextId, sourceId, userId, opts.l3ContextText],
      );
      await pool.query(
        `INSERT INTO l3_occurrences (id, context_id, word_id, user_id, surface)
         VALUES ($1, $2, $3, $4, $5)`,
        [occurrenceId, l3ContextId, wordId, userId, lemma],
      );
    }

    return {
      userId, wordId, wordbookId, l1ProgressId, l2ProgressId, sessionId, l3ContextId,
      cleanup: async () => {
        // 反向 FK 顺序。outbox_effect_receipts 通过 outbox_events 的
        // ON DELETE CASCADE 自动清理，无需单独删除。
        await pool.query("DELETE FROM l3_occurrences WHERE word_id = $1", [wordId]);
        if (l3ContextId) await pool.query("DELETE FROM l3_contexts WHERE id = $1", [l3ContextId]);
        await pool.query("DELETE FROM l3_sources WHERE user_id = $1", [userId]);
        await pool.query("DELETE FROM outbox_events WHERE aggregate_id = $1", [l2ProgressId]);
        await pool.query("DELETE FROM review_logs WHERE session_id = $1", [sessionId]);
        await pool.query("DELETE FROM l2_drill_session_steps WHERE session_id = $1", [sessionId]);
        await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
        await pool.query("DELETE FROM user_word_l2_progress WHERE id = $1", [l2ProgressId]);
        await pool.query("DELETE FROM user_word_progress WHERE id = $1", [l1ProgressId]);
        await pool.query("DELETE FROM wordbook_items WHERE wordbook_id = $1", [wordbookId]);
        await pool.query("DELETE FROM wordbooks WHERE id = $1", [wordbookId]);
        await pool.query("DELETE FROM words WHERE id = $1", [wordId]);
        await pool.query("DELETE FROM profiles WHERE id = $1", [userId]);
        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      },
    };
  }

  // mock FSRS adapter（与 review-service.integration.test.ts 一致）
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

  // ─── 流程 1: L2 应答 → outbox → worker → l2_weak_signal → L1 flag ───

  describe("Flow 1: L2 answer → outbox track='l2' → worker → l1_weak_signal", () => {
    it("submits L2 answer, enqueues track='l2' event, worker marks l1_weak_signal", async () => {
      const { L2ReviewService } = await import("@/services/l2-review.service");
      const { ReviewOutboxWorker } = await import("@/outbox/review-outbox.worker");

      // seed: L2 recent_ratings 已有 2 个 again，再答 again → 3 个连续 again 触发弱信号
      const data = await seedFullStack({ l2RecentRatings: ["again", "again"] });
      try {
        const service = new L2ReviewService({
          fsrsAdapter: testFsrsAdapter as never,
          loadWeights: async () => null,
        });

        // 1. 提交 L2 应答（rating=again）
        const idemKey = `e2e-l2-${data.l2ProgressId}`;
        const result = await service.submitL2Answer(
          {
            progressId: data.l2ProgressId,
            sessionId: data.sessionId,
            rating: "again",
            idempotencyKey: idemKey,
          },
          data.userId,
        );

        expect(result.ok).toBe(true);
        expect(result.reviewLogId).toBeTruthy();

        // 2. 验证 outbox 事件已入队且 track='l2'
        const { rows: events } = await pool.query(
          `SELECT event_type, payload->>'track' AS track, status
           FROM outbox_events
           WHERE dedupe_key = $1`,
          [`review.answer.recorded.v1:${result.reviewLogId}`],
        );
        expect(events.length).toBe(1);
        expect(events[0].event_type).toBe("review.answer.recorded.v1");
        expect(events[0].track).toBe("l2");
        expect(events[0].status).toBe("pending");

        // 3. 运行 worker 处理事件
        const worker = new ReviewOutboxWorker(undefined, { workerId: "e2e-worker-1" });
        const processed = await worker.processBatch();
        expect(processed).toBe(1);

        // 4. 验证 l1_weak_signal 被标记为 true（3 个连续 again 触发弱信号）
        const { rows: l1 } = await pool.query(
          `SELECT l1_weak_signal FROM user_word_progress WHERE id = $1`,
          [data.l1ProgressId],
        );
        expect(l1[0].l1_weak_signal).toBe(true);

        // 5. 验证 outbox 事件被标记为 processed
        const { rows: processed_events } = await pool.query(
          `SELECT status FROM outbox_events WHERE dedupe_key = $1`,
          [`review.answer.recorded.v1:${result.reviewLogId}`],
        );
        expect(processed_events[0].status).toBe("processed");

        // 6. 验证 outbox_effect_receipts 记录了 l2_weak_signal 效应
        const { rows: receipts } = await pool.query(
          `SELECT effect_name FROM outbox_effect_receipts
           WHERE event_id = (SELECT id FROM outbox_events WHERE dedupe_key = $1)`,
          [`review.answer.recorded.v1:${result.reviewLogId}`],
        );
        expect(receipts.some((r) => r.effect_name === "l2_weak_signal")).toBe(true);
        // 不应有 cards_seen / l1_cascade / l2_transition 效应（track='l2' 红线）
        expect(receipts.some((r) => r.effect_name === "session_cards_seen")).toBe(false);
        expect(receipts.some((r) => r.effect_name === "l1_cascade")).toBe(false);
        expect(receipts.some((r) => r.effect_name === "l2_transition")).toBe(false);
      } finally {
        await data.cleanup();
      }
    });

    it("does NOT mark l1_weak_signal when L2 recent_ratings has mixed ratings", async () => {
      const { L2ReviewService } = await import("@/services/l2-review.service");
      const { ReviewOutboxWorker } = await import("@/outbox/review-outbox.worker");

      // seed: L2 recent_ratings = [good, again] → 再答 again → [good, again, again]
      // 只有 2 个连续 again，不满 3 个窗口 → 不触发弱信号
      const data = await seedFullStack({ l2RecentRatings: ["good", "again"] });
      try {
        const service = new L2ReviewService({
          fsrsAdapter: testFsrsAdapter as never,
          loadWeights: async () => null,
        });

        const result = await service.submitL2Answer(
          {
            progressId: data.l2ProgressId,
            sessionId: data.sessionId,
            rating: "again",
            idempotencyKey: `e2e-nosignal-${data.l2ProgressId}`,
          },
          data.userId,
        );

        const worker = new ReviewOutboxWorker(undefined, { workerId: "e2e-worker-2" });
        await worker.processBatch();

        // 弱信号不应被标记（只有 2 个连续 again，窗口要求 3 个）
        const { rows: l1 } = await pool.query(
          `SELECT l1_weak_signal FROM user_word_progress WHERE id = $1`,
          [data.l1ProgressId],
        );
        expect(l1[0].l1_weak_signal).toBe(false);
      } finally {
        await data.cleanup();
      }
    });

    it("does NOT increment cards_seen for L2 events (track='l2' red line)", async () => {
      const { L2ReviewService } = await import("@/services/l2-review.service");
      const { ReviewOutboxWorker } = await import("@/outbox/review-outbox.worker");

      const data = await seedFullStack({ l2RecentRatings: ["good", "good"] });
      try {
        const service = new L2ReviewService({
          fsrsAdapter: testFsrsAdapter as never,
          loadWeights: async () => null,
        });

        // 记录处理前的 cards_seen
        const { rows: beforeRows } = await pool.query(
          `SELECT cards_seen FROM sessions WHERE id = $1`,
          [data.sessionId],
        );
        const cardsSeenBefore = beforeRows[0]?.cards_seen ?? 0;

        await service.submitL2Answer(
          {
            progressId: data.l2ProgressId,
            sessionId: data.sessionId,
            rating: "good",
            idempotencyKey: `e2e-nocount-${data.l2ProgressId}`,
          },
          data.userId,
        );

        const worker = new ReviewOutboxWorker(undefined, { workerId: "e2e-worker-3" });
        await worker.processBatch();

        // track='l2' 事件不应递增 cards_seen（红线：一词不记两次账）
        const { rows: afterRows } = await pool.query(
          `SELECT cards_seen FROM sessions WHERE id = $1`,
          [data.sessionId],
        );
        expect(afterRows[0].cards_seen).toBe(cardsSeenBefore);
      } finally {
        await data.cleanup();
      }
    });
  });

  // ─── 流程 2: L3ContextSourceAdapter 从真实 L3 表读取语境片段 ─────────

  describe("Flow 2: L3ContextSourceAdapter reads real L3 contexts", () => {
    it("returns ContextSnippet[] (text + source metadata) from L3 contexts linked to the word", async () => {
      const { L3ContextSourceAdapter } = await import("@/services/l3-context-source-adapter");

      const l3Text = "The vivid colors of the sunset were breathtaking.";
      const data = await seedFullStack({ l3ContextText: l3Text });
      try {
        const adapter = new L3ContextSourceAdapter();
        const snippets = await adapter.getContextSnippets({
          userId: data.userId,
          wordId: data.wordId,
        });

        // P3-8：snippets 是 ContextSnippet[]，断言 .text 字段包含 l3Text
        // 同时验证 sourceTitle / contextId 元数据已携带
        expect(snippets.length).toBeGreaterThan(0);
        expect(snippets.map((s) => s.text)).toContain(l3Text);
        const hit = snippets.find((s) => s.text === l3Text);
        expect(hit).toBeTruthy();
        expect(hit?.contextId).toBeTruthy();
        expect(hit?.sourceTitle).toBeTruthy();
      } finally {
        await data.cleanup();
      }
    });

    it("respects RLS: other user's L3 contexts are invisible", async () => {
      const { L3ContextSourceAdapter } = await import("@/services/l3-context-source-adapter");

      // 用户 A 的 L3 语境
      const l3Text = "User A private context.";
      const dataA = await seedFullStack({ l3ContextText: l3Text, wordLemma: "private" });
      try {
        // 用户 B 查同一个 wordId（但 L3 数据是用户 A 的）
        const userB = randomUUID();
        await pool.query(
          "INSERT INTO users (id, email) VALUES ($1, $2)",
          [userB, `e2e-b-${userB.slice(0, 8)}@test.com`],
        );
        await pool.query(
          "INSERT INTO profiles (id, email) VALUES ($1, $2)",
          [userB, `e2e-b-${userB.slice(0, 8)}@test.com`],
        );
        try {
          const adapter = new L3ContextSourceAdapter();
          const snippets = await adapter.getContextSnippets({
            userId: userB,
            wordId: dataA.wordId,
          });

          // RLS 隔离：用户 B 看不到用户 A 的 L3 语境
          expect(snippets).toEqual([]);
        } finally {
          await pool.query("DELETE FROM profiles WHERE id = $1", [userB]);
          await pool.query("DELETE FROM users WHERE id = $1", [userB]);
        }
      } finally {
        await dataA.cleanup();
      }
    });
  });

  // ─── 流程 3: L3 无语境时适配器返回空数组（回退由调用方处理） ──────────

  describe("Flow 3: L3ContextSourceAdapter returns empty when no L3 contexts", () => {
    it("returns empty array when word has no L3 contexts", async () => {
      const { L3ContextSourceAdapter } = await import("@/services/l3-context-source-adapter");

      // 不 seed 任何 L3 数据
      const data = await seedFullStack({});
      try {
        const adapter = new L3ContextSourceAdapter();
        const snippets = await adapter.getContextSnippets({
          userId: data.userId,
          wordId: data.wordId,
        });

        expect(snippets).toEqual([]);
      } finally {
        await data.cleanup();
      }
    });
  });
});
