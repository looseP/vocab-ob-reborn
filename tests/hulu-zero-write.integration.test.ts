/**
 * 葫芦冲刺零写入集成测试（完备设计 测试 3 / 执行计划 P1-3）。
 *
 * **Run with:** `npm run test:integration`（需真实 PostgreSQL）
 *
 * 断言：`suspend_review = false`（默认）时，**一轮从头跑到收尾**前后
 *   - `review_logs` 行数不变
 *   - `user_word_progress.updated_at` 最大值不变
 *
 * 这是「零 FSRS 写入」从**结构保证**（表无 FSRS 列、服务不引用 review.service）
 * 之外的第二道证据：跑一遍真实链路，看那两张表有没有被动过。
 *
 * 前置（与 tests/l3-rls.integration.test.ts 同一套基建）：
 * - TEST_DATABASE_URL  管理连接（seed / cleanup / 计数）
 * - TEST_APP_DATABASE_URL  受限应用连接（vocab_app，RLS 强制生效）—— 服务链路走它
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed（与 l3-rls.integration.test.ts 同口径）：本文件被 test:integration
// 无条件收集，静默 skip 会让「零写入」这条保证在无 Postgres 的环境里悄悄消失。
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the hulu zero-write fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted hulu session");
}

describe("Hulu sprint zero-write (integration)", () => {
  const USER_ID = randomUUID();
  const WORDBOOK_ID = randomUUID();
  const WORD_IDS = [randomUUID(), randomUUID(), randomUUID()];
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });

  beforeAll(async () => {
    const email = `hulu-zerowrite-${USER_ID.slice(0, 8)}@example.test`;
    await adminPool.query(`INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [USER_ID, email]);
    await adminPool.query(`INSERT INTO profiles (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [USER_ID, email]);
    await adminPool.query(
      `INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, $3)`,
      [WORDBOOK_ID, USER_ID, `hulu zero-write ${WORDBOOK_ID.slice(0, 8)}`],
    );

    // 三个 published + 未删词，并挂进词书（定格取词的来源）。
    for (const [index, wordId] of WORD_IDS.entries()) {
      const slug = `hulu-zw-${index}-${wordId.slice(0, 8)}`;
      await adminPool.query(
        `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md,
                            short_definition, is_published, is_deleted)
         VALUES ($1, $2, $3, 'test', $4, $4, 'def', 'body', $5, true, false)`,
        [wordId, slug, createHash("sha256").update(wordId).digest("hex"), `huluword${index}`, `释义 ${index}`],
      );
      await adminPool.query(
        `INSERT INTO wordbook_items (wordbook_id, word_id) VALUES ($1, $2)`,
        [WORDBOOK_ID, wordId],
      );
    }

    // 应用侧连接指向受限角色：RLS 生效（hulu 两表 owner 策略）。
    process.env.DATABASE_URL = appDatabaseUrl;
    process.env.DB_POOL_MAX = "2";
  });

  afterAll(async () => {
    // 逆 FK 顺序清理；hulu 两表随 wordbook 级联消失，仍显式删以防万一。
    await adminPool.query(`DELETE FROM hulu_rounds WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM hulu_plans WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM wordbook_items WHERE wordbook_id = $1`, [WORDBOOK_ID]);
    await adminPool.query(`DELETE FROM words WHERE id = ANY($1::uuid[])`, [WORD_IDS]);
    await adminPool.query(`DELETE FROM wordbooks WHERE id = $1`, [WORDBOOK_ID]);
    await adminPool.query(`DELETE FROM profiles WHERE id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await adminPool.end();

    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    const { resetPool } = await import("@/db/connection");
    await resetPool();
  });

  /** FSRS 可见面的两个指纹：日志行数 + 进度表最近更新时间。 */
  async function fsrsFingerprint(): Promise<{ reviewLogs: number; maxUpdatedAt: string | null }> {
    const logs = await adminPool.query(`SELECT count(*)::int AS total FROM review_logs`);
    const progress = await adminPool.query(
      `SELECT max(updated_at)::text AS latest FROM user_word_progress WHERE user_id = $1`,
      [USER_ID],
    );
    return {
      reviewLogs: logs.rows[0].total as number,
      maxUpdatedAt: (progress.rows[0].latest as string | null) ?? null,
    };
  }

  it("一轮从创建跑到收尾，review_logs 行数与 user_word_progress.updated_at 最大值都不变", async () => {
    const { createRepositories } = await import("@/repositories/factory");
    const { HuluPlanService } = await import("@/services/hulu-plan.service");

    const before = await fsrsFingerprint();
    const service = new HuluPlanService();

    // ① 创建计划（默认 suspend_review = false，零 FSRS 的唯一前提）
    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5, // 3 词 → 1 页（下限 5，切片取实际词数）
    });
    expect(plan.status).toBe("active");
    expect(plan.suspend_review).toBe(false);
    expect(plan.word_count).toBe(WORD_IDS.length);

    // ② 页载荷（只读）
    const page = await service.getPlanPage({ userId: USER_ID, planId: plan.id, pageIndex: 0 });
    expect(page.alive).toBe(WORD_IDS.length);
    expect(page.total).toBe(WORD_IDS.length);
    expect(page.items).toHaveLength(WORD_IDS.length);

    // ③ 开始轮次
    const round = await service.startRound({ userId: USER_ID, planId: plan.id });
    expect(round.round_no).toBe(1);
    expect(round.words_total).toBe(WORD_IDS.length);

    // ④ 页结算（全通过，过闸）
    const settled = await service.settlePage({
      userId: USER_ID,
      planId: plan.id,
      roundNo: round.round_no,
      pageIndex: 0,
      passed: page.alive,
      total: page.alive,
    });
    expect(settled.pages_passed).toBe(1);

    // ⑤ 轮次收尾
    const finished = await service.finishRound({
      userId: USER_ID,
      planId: plan.id,
      roundNo: round.round_no,
    });
    expect(finished.ended_at).not.toBeNull();
    expect(finished.elapsed_seconds).not.toBeNull();

    const after = await fsrsFingerprint();

    // 否决条件：一轮前后 review_logs 行数有变化 = 已触发，立即失败
    expect(after.reviewLogs, "review_logs 行数在一轮前后发生了变化").toBe(before.reviewLogs);
    expect(after.maxUpdatedAt, "user_word_progress.updated_at 最大值在一轮前后发生了变化")
      .toBe(before.maxUpdatedAt);

    // 计划确实落库了（不是"什么都没做"导致的假绿）。
    // 注意：hulu 两表是 owner-RLS 表 —— 池连接不带 auth.uid() claim 时读不到行，
    // 必须在携带 actorId 的事务内读（同 session.repository 的注释口径）。
    const { withTransaction } = await import("@/db/transaction");
    const stored = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(stored).not.toBeNull();
    const rounds = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findRoundsByPlan(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.ended_at).not.toBeNull();
  });

  it("收尾后计划与轮次只写 hulu_* 两表（结构性零 FSRS 的第二道证据）", async () => {
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
    });
    const round = await service.startRound({ userId: USER_ID, planId: plan.id });

    // 该用户在任何 FSRS 表里都不应有行（这个词书从未进过复习流）
    const progress = await adminPool.query(
      `SELECT count(*)::int AS total FROM user_word_progress WHERE user_id = $1`,
      [USER_ID],
    );
    expect(progress.rows[0].total).toBe(0);

    const logs = await adminPool.query(
      `SELECT count(*)::int AS total FROM review_logs WHERE user_id = $1`,
      [USER_ID],
    );
    expect(logs.rows[0].total).toBe(0);

    // 轮次照常存在于 hulu_rounds（owner-RLS 表，须带 actor claim 读）
    const stored = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findRoundByNo(USER_ID, plan.id, round.round_no),
      { actorId: USER_ID },
    );
    expect(stored).not.toBeNull();
  });
});
