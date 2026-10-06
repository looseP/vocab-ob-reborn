/**
 * 葫芦定格池源集成测试（修订轮 R9 / D-A「先学后刷」）。
 *
 * **Run with:** `npm run test:integration`（需真实 PostgreSQL）
 *
 * 这是池源修订的**运行时证据**（结构面之外）：真库种一批各态进度行，看定格
 * 出来的 `word_ids` 到底是哪几个、按什么序。
 *
 * 断言：
 *  1. learning / review / relearning **入池**；
 *  2. `new` **不入池**（先学后刷：没见过的词不逼"回忆"）；
 *  3. `suspended` **不入池**（用户主动放下的，冲刺不替他捡回来）；
 *  4. 序 = `created_at ASC, word_id ASC`（加入复习的顺序；同刻用 word_id 兜底）；
 *  5. 池空 → BusinessRuleError（422 语义）+ 先学后刷文案，不落库。
 *
 * 前置（与 tests/hulu-zero-write.integration.test.ts 同一套基建）：
 * - TEST_DATABASE_URL  管理连接（seed / cleanup / 断言）
 * - TEST_APP_DATABASE_URL  受限应用连接（vocab_app，RLS 强制生效）—— 服务链路走它
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed：无 Postgres 时让 run 变红，而不是让「先学后刷」这条保证悄悄消失。
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the hulu pool-source fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted hulu session");
}

describe("Hulu pool source (integration) — 先学后刷", () => {
  const USER_ID = randomUUID();
  const EMPTY_WORDBOOK_ID = randomUUID();
  const WORDBOOK_ID = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });

  /** 入池的三种 state，各一词（序由 created_at 决定）。 */
  const POOL_SPEC: Array<{ state: string; minutesAgo: number }> = [
    { state: "review", minutesAgo: 30 },
    { state: "learning", minutesAgo: 20 },
    { state: "relearning", minutesAgo: 10 },
  ];
  const POOL_WORD_IDS = POOL_SPEC.map(() => randomUUID());
  /** 不入池的两态（`new` 先学后刷 / `suspended` 用户放下）。 */
  const NEW_WORD_ID = randomUUID();
  const SUSPENDED_WORD_ID = randomUUID();

  async function seedWord(wordId: string, index: number, wordbookId: string): Promise<void> {
    const slug = `hulu-pool-${index}-${wordId.slice(0, 8)}`;
    await adminPool.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md,
                          short_definition, is_published, is_deleted)
       VALUES ($1, $2, $3, 'test', $4, $4, 'def', 'body', $5, true, false)`,
      [wordId, slug, createHash("sha256").update(wordId).digest("hex"), `poolword${index}`, `释义 ${index}`],
    );
    await adminPool.query(
      `INSERT INTO user_word_progress (user_id, word_id, wordbook_id, state, due_at)
       VALUES ($1, $2, $3, 'new', now())`,
      [USER_ID, wordId, wordbookId],
    );
  }

  beforeAll(async () => {
    const email = `hulu-pool-${USER_ID.slice(0, 8)}@example.test`;
    await adminPool.query(`INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [USER_ID, email]);
    await adminPool.query(`INSERT INTO profiles (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [USER_ID, email]);
    await adminPool.query(
      `INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, $3)`,
      [WORDBOOK_ID, USER_ID, `hulu pool ${WORDBOOK_ID.slice(0, 8)}`],
    );
    // 空池词书（用来验证「池空 → 422 + 文案」）。
    await adminPool.query(
      `INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, $3)`,
      [EMPTY_WORDBOOK_ID, USER_ID, `hulu pool empty ${EMPTY_WORDBOOK_ID.slice(0, 8)}`],
    );

    // 五词：三种入池态 + new + suspended。
    const allWords = [...POOL_WORD_IDS, NEW_WORD_ID, SUSPENDED_WORD_ID];
    for (const [index, wordId] of allWords.entries()) {
      await seedWord(wordId, index, WORDBOOK_ID);
    }

    // 入池态：created_at 显式错开（插入序与期望序**相反**，让「稳定序」可证伪）
    for (const [index, wordId] of POOL_WORD_IDS.entries()) {
      const { state, minutesAgo } = POOL_SPEC[index]!;
      await adminPool.query(
        `UPDATE user_word_progress
            SET state = $3, created_at = now() - ($4 || ' minutes')::interval
          WHERE user_id = $1 AND word_id = $2`,
        [USER_ID, wordId, state, String(minutesAgo)],
      );
    }
    // new：本就不入池（默认态，无需改）。
    // suspended：用户放下的。
    await adminPool.query(
      `UPDATE user_word_progress SET state = 'suspended' WHERE user_id = $1 AND word_id = $2`,
      [USER_ID, SUSPENDED_WORD_ID],
    );

    process.env.DATABASE_URL = appDatabaseUrl;
    process.env.DB_POOL_MAX = "2";
  });

  afterAll(async () => {
    await adminPool.query(`DELETE FROM hulu_rounds WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM hulu_plans WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM user_word_progress WHERE user_id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM words WHERE id = ANY($1::uuid[])`,
      [[...POOL_WORD_IDS, NEW_WORD_ID, SUSPENDED_WORD_ID]]);
    await adminPool.query(`DELETE FROM wordbooks WHERE id = ANY($1::uuid[])`, [[WORDBOOK_ID, EMPTY_WORDBOOK_ID]]);
    await adminPool.query(`DELETE FROM profiles WHERE id = $1`, [USER_ID]);
    await adminPool.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await adminPool.end();

    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    const { resetPool } = await import("@/db/connection");
    await resetPool();
  });

  it("池 = learning/review/relearning；new 与 suspended 不入池；序按 created_at ASC", async () => {
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");

    const ids = await withTransaction(
      async (tx) => createRepositories(tx).hulu.listReviewDeckWordIds(USER_ID, WORDBOOK_ID),
      { actorId: USER_ID },
    );

    // 只有三态入池（5 词里筛掉 new 与 suspended）
    expect(ids).toHaveLength(POOL_SPEC.length);
    expect(new Set(ids)).toEqual(new Set(POOL_WORD_IDS));
    // `new` 与 `suspended` 明确不在池内
    expect(ids).not.toContain(NEW_WORD_ID);
    expect(ids).not.toContain(SUSPENDED_WORD_ID);
    // 序 = created_at ASC（越早加入复习的越靠前）：review(30min) → learning(20min) → relearning(10min)
    expect(ids).toEqual(POOL_WORD_IDS);
  });

  it("createPlan 定格 = 池内容与池序；`new` 不入池（word_count 也不含它）", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const service = new HuluPlanService();

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
    });

    // 出参是摘要（word_count），全量 word_ids 在库里读
    expect(plan.word_count).toBe(POOL_SPEC.length);
    const stored = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(stored!.word_ids).toEqual(POOL_WORD_IDS);
    expect(stored!.word_ids).not.toContain(NEW_WORD_ID);
    expect(stored!.word_ids).not.toContain(SUSPENDED_WORD_ID);

    // 页载荷也是池里的词（不是整本词书）
    const page = await service.getPlanPage({ userId: USER_ID, planId: plan.id, pageIndex: 0 });
    expect(page.alive).toBe(POOL_SPEC.length);
    expect(new Set(page.items.map((item) => item.id))).toEqual(new Set(POOL_WORD_IDS));

    await service.abandonPlan({ userId: USER_ID, planId: plan.id });
  });

  it("池空（没有已评分过的词）→ BusinessRuleError + 先学后刷文案，且不落库", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();

    const plansBefore = await adminPool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM hulu_plans WHERE user_id = $1`,
      [USER_ID],
    );

    const error = await service.createPlan({
      userId: USER_ID,
      wordbookId: EMPTY_WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({
      httpStatus: 422,
      message: "该词书还没有可冲刺的词——先去标准复习，至少复习过一次再回来。",
    });

    // 没有留下任何计划行
    const plansAfter = await adminPool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM hulu_plans WHERE user_id = $1`,
      [USER_ID],
    );
    expect(plansAfter.rows[0]!.total).toBe(plansBefore.rows[0]!.total);
  });

  it("includeNewWords=true（R12）：`new` 词入池（四态），suspended 仍不入池", async () => {
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");

    const ids = await withTransaction(
      async (tx) => createRepositories(tx).hulu.listReviewDeckWordIds(USER_ID, WORDBOOK_ID, { includeNew: true }),
      { actorId: USER_ID },
    );

    // 四态：三态 + new（5 词里只筛掉 suspended）
    expect(ids).toHaveLength(POOL_SPEC.length + 1);
    expect(new Set(ids)).toEqual(new Set([...POOL_WORD_IDS, NEW_WORD_ID]));
    expect(ids).toContain(NEW_WORD_ID);
    // suspended 两档都不入池（用户主动放下的不捡回来）
    expect(ids).not.toContain(SUSPENDED_WORD_ID);
    // 稳定序不变：created_at ASC（new 行是种子插入序里最早的批次，
    // 与三态同批插入 → 同刻，用 word_id 兜底，故只锁「序与默认档同源」）
    expect(ids.slice(0, POOL_SPEC.length)).toEqual(POOL_WORD_IDS);
  });

  it("includeNewWords=true 但词书四态全空 → 换「词书里没词」文案（R12 双档文案）", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const service = new HuluPlanService();

    const error = await service.createPlan({
      userId: USER_ID,
      wordbookId: EMPTY_WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
      includeNewWords: true,
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({
      httpStatus: 422,
      message: "该词书还没有词——先把词加进词书再冲刺。",
    });
  });

  it("includeNewWords=true 的计划显式落库 protocol_version='v2' 与 include_new_words", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const service = new HuluPlanService();

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
      includeNewWords: true,
    });

    expect(plan.protocol_version).toBe("v2");
    expect(plan.include_new_words).toBe(true);
    // 池含 new → 定格词数 = 三态 + new
    expect(plan.word_count).toBe(POOL_SPEC.length + 1);

    const stored = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    expect(stored!.protocol_version).toBe("v2");
    expect(stored!.include_new_words).toBe(true);

    await service.abandonPlan({ userId: USER_ID, planId: plan.id });
  });

  it("默认档计划落 protocol_version='v2' / include_new_words=false（不吃 DB 的 legacy 默认值）", async () => {
    const { HuluPlanService } = await import("@/services/hulu-plan.service");
    const { createRepositories } = await import("@/repositories/factory");
    const { withTransaction } = await import("@/db/transaction");
    const service = new HuluPlanService();

    const plan = await service.createPlan({
      userId: USER_ID,
      wordbookId: WORDBOOK_ID,
      examDate: "2030-12-20",
      pageSize: 5,
    });

    const stored = await withTransaction(
      async (tx) => createRepositories(tx).hulu.findPlanById(USER_ID, plan.id),
      { actorId: USER_ID },
    );
    // 新代码写新行恒 'v2'（'legacy' 只该出现在迁移前的存量行）
    expect(stored!.protocol_version).toBe("v2");
    expect(stored!.include_new_words).toBe(false);

    await service.abandonPlan({ userId: USER_ID, planId: plan.id });
  });
});
