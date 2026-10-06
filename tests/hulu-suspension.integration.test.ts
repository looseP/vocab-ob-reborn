/**
 * 葫芦冲刺挂起开关集成测试（完备设计 测试 7 / 执行计划 P2-3）。
 *
 * **Run with:** `npm run test:integration`（需真实 PostgreSQL）
 *
 * 断言（开关开时）：
 *  1. 创建计划后，`word_ids` 中的词全部 `suspended`，且 `suspend_snapshot` 记下了
 *     **挂起前 state**（`new` / `learning` / `relearning` / `review` 各一例）；
 *  2. 计划期间**用户手动挂起**的词（不在快照内）在恢复后仍是 `suspended`；
 *  3. 计划转 completed / abandoned 后：快照内行回到**挂起前 state**（不是统一
 *     `review`）、`suspend_snapshot` 清空；
 *  4. 挂起与恢复**都不写 review_logs**（行数不变）。
 *
 * 这是 R1「恢复 = 快照回写」的运行时证据：结构面（源码 grep）之外，真库跑一遍
 * 看那四行 state 有没有各自回到原处。
 *
 * 前置（与 tests/hulu-zero-write.integration.test.ts 同一套基建）：
 * - TEST_DATABASE_URL  管理连接（seed / cleanup / 读 state）
 * - TEST_APP_DATABASE_URL  受限应用连接（vocab_app，RLS 强制生效）—— 服务链路走它
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed（与 hulu-zero-write.integration.test.ts 同口径）：无 Postgres 时
// 让 run 变红，而不是让「恢复 = 快照回写」这条保证悄悄消失。
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the hulu suspension fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted hulu session");
}

/** 快照要覆盖的四种挂起前 state（完备设计 测试 7 原文）。 */
const SNAPSHOT_STATES = ["new", "learning", "relearning", "review"] as const;

describe("Hulu sprint suspension (integration)", () => {
  const USER_ID = randomUUID();
  const WORDBOOK_ID = randomUUID();
  /** 四种 state 各一词 + 一个「用户手动挂起」的词（不在 word_ids 内）。 */
  const WORD_IDS = SNAPSHOT_STATES.map(() => randomUUID());
  const MANUAL_WORD_ID = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });

  /** 管理连接读 progress 行（绕过 RLS，只用于断言）。 */
  async function readStates(wordIds: string[]): Promise<Record<string, string>> {
    const result = await adminPool.query<{ word_id: string; state: string }>(
      `SELECT word_id, state FROM user_word_progress WHERE user_id = $1 AND word_id = ANY($2::uuid[])`,
      [USER_ID, wordIds],
    );
    return Object.fromEntries(result.rows.map((row) => [row.word_id, row.state]));
  }

  async function reviewLogCount(): Promise<number> {
    const result = await adminPool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM review_logs WHERE user_id = $1`,
      [USER_ID],
    );
    return result.rows[0]!.total;
  }

  /** 计划行的快照（owner-RLS 表，须在带 actor claim 的事务内读）。 */
  async function readSnapshot(planId: string): Promise<Record<string, string> | null> {
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const plan = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, planId),
      { actorId: USER_ID },
    );
    return plan?.suspend_snapshot ?? null;
  }

  beforeAll(async () => {
    const email = `hulu-suspend-${USER_ID.slice(0, 8)}@example.test`;
    await adminPool.query(`INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [USER_ID, email]);
    await adminPool.query(`INSERT INTO profiles (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [USER_ID, email]);
    await adminPool.query(
      `INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, $3)`,
      [WORDBOOK_ID, USER_ID, `hulu suspend ${WORDBOOK_ID.slice(0, 8)}`],
    );

    // 五种词：四种快照 state 各一 + 一个只给用户手动挂起的词（不进计划 word_ids）。
    const allWords = [...WORD_IDS, MANUAL_WORD_ID];
    for (const [index, wordId] of allWords.entries()) {
      const slug = `hulu-suspend-${index}-${wordId.slice(0, 8)}`;
      await adminPool.query(
        `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md,
                            short_definition, is_published, is_deleted)
         VALUES ($1, $2, $3, 'test', $4, $4, 'def', 'body', $5, true, false)`,
        [wordId, slug, createHash("sha256").update(wordId).digest("hex"), `huluword${index}`, `释义 ${index}`],
      );
      // 手动挂起的那个词**不进词书**：它只用来验证「快照之外的词不动」。
      if (wordId !== MANUAL_WORD_ID) {
        await adminPool.query(
          `INSERT INTO wordbook_items (wordbook_id, word_id) VALUES ($1, $2)`,
          [WORDBOOK_ID, wordId],
        );
      }
    }

    // 四种 state 各一（含 due_at，让它们看起来像真的到期队列成员）。
    for (const [index, wordId] of WORD_IDS.entries()) {
      const state = SNAPSHOT_STATES[index]!;
      await adminPool.query(
        `INSERT INTO user_word_progress (user_id, word_id, wordbook_id, state, due_at)
         VALUES ($1, $2, $3, $4, now())`,
        [USER_ID, wordId, WORDBOOK_ID, state],
      );
    }
    // 用户手动挂起的词（快照之外；挂起期间用户自己挂的）。
    await adminPool.query(
      `INSERT INTO user_word_progress (user_id, word_id, wordbook_id, state, due_at)
       VALUES ($1, $2, $3, 'suspended', now())`,
      [USER_ID, MANUAL_WORD_ID, WORDBOOK_ID],
    );

    // 应用侧连接指向受限角色：RLS 生效（hulu 两表 + user_word_progress 的 owner 策略）。
    process.env.DATABASE_URL = appDatabaseUrl;
    process.env.DB_POOL_MAX = "2";
  });

  afterAll(async () => {
    await adminPool.query(`DELETE FROM hulu_rounds WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM hulu_plans WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM user_word_progress WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM wordbook_items WHERE wordbook_id = $1`, [WORDBOOK_ID]);
    await adminPool.query(`DELETE FROM words WHERE id = ANY($1::uuid[])`, [[...WORD_IDS, MANUAL_WORD_ID]]);
    await adminPool.query(`DELETE FROM wordbooks WHERE id = $1`, [WORDBOOK_ID]);
    await adminPool.query(`DELETE FROM profiles WHERE id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await adminPool.end();

    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    const { resetPool } = await import("@/db/connection");
    await resetPool();
  });

  it("创建时挂起 + 快照记录挂起前 state；放弃后逐行回写（new/learning/relearning/review）", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();
    const logsBefore = await reviewLogCount();

    // ① 创建（开关开）：四种 state 全部被挂起
    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
      suspendReview: true,
    });
    expect(plan.suspend_review).toBe(true);
    expect(plan.suspended_count).toBe(WORD_IDS.length);

    const afterApply = await readStates([...WORD_IDS, MANUAL_WORD_ID]);
    for (const wordId of WORD_IDS) {
      expect(afterApply[wordId], "计划内的词应被挂起").toBe("suspended");
    }
    expect(afterApply[MANUAL_WORD_ID], "快照外的词不受影响").toBe("suspended");

    // 快照逐行记下挂起前 state（不是统一 review）
    const snapshot = await readSnapshot(plan.id);
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot!).sort()).toEqual([...WORD_IDS].sort());
    for (const [index, wordId] of WORD_IDS.entries()) {
      expect(snapshot![wordId]).toBe(SNAPSHOT_STATES[index]);
    }

    // ② 放弃计划（同事务恢复）：逐行回到挂起前 state
    const abandoned = await service.abandonPlan({ userId: USER_ID, planId: plan.id });
    expect(abandoned.status).toBe("abandoned");

    const afterRestore = await readStates([...WORD_IDS, MANUAL_WORD_ID]);
    for (const [index, wordId] of WORD_IDS.entries()) {
      expect(afterRestore[wordId], `词 ${wordId} 应回到 ${SNAPSHOT_STATES[index]}`)
        .toBe(SNAPSHOT_STATES[index]);
    }
    // 快照外的词（用户手动挂起）不被葫芦恢复动到
    expect(afterRestore[MANUAL_WORD_ID], "快照外的挂起词应保持 suspended").toBe("suspended");

    // ③ 快照已清空
    expect(await readSnapshot(plan.id), "恢复后 suspend_snapshot 应清空").toBeNull();

    // ④ 挂起与恢复都没写 review_logs
    expect(await reviewLogCount(), "挂起/恢复不得写 review_logs").toBe(logsBefore);
  });

  it("末轮收尾（计划转 completed）也恢复快照；计划期间用户手动恢复过的词不动", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();
    const logsBefore = await reviewLogCount();

    // 先复位四种 state（上一用例已恢复，但这里再显式钉一次）
    for (const [index, wordId] of WORD_IDS.entries()) {
      await adminPool.query(
        `UPDATE user_word_progress SET state = $3 WHERE user_id = $1 AND word_id = $2`,
        [USER_ID, wordId, SNAPSHOT_STATES[index]],
      );
    }

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
      targetRounds: 2,
      suspendReview: true,
    });

    // 计划期间：用户手动把其中一个词恢复到 review（它因此离开挂起态）
    const manualRecovered = WORD_IDS[3]!;
    await adminPool.query(
      `UPDATE user_word_progress SET state = 'review' WHERE user_id = $1 AND word_id = $2`,
      [USER_ID, manualRecovered],
    );

    // 跑满两轮 → 末轮收尾时计划转 completed 并恢复快照
    for (let roundNo = 1; roundNo <= 2; roundNo += 1) {
      await service.startRound({ userId: USER_ID, planId: plan.id });
      await service.settlePage({
        userId: USER_ID, planId: plan.id, roundNo, pageIndex: 0,
        passed: WORD_IDS.length, total: WORD_IDS.length,
      });
      await service.finishRound({ userId: USER_ID, planId: plan.id, roundNo });
    }

    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const stored = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(stored?.status, "末轮收尾应把计划置 completed").toBe("completed");

    const afterFinish = await readStates([...WORD_IDS, MANUAL_WORD_ID]);
    for (const [index, wordId] of WORD_IDS.entries()) {
      if (wordId === manualRecovered) continue;
      expect(afterFinish[wordId], `词 ${wordId} 应回到 ${SNAPSHOT_STATES[index]}`)
        .toBe(SNAPSHOT_STATES[index]);
    }
    // 计划期间用户手动恢复过的词：葫芦恢复不动它（它已不是 suspended）
    expect(afterFinish[manualRecovered], "用户手动恢复过的词应保持用户的选择").toBe("review");
    expect(afterFinish[MANUAL_WORD_ID], "快照外的挂起词仍 suspended").toBe("suspended");

    expect(await readSnapshot(plan.id), "完成后快照应清空").toBeNull();
    expect(await reviewLogCount(), "整条链路不得写 review_logs").toBe(logsBefore);
  });

  it("elapsed_seconds 为负 / 超大都被夹取，轮次不丢、不报错（完备设计 测试 9）", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const { HULU_MAX_SINGLE_ROUND_SECONDS } = await import("@/domain/hulu-sprint");
    const service = new HuluPlanService();

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
      targetRounds: 4,
      suspendReview: false,
    });

    // ① 未来起跑 → elapsed 会是负数 → 夹到 0（不报错、轮次不丢）
    const future = new Date(Date.now() + 3600_000).toISOString();
    const round1 = await service.startRound({ userId: USER_ID, planId: plan.id, startedAt: future });
    const finished1 = await service.finishRound({ userId: USER_ID, planId: plan.id, roundNo: round1.round_no });
    expect(finished1.elapsed_seconds, "负耗时夹到 0").toBe(0);
    expect(finished1.ended_at).not.toBeNull();

    // ② 超上限起跑（夹取到 now - 7 天）→ elapsed 恰好是上限
    const ancient = new Date(Date.now() - 400 * 86400_000).toISOString();
    const round2 = await service.startRound({ userId: USER_ID, planId: plan.id, startedAt: ancient });
    const finished2 = await service.finishRound({ userId: USER_ID, planId: plan.id, roundNo: round2.round_no });
    expect(finished2.elapsed_seconds).toBe(HULU_MAX_SINGLE_ROUND_SECONDS);

    // ③ 轮次都在，没有丢
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const rounds = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findRoundsByPlan(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(rounds.map((row) => row.round_no)).toEqual([1, 2]);
    expect(rounds.every((row) => row.ended_at !== null)).toBe(true);

    await service.abandonPlan({ userId: USER_ID, planId: plan.id });
  });
});
