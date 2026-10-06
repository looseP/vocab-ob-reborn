/**
 * HuluRepository 单元测试（ADR-0041）。
 *
 * 形状照 tests/repositories/l3-study-notes.test.ts：**fake PoolClient 直构仓库**
 * （无真实 DB），断言 SQL 文本 + 参数顺序。真实 PG 行为见 test:db-release /
 * test:db-roles（本机无 Postgres 时标环境受限）。
 *
 * 验证点：
 * - insertPlan：列清单 / `$8::uuid[]` / jsonb 快照序列化 / RETURNING *
 * - 唯一索引冲突：23505 判据（服务层据此重查返回既有计划 = 幂等创建）
 * - 读取：findPlanById / findActivePlanByWordbook 的 owner scope 与 status 过滤
 * - 轮次：insertRound 的 now() 兜底 / findOpenRound 的 ended_at IS NULL / findRoundByNo
 * - 定格取词：listReviewDeckWordIds 的入池条件（learning/review/relearning）与稳定序
 * - 级联删除：迁移 SQL 的两条复合 FK 均为 cascade（结构断言）
 * - 零 FSRS **写入**：全部 SQL 不出现 review_logs / sessions / l3_sessions，
 *   也不出现对 user_word_progress 的写（定格取词只读该表，见 R9）
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { HuluRepository, isUniqueViolation } from "@/repositories/hulu.repository";
import { ReviewRepository } from "@/repositories/review.repository";

const USER = "00000000-0000-4000-8000-0000000000a1";
const OTHER_USER = "00000000-0000-4000-8000-0000000000a2";
const WB = "00000000-0000-4000-8000-0000000000b1";
const PLAN = "00000000-0000-4000-8000-0000000000c1";
const W1 = "00000000-0000-4000-8000-0000000000d1";
const W2 = "00000000-0000-4000-8000-0000000000d2";

function fakeClient(): PoolClient {
  return { query: vi.fn(async () => ({ rows: [] as unknown[] })) } as unknown as PoolClient;
}

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLAN, user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
    target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: [W1, W2],
    status: "active", suspend_review: false, suspend_snapshot: null,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}

function roundRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "round-1", plan_id: PLAN, user_id: USER, round_no: 1,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
    pages_passed: 0, words_passed: 0, words_total: 2,
    ...overrides,
  };
}

let client: PoolClient;
let repo: HuluRepository;
let querySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = fakeClient();
  querySpy = client.query as unknown as ReturnType<typeof vi.fn>;
  repo = new HuluRepository(client);
});

describe("HuluRepository.insertPlan", () => {
  it("INSERT 全列 + uuid[] + RETURNING *", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));

    const row = await repo.insertPlan({
      user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
      target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: [W1, W2],
      suspend_review: false, suspend_snapshot: null,
    });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO hulu_plans");
    expect(text).toContain("(user_id, wordbook_id, direction, exam_date, target_rounds, page_size,");
    expect(text).toContain("gate_ratio, word_ids, suspend_review, suspend_snapshot)");
    expect(text).toContain("$8::uuid[]");
    expect(text).toContain("$10::jsonb");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual([USER, WB, null, "2026-12-20", 4, 20, 0.8, [W1, W2], false, null]);
    expect(row.id).toBe(PLAN);
  });

  it("suspend_snapshot 非空时序列化为 JSON 字符串（P2 才接线，此处锁形状）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));

    await repo.insertPlan({
      user_id: USER, wordbook_id: WB, direction: "考研", exam_date: "2026-12-20",
      target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: [W1, W2],
      suspend_review: true, suspend_snapshot: { [W1]: "new", [W2]: "review" },
    });

    expect(querySpy.mock.calls[0]![1][9]).toBe(JSON.stringify({ [W1]: "new", [W2]: "review" }));
  });

  it("插入无返回行时显式报错（不静默返回 undefined）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await expect(
      repo.insertPlan({
        user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
        target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: [W1],
        suspend_review: false, suspend_snapshot: null,
      }),
    ).rejects.toThrow("hulu plan insert returned no row");
  });

  it("并发撞唯一索引时 23505 透出（服务层据此重查返回既有计划）", async () => {
    const violation = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    querySpy.mockImplementation(async () => { throw violation; });

    await expect(
      repo.insertPlan({
        user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
        target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: [W1],
        suspend_review: false, suspend_snapshot: null,
      }),
    ).rejects.toThrow(/duplicate key/);
  });

  it("isUniqueViolation 判据：23505 → true，其它错误码/普通错误 → false", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("HuluRepository 读取", () => {
  it("findPlanById 钉死 owner scope", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));

    const row = await repo.findPlanById(USER, PLAN);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM hulu_plans WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(params).toEqual([PLAN, USER]);
    expect(row!.id).toBe(PLAN);
  });

  it("findActivePlanByWordbook 只认 status='active' 且钉死 (user, wordbook)", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));

    await repo.findActivePlanByWordbook(USER, WB);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("WHERE user_id = $1::uuid AND wordbook_id = $2::uuid AND status = 'active'");
    expect(text).toContain("LIMIT 1");
    expect(params).toEqual([USER, WB]);
  });

  it("findRoundsByPlan 按 round_no 升序（缩时曲线的数据源顺序）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow()] }));

    const rows = await repo.findRoundsByPlan(USER, PLAN);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("ORDER BY round_no ASC");
    expect(params).toEqual([PLAN, USER]);
    expect(rows).toHaveLength(1);
  });

  it("assertWordbookOwned 走显式归属检查（越权 → false）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ id: WB }] }));
    expect(await repo.assertWordbookOwned(USER, WB)).toBe(true);
    expect(querySpy.mock.calls[0]![0]).toContain("SELECT id FROM wordbooks WHERE id = $1::uuid AND user_id = $2::uuid");

    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.assertWordbookOwned(OTHER_USER, WB)).toBe(false);
  });
});

describe("HuluRepository 轮次", () => {
  it("insertRound：started_at 为 null 时由 DB now() 兜底", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow()] }));

    await repo.insertRound({ plan_id: PLAN, user_id: USER, round_no: 1, started_at: null, words_total: 2 });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("INSERT INTO hulu_rounds (plan_id, user_id, round_no, started_at, words_total)");
    expect(text).toContain("COALESCE($4::timestamptz, now())");
    expect(params).toEqual([PLAN, USER, 1, null, 2]);
  });

  it("insertRound：显式 started_at 原样传入", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow()] }));

    await repo.insertRound({
      plan_id: PLAN, user_id: USER, round_no: 1,
      started_at: "2026-10-06T08:00:00Z", words_total: 2,
    });

    expect(querySpy.mock.calls[0]![1][3]).toBe("2026-10-06T08:00:00Z");
  });

  it("insertRound 无返回行时显式报错", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    await expect(
      repo.insertRound({ plan_id: PLAN, user_id: USER, round_no: 1, started_at: null, words_total: 2 }),
    ).rejects.toThrow("hulu round insert returned no row");
  });

  it("findOpenRound 只认 ended_at IS NULL（「至多一个未收尾轮」的读侧）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow()] }));

    await repo.findOpenRound(USER, PLAN);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("AND ended_at IS NULL");
    expect(params).toEqual([PLAN, USER]);
  });

  it("findRoundByNo 按 (plan, user, round_no) 定位", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow({ round_no: 2 })] }));

    await repo.findRoundByNo(USER, PLAN, 2);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("AND round_no = $3");
    expect(params).toEqual([PLAN, USER, 2]);
  });
});

describe("HuluRepository.setPlanStatus / lockPlanForUpdate", () => {
  it("ended=true 写 now()；suspendSnapshot=null 清快照", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow({ status: "abandoned" })] }));

    const row = await repo.setPlanStatus(USER, PLAN, "abandoned", { ended: true, suspendSnapshot: null });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("ended_at = CASE WHEN $4::boolean THEN now() ELSE ended_at END");
    expect(text).toContain("suspend_snapshot = CASE WHEN $5::boolean THEN NULL ELSE suspend_snapshot END");
    expect(params).toEqual([PLAN, USER, "abandoned", true, true]);
    expect(row!.status).toBe("abandoned");
  });

  it("不传 suspendSnapshot 时保留快照（clear=false）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));

    await repo.setPlanStatus(USER, PLAN, "completed", { ended: true });

    expect(querySpy.mock.calls[0]![1][4]).toBe(false);
  });

  it("lockPlanForUpdate 带 FOR UPDATE（串行化未收尾轮判断）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));

    await repo.lockPlanForUpdate(USER, PLAN);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FOR UPDATE");
    expect(params).toEqual([PLAN, USER]);
  });

  it("事务绑定是硬要求：未绑定事务时三条写路径均拒绝（requireTx）", async () => {
    const noTx = new HuluRepository();
    await expect(noTx.setPlanStatus(USER, PLAN, "abandoned", { ended: true }))
      .rejects.toThrow(/requires an active transaction/);
    await expect(noTx.lockPlanForUpdate(USER, PLAN))
      .rejects.toThrow(/requires an active transaction/);
  });
});

describe("HuluRepository.listReviewDeckWordIds（定格取词：先学后刷，R9）", () => {
  it("池源是复习牌堆：SQL 只认 learning/review/relearning，按 (created_at ASC, word_id ASC) 稳定序", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ word_id: W1 }, { word_id: W2 }] }));

    const ids = await repo.listReviewDeckWordIds(USER, WB);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("SELECT word_id FROM user_word_progress");
    expect(text).toContain("WHERE user_id = $1::uuid AND wordbook_id = $2::uuid");
    // 入池条件：三态白名单（排除 new 与 suspended 是靠白名单本身，不是黑名单）
    expect(text).toContain("state = ANY(ARRAY['learning','review','relearning'])");
    expect(text).toContain("ORDER BY created_at ASC, word_id ASC");
    expect(params).toEqual([USER, WB]);
    expect(ids).toEqual([W1, W2]);
  });

  it("池源不再是 wordbook_items（错位修复的结构面：真实库里它几乎为空）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ word_id: W1 }] }));

    await repo.listReviewDeckWordIds(USER, WB);

    const [text] = querySpy.mock.calls[0]!;
    expect(text).not.toContain("wordbook_items");
  });

  it("`new` 不入池：白名单不含 'new'，也不含 'suspended'（先学后刷 + 不捡回放下的）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));

    await repo.listReviewDeckWordIds(USER, WB);

    const [text] = querySpy.mock.calls[0]!;
    // 白名单是唯一判据：改写成黑名单（state <> 'new'）会立刻红
    expect(text).toContain("state = ANY(ARRAY['learning','review','relearning'])");
    expect(text).not.toMatch(/state\s*(<>|!=)\s*'new'/);
    expect(text).not.toContain("'new'");
    expect(text).not.toContain("'suspended'");
  });

  it("空牌堆返回空数组（不报错；服务层据此抛业务错）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));
    expect(await repo.listReviewDeckWordIds(USER, WB)).toEqual([]);
  });

  it("requireTx：未绑定事务时拒绝（owner-RLS 表无 actor claim 会静默返回空集）", async () => {
    const noTx = new HuluRepository();
    await expect(noTx.listReviewDeckWordIds(USER, WB))
      .rejects.toThrow(/requires an active transaction/);
  });
});

describe("HuluRepository.findHuluPageWords（页载荷取词：卡面全字段，R10）", () => {
  it("SELECT 卡面 15 列（含 core_definitions / definition_md / 助记 / 语义链），只取已发布未删", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));

    await repo.findHuluPageWords([W1, W2]);

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("FROM words");
    expect(text).toContain("core_definitions");
    expect(text).toContain("definition_md");
    expect(text).toContain("COALESCE(metadata->>'mnemonic_text', metadata->>'mnemonic') AS mnemonic_text");
    expect(text).toContain("metadata->>'mnemonic_type' AS mnemonic_type");
    expect(text).toContain("metadata->>'semantic_chain' AS semantic_chain");
    expect(text).toContain("WHERE id = ANY($1::uuid[]) AND is_published = true AND is_deleted = false");
    expect(params).toEqual([[W1, W2]]);
  });

  it("空数组短路（不发 SQL）", async () => {
    expect(await repo.findHuluPageWords([])).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("jsonb 列非数组时归一为空数组（前端据此走 definition_md 降级）", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ id: W1, slug: "a", title: "a", lemma: "a", ipa: null, pos: null, cefr: null,
        short_definition: null, core_definitions: null, definition_md: "d", examples: null,
        prototype_text: null, mnemonic_text: null, mnemonic_type: null, semantic_chain: null }],
    }));

    const rows = await repo.findHuluPageWords([W1]);

    expect(rows[0]!.core_definitions).toEqual([]);
    expect(rows[0]!.examples).toEqual([]);
  });

  it("只读 words 一张表：不触碰 user_word_progress / review_logs", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));

    await repo.findHuluPageWords([W1]);

    const [text] = querySpy.mock.calls[0]!;
    expect(text).not.toContain("user_word_progress");
    expect(text).not.toContain("review_logs");
    expect(text).not.toContain("wordbook_items");
  });
});

describe("HuluRepository 结构性红线", () => {
  it("全部 SQL 不触碰 FSRS 面（零 FSRS 写入是结构性的）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [planRow()] }));
    await repo.insertPlan({
      user_id: USER, wordbook_id: WB, direction: null, exam_date: "2026-12-20",
      target_rounds: 4, page_size: 20, gate_ratio: 0.8, word_ids: [W1],
      suspend_review: false, suspend_snapshot: null,
    });
    await repo.findPlanById(USER, PLAN);
    await repo.findActivePlanByWordbook(USER, WB);
    await repo.findRoundsByPlan(USER, PLAN);
    await repo.assertWordbookOwned(USER, WB);
    await repo.listReviewDeckWordIds(USER, WB);

    const sql = querySpy.mock.calls.map((call) => call[0]).join("\n");
    // 定格取词是**只读** user_word_progress（R9）：出现 SELECT 不算违规，
    // 但任何写形态（UPDATE / INSERT / DELETE / SET）都必须缺席。
    expect(sql).not.toContain("UPDATE user_word_progress");
    expect(sql).not.toContain("INSERT INTO user_word_progress");
    expect(sql).not.toContain("DELETE FROM user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("review_logs");
    expect(sql).not.toContain("INSERT INTO sessions");
    expect(sql).not.toContain("l3_sessions");
  });

  it("表结构声明级联删除（删词书 → 计划与轮次消失）", () => {
    const migration = readFileSync(
      new URL("../../drizzle-release/0050_hulu_sprint.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("plan_id","user_id") REFERENCES "public"."hulu_plans"("id","user_id") ON DELETE cascade',
    );
    // 不改任何已有表：迁移里的 ALTER TABLE 只应出现在两张新表上
    const altered = [...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]!);
    for (const table of altered) {
      expect(["hulu_plans", "hulu_rounds"]).toContain(table);
    }
  });
});

describe("ReviewRepository 葫芦挂起两方法（ADR-0041 决策 5，第 9/10 个 state 写点）", () => {
  it("bulkSuspendByWordIds：单条 set-based 语句，RETURNING 挂起前 state，且不写 review_logs", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [{ word_id: W1, old_state: "new" }, { word_id: W2, old_state: "review" }],
    }));
    const reviewRepo = new ReviewRepository(client);

    const snapshot = await reviewRepo.bulkSuspendByWordIds({
      userId: USER, wordbookId: WB, wordIds: [W1, W2],
    });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("UPDATE user_word_progress u");
    expect(text).toContain("SET state = 'suspended', updated_at = now()");
    expect(text).toContain("AND word_id = ANY($3::uuid[])");
    expect(text).toContain("AND state <> 'suspended'");
    expect(text).toContain("RETURNING s.word_id, s.old_state");
    // 与一键遗忘的关键区别：葫芦的快照落计划行，不写 review_logs
    expect(text).not.toContain("review_logs");
    expect(params).toEqual([USER, WB, [W1, W2]]);
    expect(snapshot).toEqual([{ wordId: W1, oldState: "new" }, { wordId: W2, oldState: "review" }]);
  });

  it("bulkSuspendByWordIds：空数组短路（不发 SQL）", async () => {
    const reviewRepo = new ReviewRepository(client);
    expect(await reviewRepo.bulkSuspendByWordIds({ userId: USER, wordbookId: WB, wordIds: [] })).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("restoreSuspendSnapshot：jsonb_to_recordset 展开，只回写仍为 suspended 的行", async () => {
    querySpy.mockImplementation(async () => ({ rows: [{ id: "p-1" }] }));
    const reviewRepo = new ReviewRepository(client);

    const restored = await reviewRepo.restoreSuspendSnapshot({
      userId: USER, wordbookId: WB, snapshot: { [W1]: "new", [W2]: "learning" },
    });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("jsonb_to_recordset($3::jsonb) AS s(word_id uuid, old_state text)");
    expect(text).toContain("SET state = s.old_state, updated_at = now()");
    expect(text).toContain("AND u.state = 'suspended'");
    // 禁止统一恢复成 'review'（完备设计 R1 的最重修正）
    expect(text).not.toContain("'review'");
    expect(text).not.toContain("review_logs");
    expect(params).toEqual([
      USER, WB,
      JSON.stringify([{ word_id: W1, old_state: "new" }, { word_id: W2, old_state: "learning" }]),
    ]);
    expect(restored).toBe(1);
  });

  it("restoreSuspendSnapshot：空快照短路（不发 SQL）", async () => {
    const reviewRepo = new ReviewRepository(client);
    expect(await reviewRepo.restoreSuspendSnapshot({ userId: USER, wordbookId: WB, snapshot: {} })).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("两方法均 requireTx（未绑定事务时拒绝）", async () => {
    const noTx = new ReviewRepository();
    await expect(noTx.bulkSuspendByWordIds({ userId: USER, wordbookId: WB, wordIds: [W1] }))
      .rejects.toThrow(/requires an active transaction/);
    await expect(noTx.restoreSuspendSnapshot({ userId: USER, wordbookId: WB, snapshot: { [W1]: "new" } }))
      .rejects.toThrow(/requires an active transaction/);
  });
});

describe("HuluRepository.settlePage（R7 页结算条件 UPDATE）", () => {
  it("单条条件 UPDATE：游标相等 + 未收尾才命中，pages_passed 加一", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow({ pages_passed: 1 })] }));

    const row = await repo.settlePage({ userId: USER, roundId: "round-1", pageIndex: 0, passed: 18 });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("UPDATE hulu_rounds");
    expect(text).toContain("SET pages_passed = pages_passed + 1, words_passed = words_passed + $4");
    // R7 的三个判据：owner + 未收尾 + 游标相等
    expect(text).toContain("AND user_id = $2::uuid");
    expect(text).toContain("AND ended_at IS NULL");
    expect(text).toContain("AND pages_passed = $3");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual(["round-1", USER, 0, 18]);
    expect(row?.pages_passed).toBe(1);
  });

  it("未命中（游标不匹配 / 已收尾）→ null（服务层据此分流幂等或 409）", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));

    expect(await repo.settlePage({ userId: USER, roundId: "round-1", pageIndex: 5, passed: 0 })).toBeNull();
  });

  it("requireTx：未绑定事务时拒绝", async () => {
    const noTx = new HuluRepository();
    await expect(noTx.settlePage({ userId: USER, roundId: "round-1", pageIndex: 0, passed: 0 }))
      .rejects.toThrow(/requires an active transaction/);
  });
});

describe("HuluRepository.finishRound（轮收尾条件 UPDATE）", () => {
  it("条件 UPDATE：ended_at IS NULL 才写，写 ended_at + elapsed_seconds", async () => {
    querySpy.mockImplementation(async () => ({
      rows: [roundRow({ ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 3600 })],
    }));

    const row = await repo.finishRound({
      userId: USER, roundId: "round-1", endedAt: "2026-10-06T01:00:00Z", elapsedSeconds: 3600,
    });

    const [text, params] = querySpy.mock.calls[0]!;
    expect(text).toContain("UPDATE hulu_rounds");
    expect(text).toContain("SET ended_at = $3::timestamptz, elapsed_seconds = $4");
    expect(text).toContain("AND ended_at IS NULL");
    expect(text).toContain("RETURNING *");
    expect(params).toEqual(["round-1", USER, "2026-10-06T01:00:00Z", 3600]);
    expect(row?.elapsed_seconds).toBe(3600);
  });

  it("已收尾（并发双收尾的另一方）→ null，服务层幂等返回现状", async () => {
    querySpy.mockImplementation(async () => ({ rows: [] }));

    expect(await repo.finishRound({
      userId: USER, roundId: "round-1", endedAt: "2026-10-06T01:00:00Z", elapsedSeconds: 1,
    })).toBeNull();
  });

  it("requireTx：未绑定事务时拒绝", async () => {
    const noTx = new HuluRepository();
    await expect(noTx.finishRound({
      userId: USER, roundId: "round-1", endedAt: "2026-10-06T01:00:00Z", elapsedSeconds: 1,
    })).rejects.toThrow(/requires an active transaction/);
  });
});

describe("HuluRepository P1 零 FSRS（结构性）", () => {
  it("settlePage / finishRound 的 SQL 不触碰任何 FSRS 面", async () => {
    querySpy.mockImplementation(async () => ({ rows: [roundRow()] }));
    await repo.settlePage({ userId: USER, roundId: "round-1", pageIndex: 0, passed: 1 });
    await repo.finishRound({
      userId: USER, roundId: "round-1", endedAt: "2026-10-06T01:00:00Z", elapsedSeconds: 1,
    });

    const sql = querySpy.mock.calls.map((call) => call[0] as string).join("\n");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("review_logs");
    expect(sql).not.toContain("INSERT INTO sessions");
    expect(sql).not.toContain("l3_sessions");
    // 只写 hulu_rounds 一张表
    expect(sql.match(/UPDATE (\w+)/g)).toEqual(["UPDATE hulu_rounds", "UPDATE hulu_rounds"]);
  });
});
