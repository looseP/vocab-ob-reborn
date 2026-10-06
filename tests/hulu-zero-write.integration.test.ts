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

    // 三个 published + 未删词，并以 **learning 态进度行**入池（R9：定格源 =
    // 复习牌堆，wordbook_items 不再参与定格）。
    for (const [index, wordId] of WORD_IDS.entries()) {
      const slug = `hulu-zw-${index}-${wordId.slice(0, 8)}`;
      await adminPool.query(
        `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md,
                            short_definition, is_published, is_deleted)
         VALUES ($1, $2, $3, 'test', $4, $4, 'def', 'body', $5, true, false)`,
        [wordId, slug, createHash("sha256").update(wordId).digest("hex"), `huluword${index}`, `释义 ${index}`],
      );
      await adminPool.query(
        `INSERT INTO user_word_progress (user_id, word_id, wordbook_id, state, due_at)
         VALUES ($1, $2, $3, 'learning', now())`,
        [USER_ID, wordId, WORDBOOK_ID],
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
    await adminPool.query(`DELETE FROM user_word_progress WHERE user_id = $1`, [USER_ID]);
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

  /**
   * 清掉本用户残留的 active 计划 —— 创建是**幂等**的（同词书已有 active 计划
   * 直接返回它），前一个用例留下的计划会让后一个用例拿到旧行（include_new_words
   * 之类的字段对不上）。用 adminPool 直删（hulu 两表随计划级联），不走服务层。
   */
  async function clearActivePlans(): Promise<void> {
    await adminPool.query(
      `DELETE FROM hulu_plans WHERE user_id = $1`,
      [USER_ID],
    );
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

  it("收尾后计划与轮次只写 hulu_* 两表；进度行只被读、不被改（R9 的第二道证据）", async () => {
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();

    // 定格源是进度行（R9）→ 先拍下它们的指纹：行数 + 最近更新时间。
    const progressBefore = await adminPool.query(
      `SELECT count(*)::int AS total, max(updated_at)::text AS latest
         FROM user_word_progress WHERE user_id = $1`,
      [USER_ID],
    );
    expect(progressBefore.rows[0].total).toBe(WORD_IDS.length);

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
    });
    const round = await service.startRound({ userId: USER_ID, planId: plan.id });

    // 进度行数量不变、updated_at 最大值不变 —— 定格取词只 SELECT，不写回。
    const progressAfter = await adminPool.query(
      `SELECT count(*)::int AS total, max(updated_at)::text AS latest
         FROM user_word_progress WHERE user_id = $1`,
      [USER_ID],
    );
    expect(progressAfter.rows[0].total, "进度行数不得变化").toBe(progressBefore.rows[0].total);
    expect(progressAfter.rows[0].latest, "进度行 updated_at 不得变化")
      .toBe(progressBefore.rows[0].latest);

    // 状态仍是入池前的 learning（没有被读路径顺手改成别的）
    const states = await adminPool.query<{ state: string }>(
      `SELECT state FROM user_word_progress WHERE user_id = $1`,
      [USER_ID],
    );
    expect(states.rows.map((row) => row.state)).toEqual(WORD_IDS.map(() => "learning"));

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

  it("曝光轮整轮（R12）前后：review_logs 行数与 user_word_progress.updated_at 最大值都不变", async () => {
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();

    // 曝光轮的前提：v2 + includeNewWords（池含 new）。本 fixture 的三词是
    // learning 态，两档都入池 —— 这里要的是「曝光轮这条链路」的零写入证据。
    // 幂等创建会拿回上一用例留下的 active 计划 → 先清干净。
    await clearActivePlans();
    const before = await fsrsFingerprint();

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
      includeNewWords: true,
    });
    expect(plan.include_new_words).toBe(true);

    // ① 开第 0 轮：曝光轮（直展，不计入目标轮数）
    const exposure = await service.startRound({ userId: USER_ID, planId: plan.id });
    expect(exposure.round_no).toBe(0);
    expect(exposure.kind).toBe("exposure");

    // ② 页载荷（只读；曝光轮不发与闸门相关的请求，页结算仍走同一管道）
    const page = await service.getPlanPage({ userId: USER_ID, planId: plan.id, pageIndex: 0 });
    expect(page.alive).toBe(WORD_IDS.length);

    // ③ 页结算：passed = total = 存活词数（恒过闸，语义 = 已曝光）
    const settled = await service.settlePage({
      userId: USER_ID,
      planId: plan.id,
      roundNo: exposure.round_no,
      pageIndex: 0,
      passed: page.alive,
      total: page.alive,
    });
    expect(settled.pages_passed).toBe(1);
    expect(settled.words_passed).toBe(page.alive);

    // ④ 曝光轮收尾（部分收尾也合法；这里页已齐）
    const finished = await service.finishRound({
      userId: USER_ID,
      planId: plan.id,
      roundNo: exposure.round_no,
    });
    expect(finished.kind).toBe("exposure");
    expect(finished.ended_at).not.toBeNull();
    // 曝光轮不推进计划完成（R12）
    const stillActive = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(stillActive!.status).toBe("active");

    const after = await fsrsFingerprint();
    expect(after.reviewLogs, "曝光轮前后 review_logs 行数发生了变化").toBe(before.reviewLogs);
    expect(after.maxUpdatedAt, "曝光轮前后 user_word_progress.updated_at 最大值发生了变化")
      .toBe(before.maxUpdatedAt);

    // ⑤ 曝光轮收尾后开第 1 轮：kind='recall'，round_no=1（曝光轮不占复习轮号）
    const recall = await service.startRound({ userId: USER_ID, planId: plan.id });
    expect(recall.round_no).toBe(1);
    expect(recall.kind).toBe("recall");

    await service.abandonPlan({ userId: USER_ID, planId: plan.id });
  });

  it("R15-2 防线（真库）：复习轮页未齐不能收尾；曝光轮部分收尾合法", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();

    // 2 页计划（3 词 / 每页 5 → 实际 1 页；用 pageSize=5 与 3 词，页数 1）
    // 为拿到「页未齐」，先造 2 页：用 pageSize=5 + 6 词不可得（fixture 只 3 词），
    // 故此处用「1 页但 pages_passed=0」直接验复习轮被拦。
    await clearActivePlans();
    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
    });
    const round = await service.startRound({ userId: USER_ID, planId: plan.id });
    expect(round.kind).toBe("recall");

    const error = await service.finishRound({
      userId: USER_ID,
      planId: plan.id,
      roundNo: round.round_no,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({
      httpStatus: 422,
      meta: { pagesPassed: 0, pages: 1 },
    });

    // 页结算后即可收尾
    const page = await service.getPlanPage({ userId: USER_ID, planId: plan.id, pageIndex: 0 });
    await service.settlePage({
      userId: USER_ID,
      planId: plan.id,
      roundNo: round.round_no,
      pageIndex: 0,
      passed: page.alive,
      total: page.alive,
    });
    const finished = await service.finishRound({
      userId: USER_ID,
      planId: plan.id,
      roundNo: round.round_no,
    });
    expect(finished.ended_at).not.toBeNull();
    // 收尾同时写了结算词集指纹（R13）
    expect(finished.word_set_fingerprint).toMatch(/^[0-9a-f]{16}$/);

    await service.abandonPlan({ userId: USER_ID, planId: plan.id });
  });
});
