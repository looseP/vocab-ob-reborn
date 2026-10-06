/**
 * HuluPlanService 单元测试（ADR-0041，执行计划 P0-5）。
 *
 * 形状照 tests/services/forgetting.service.test.ts：mock 事务 + 仓库工厂，
 * 服务永不触碰真实 DB。
 *
 * 验证点（执行计划 P0-5 要求）：
 * - 幂等创建：同词书已有 active 计划 → 直接返回它（不插行）
 * - 并发撞索引：insertPlan 抛 23505 → 重查返回既有计划
 * - 风险 block / warn：block 抛 BusinessRuleError 且携带 { need, left, perRound }；
 *   warn 正常创建（计划页持续显示缺口）
 * - abandon 幂等：已 abandoned 返回现状；已 completed → 409 语义错误
 * - 跨用户隔离：他人词书 → NotFoundError；他人计划 → NotFoundError
 * - suspendReview=true 本期拒绝（HULU_SUSPEND_NOT_YET）
 * - 零 FSRS：服务代码不出现 review_logs / user_word_progress / review.service
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRepositories } from "@/repositories/interfaces";
import { BusinessRuleError, HuluPageAliveMismatchError, NotFoundError, ValidationError } from "@/errors";
import type { HuluPageWordItem, HuluPlanRow, HuluRoundRow } from "@/domain/hulu-sprint";

const mockRepos: Partial<IRepositories> = {};
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

import { HuluPlanService } from "@/services/hulu-plan.service";
import { readFileSync } from "node:fs";

const USER = "00000000-0000-4000-8000-0000000000a1";
const OTHER_USER = "00000000-0000-4000-8000-0000000000a2";
const WB = "00000000-0000-4000-8000-0000000000b1";
const PLAN = "00000000-0000-4000-8000-0000000000c1";
const TODAY = "2026-10-06";

function planRow(overrides: Partial<HuluPlanRow> = {}): HuluPlanRow {
  return {
    id: PLAN,
    user_id: USER,
    wordbook_id: WB,
    direction: null,
    exam_date: "2026-12-20",
    target_rounds: 4,
    page_size: 20,
    gate_ratio: 0.8,
    word_ids: ["w-1", "w-2"],
    status: "active",
    suspend_review: false,
    suspend_snapshot: null,
    started_at: "2026-10-06T00:00:00Z",
    ended_at: null,
    created_at: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}

function roundRow(overrides: Partial<HuluRoundRow> = {}): HuluRoundRow {
  return {
    id: "round-1",
    plan_id: PLAN,
    user_id: USER,
    round_no: 1,
    started_at: "2026-10-06T00:00:00Z",
    ended_at: null,
    elapsed_seconds: null,
    pages_passed: 0,
    words_passed: 0,
    words_total: 2,
    ...overrides,
  };
}

/** 生成 n 个稳定 wordId（定格取词的桩返回）。 */
function wordIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
}

/**
 * 页载荷词卡的桩（R10 扩字段后：卡面五层要的列都在）。
 * 只需给关心的字段，其余按空值补齐 —— 用例读起来才不被 15 列淹掉。
 */
type PageWordStub = { id: string } & Partial<Omit<HuluPageWordItem, "id">>;

function pageWordStub(stub: PageWordStub): HuluPageWordItem {
  return {
    slug: stub.id,
    title: stub.id,
    lemma: stub.id,
    ipa: null,
    pos: null,
    cefr: null,
    short_definition: null,
    core_definitions: [],
    definition_md: "",
    examples: [],
    prototype_text: null,
    mnemonic_text: null,
    mnemonic_type: null,
    semantic_chain: null,
    ...stub,
  };
}

/**
 * `findHuluPageWords` 的桩语义：**只回返在册的 id**（模拟 DB 的存活过滤），
 * 其余 id 视为已删 —— 服务层的 alive 复算与「只缩不换」都依赖这个语义。
 */
function pageWords(ids: string[], words: PageWordStub[]): HuluPageWordItem[] {
  const byId = new Map(words.map((word) => [word.id, word]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => pageWordStub(byId.get(id)!));
}

/** 固定墙钟（服务层 now 注入；轮次起止时刻的唯一来源）。 */
const NOW = new Date("2026-10-06T10:00:00.000Z");

function setup(options: {
  owned?: boolean;
  activePlan?: HuluPlanRow | null;
  ids?: string[];
  insertPlan?: (input: unknown) => Promise<HuluPlanRow>;
  planById?: HuluPlanRow | null;
  rounds?: HuluRoundRow[];
  lockedPlan?: HuluPlanRow | null;
  statusUpdated?: HuluPlanRow | null;
  today?: string;
  openRound?: HuluRoundRow | null;
  roundByNo?: HuluRoundRow | null;
  insertedRound?: HuluRoundRow;
  settledRow?: HuluRoundRow | null;
  finishedRow?: HuluRoundRow | null;
  words?: PageWordStub[];
  /** 挂起开关的桩：bulkSuspendByWordIds 回返的逐行快照。 */
  suspended?: Array<{ wordId: string; oldState: string }>;
  /** 恢复桩的回写行数。 */
  restoredCount?: number;
  /** saveSuspendSnapshot 的桩（缺省回返带快照的计划行）。 */
  savedSnapshot?: HuluPlanRow | null;
} = {}) {
  const hulu = {
    insertPlan: vi.fn(options.insertPlan ?? (async () => planRow())),
    findPlanById: vi.fn(async () => options.planById === undefined ? planRow() : options.planById),
    lockPlanForUpdate: vi.fn(async () => options.lockedPlan === undefined ? planRow() : options.lockedPlan),
    findActivePlanByWordbook: vi.fn(async () => options.activePlan ?? null),
    setPlanStatus: vi.fn(async () => options.statusUpdated === undefined ? planRow({ status: "abandoned" }) : options.statusUpdated),
    saveSuspendSnapshot: vi.fn(async () => options.savedSnapshot === undefined
      ? planRow({ suspend_review: true, suspend_snapshot: { "w-1": "review" } })
      : options.savedSnapshot),
    findRoundsByPlan: vi.fn(async () => options.rounds ?? []),
    insertRound: vi.fn(async () => options.insertedRound ?? roundRow()),
    findOpenRound: vi.fn(async () => options.openRound ?? null),
    findRoundByNo: vi.fn(async () => options.roundByNo ?? null),
    settlePage: vi.fn(async () => options.settledRow === undefined
      ? roundRow({ pages_passed: 1, words_passed: 18 })
      : options.settledRow),
    finishRound: vi.fn(async () => options.finishedRow === undefined
      ? roundRow({ ended_at: "2026-10-06T10:00:00Z", elapsed_seconds: 3600 })
      : options.finishedRow),
    assertWordbookOwned: vi.fn(async () => options.owned ?? true),
    listReviewDeckWordIds: vi.fn(async () => options.ids ?? wordIds(400)),
    findHuluPageWords: vi.fn(async (ids: string[]) =>
      pageWords(ids, options.words ?? [])),
    findTodayKeyInDisplayTz: vi.fn(() => options.today ?? TODAY),
  };
  const reviews = {
    findWordsByIds: vi.fn(async () => options.words ?? []),
    bulkSuspendByWordIds: vi.fn(async () => options.suspended ?? []),
    restoreSuspendSnapshot: vi.fn(async () => options.restoredCount ?? 0),
  };
  mockRepos.hulu = hulu as never;
  mockRepos.reviews = reviews as never;

  const service = new HuluPlanService({
    todayKey: (repos) => repos.hulu.findTodayKeyInDisplayTz(),
    now: () => NOW,
  });
  return { service, hulu, reviews };
}

beforeEach(() => {
  Object.keys(mockRepos).forEach((key) => delete (mockRepos as Record<string, unknown>)[key]);
});

describe("HuluPlanService.createPlan", () => {
  it("创建成功：定格取词 + 默认值落库（4 轮 / 20 页 / 0.8 闸门 / 不挂起）", async () => {
    const { service, hulu } = setup({ ids: wordIds(100) });

    const row = await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });

    expect(row.id).toBe(PLAN);
    expect(hulu.assertWordbookOwned).toHaveBeenCalledWith(USER, WB);
    expect(hulu.listReviewDeckWordIds).toHaveBeenCalledWith(USER, WB);
    expect(hulu.insertPlan).toHaveBeenCalledWith({
      user_id: USER,
      wordbook_id: WB,
      direction: null,
      exam_date: "2026-12-20",
      target_rounds: 4,
      page_size: 20,
      gate_ratio: 0.8,
      word_ids: wordIds(100),
      suspend_review: false,
      suspend_snapshot: null,
    });
  });

  it("幂等创建：同词书已有 active 计划 → 直接返回它，不插行、不定格取词", async () => {
    const existing = planRow({ id: "plan-existing" });
    const { service, hulu } = setup({ activePlan: existing });

    const row = await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });

    expect(row.id).toBe("plan-existing");
    expect(hulu.insertPlan).not.toHaveBeenCalled();
    // 幂等分支在定格取词之前返回（省一次读）
    expect(hulu.listReviewDeckWordIds).not.toHaveBeenCalled();
  });

  it("并发撞唯一索引：insertPlan 抛 23505 → 重查并返回既有计划", async () => {
    const raced = planRow({ id: "plan-raced" });
    let call = 0;
    const { service, hulu } = setup({
      insertPlan: async () => {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      },
    });
    // 第一次 findActivePlanByWordbook 返回 null（并发前），重查返回 raced
    hulu.findActivePlanByWordbook.mockImplementation(async () => {
      call += 1;
      return call === 1 ? null : raced;
    });

    const row = await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });

    expect(row.id).toBe("plan-raced");
    expect(hulu.findActivePlanByWordbook).toHaveBeenCalledTimes(2);
  });

  it("撞索引但重查也查不到（计划被放弃）→ 原错误透出", async () => {
    const violation = Object.assign(new Error("duplicate key"), { code: "23505" });
    const { service } = setup({ insertPlan: async () => { throw violation; } });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow(/duplicate key/);
  });

  it("非唯一索引错误原样透出（不被吞成幂等）", async () => {
    const other = Object.assign(new Error("foreign key violation"), { code: "23503" });
    const { service } = setup({ insertPlan: async () => { throw other; } });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow(/foreign key/);
  });

  it("跨用户隔离：他人词书 → NotFoundError（不泄露存在性）", async () => {
    const { service, hulu } = setup({ owned: false });

    await expect(service.createPlan({ userId: OTHER_USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow(NotFoundError);
    expect(hulu.insertPlan).not.toHaveBeenCalled();
  });

  it("空牌堆（该词书没有已评分过的词）→ BusinessRuleError 带先学后刷文案（R9）", async () => {
    const { service, hulu } = setup({ ids: [] });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow("该词书还没有可冲刺的词——先去标准复习，至少复习过一次再回来。");
    // 422 语义（BusinessRuleError）且不插行
    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toMatchObject({ httpStatus: 422 });
    expect(hulu.insertPlan).not.toHaveBeenCalled();
  });

  it("定格源是复习牌堆（listReviewDeckWordIds），不再是 wordbook_items 的旧读法", async () => {
    const { service, hulu } = setup({ ids: wordIds(10) });

    await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });

    expect(hulu.listReviewDeckWordIds).toHaveBeenCalledWith(USER, WB);
    expect(hulu).not.toHaveProperty("listWordIdsByWordbook");
  });

  it("new 不入池：定格词集只含仓库回返的复习牌堆（服务层不自行补词、不放大）", async () => {
    // 桩回返的就是「复习牌堆」——池的构成由仓库的 state 白名单决定（见仓库测试），
    // 服务层只按原样定格：多一个词、少一个词都会在这里露馅。
    const deck = wordIds(3);
    const { service, hulu } = setup({ ids: deck });

    await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });

    expect(hulu.insertPlan).toHaveBeenCalledWith(expect.objectContaining({ word_ids: deck }));
    expect(deck).toHaveLength(3);
  });

  it("考试日期已过或就是今天 → 422（BusinessRuleError）", async () => {
    const { service } = setup({ today: "2026-12-20" });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow(/考试日期已过/);
    // 前一天也不行
    const { service: past } = setup({ today: "2026-12-21" });
    await expect(past.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow(BusinessRuleError);
  });

  it("suspendReview=true：同一事务挂起 + 快照落库（P2 接线，不再拒绝）", async () => {
    const suspended = [
      { wordId: "w-1", oldState: "review" },
      { wordId: "w-2", oldState: "new" },
    ];
    const { service, hulu, reviews } = setup({ ids: ["w-1", "w-2"], suspended });

    const row = await service.createPlan({
      userId: USER, wordbookId: WB, examDate: "2026-12-20", suspendReview: true,
    });

    // ① 计划行按开关写 suspend_review=true（快照列先留空，随后同事务落库）
    expect(hulu.insertPlan).toHaveBeenCalledWith(expect.objectContaining({
      suspend_review: true,
      suspend_snapshot: null,
    }));
    // ② 挂起走 ReviewRepository（第 9 个 state 写点），范围 = 定格 word_ids
    expect(reviews.bulkSuspendByWordIds).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      wordIds: ["w-1", "w-2"],
    });
    // ③ 逐行「挂起前 state」写进计划行的 suspend_snapshot
    expect(hulu.saveSuspendSnapshot).toHaveBeenCalledWith(USER, PLAN, {
      "w-1": "review",
      "w-2": "new",
    });
    // ④ 出参摘要带 suspended_count
    expect(row.suspend_review).toBe(true);
    expect(row.suspended_count).toBe(1);
  });

  it("suspendReview 缺省（关）：不挂起、不写快照（默认关是有意的）", async () => {
    const { service, hulu, reviews } = setup();

    await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });

    expect(hulu.insertPlan).toHaveBeenCalledWith(expect.objectContaining({ suspend_review: false }));
    expect(reviews.bulkSuspendByWordIds).not.toHaveBeenCalled();
    expect(hulu.saveSuspendSnapshot).not.toHaveBeenCalled();
  });

  it("suspendReview=true 但幂等命中既有计划：不重复挂起（既有计划自带快照）", async () => {
    const existing = planRow({ suspend_review: true, suspend_snapshot: { "w-1": "review" } });
    const { service, hulu, reviews } = setup({ activePlan: existing });

    const row = await service.createPlan({
      userId: USER, wordbookId: WB, examDate: "2026-12-20", suspendReview: true,
    });

    expect(row.id).toBe(existing.id);
    expect(reviews.bulkSuspendByWordIds).not.toHaveBeenCalled();
    expect(hulu.saveSuspendSnapshot).not.toHaveBeenCalled();
  });

  it("入参越界一律 ValidationError（轮数/页数/闸门/日期形状）", async () => {
    const { service } = setup();

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20", targetRounds: 9 }))
      .rejects.toThrow(/targetRounds/);
    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20", pageSize: 4 }))
      .rejects.toThrow(/pageSize/);
    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20", gateRatio: 1.01 }))
      .rejects.toThrow(/gateRatio/);
    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026/12/20" }))
      .rejects.toThrow(/examDate/);
    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20", direction: "日语" }))
      .rejects.toThrow(/direction/);
  });

  it("风险 warn：放行创建（计划页持续显示缺口）", async () => {
    // 4000 词 → 10 天/轮；4 轮 → 40 天；今天 2026-10-06 → 考试 2026-11-15（40 天）
    const { service, hulu } = setup({ ids: wordIds(4000), today: "2026-10-06" });

    const row = await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-11-15" });

    expect(row.id).toBe(PLAN);
    expect(hulu.insertPlan).toHaveBeenCalledTimes(1);
  });

  it("风险 block：422 且 details 携带 { need, left, perRound }", async () => {
    // 4000 词 → perRound 10；4 轮 → need 40；考试日 2026-10-20 → left 14（40 > 28）→ block
    const { service, hulu } = setup({ ids: wordIds(4000), today: "2026-10-06" });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-10-20" }))
      .rejects.toMatchObject({
        httpStatus: 422,
        meta: { need: 40, left: 14, perRound: 10 },
      });
    expect(hulu.insertPlan).not.toHaveBeenCalled();
  });

  it("风险边界：need === left × 2 恰好值放行（warn），超过才 block", async () => {
    // 4000 词 → perRound 10；4 轮 → need 40；left=20 → 40 === 40 → warn 放行
    const ok = setup({ ids: wordIds(4000), today: "2026-10-06" });
    await expect(ok.service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-11-15" })).resolves.toBeTruthy();

    // left=19（考试 2026-10-25）→ 40 > 38 → block
    const blocked = setup({ ids: wordIds(4000), today: "2026-10-06" });
    await expect(blocked.service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-10-25" }))
      .rejects.toThrow(BusinessRuleError);
  });

  it("词数超上限 → BusinessRuleError（不插行）", async () => {
    const { service, hulu } = setup({ ids: wordIds(20001), today: "2026-01-01" });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2030-01-01" }))
      .rejects.toThrow(/词数超出上限/);
    expect(hulu.insertPlan).not.toHaveBeenCalled();
  });

  it("direction 是合法三值时原样落库（仅标签，不过滤词集）", async () => {
    const { service, hulu } = setup({ ids: wordIds(10) });

    await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20", direction: "考研" });

    expect(hulu.insertPlan).toHaveBeenCalledWith(expect.objectContaining({ direction: "考研" }));
    // 词集不因 direction 变化（R6：整本词书）
    expect(hulu.listReviewDeckWordIds).toHaveBeenCalledWith(USER, WB);
  });
});

describe("HuluPlanService.getPlan", () => {
  it("返回计划 + 轮次（缩时曲线的唯一数据源）", async () => {
    const rounds = [roundRow({ round_no: 1 }), roundRow({ id: "round-2", round_no: 2, ended_at: "2026-10-07T00:00:00Z", elapsed_seconds: 3600 })];
    const { service, hulu } = setup({ rounds });

    const result = await service.getPlan({ userId: USER, planId: PLAN });

    expect(result.plan.id).toBe(PLAN);
    expect(result.rounds).toHaveLength(2);
    expect(hulu.findRoundsByPlan).toHaveBeenCalledWith(USER, PLAN);
  });

  it("计划不存在 → NotFoundError", async () => {
    const { service } = setup({ planById: null });

    await expect(service.getPlan({ userId: USER, planId: PLAN })).rejects.toThrow(NotFoundError);
  });

  it("空 planId → ValidationError", async () => {
    const { service } = setup();
    await expect(service.getPlan({ userId: USER, planId: "" })).rejects.toThrow(ValidationError);
  });
});

describe("HuluPlanService.abandonPlan", () => {
  it("active → abandoned（写 ended_at）", async () => {
    const { service, hulu } = setup({ lockedPlan: planRow({ status: "active" }) });

    const row = await service.abandonPlan({ userId: USER, planId: PLAN });

    expect(row.status).toBe("abandoned");
    expect(hulu.setPlanStatus).toHaveBeenCalledWith(USER, PLAN, "abandoned", { ended: true });
  });

  it("已 abandoned → 幂等返回现状（不再写）", async () => {
    const already = planRow({ status: "abandoned", ended_at: "2026-10-07T00:00:00Z" });
    const { service, hulu } = setup({ lockedPlan: already });

    const row = await service.abandonPlan({ userId: USER, planId: PLAN });

    // P1 起出参是**摘要**（全量 word_ids / suspend_snapshot 折叠成计数），
    // 故不再按对象身份断言，改按投影后的值与 status 断言。
    expect(row).toMatchObject({ id: already.id, status: "abandoned", word_count: 2, suspended_count: 0 });
    expect(hulu.setPlanStatus).not.toHaveBeenCalled();
  });

  it("已 completed → 409 语义错误（BusinessRuleError）", async () => {
    const { service, hulu } = setup({ lockedPlan: planRow({ status: "completed" }) });

    await expect(service.abandonPlan({ userId: USER, planId: PLAN }))
      .rejects.toMatchObject({ httpStatus: 422 });
    await expect(service.abandonPlan({ userId: USER, planId: PLAN })).rejects.toThrow(/已完成/);
    expect(hulu.setPlanStatus).not.toHaveBeenCalled();
  });

  it("跨用户隔离：他人计划 → NotFoundError（加锁读也钉 owner）", async () => {
    const { service, hulu } = setup({ lockedPlan: null });

    await expect(service.abandonPlan({ userId: OTHER_USER, planId: PLAN })).rejects.toThrow(NotFoundError);
    expect(hulu.lockPlanForUpdate).toHaveBeenCalledWith(OTHER_USER, PLAN);
    expect(hulu.setPlanStatus).not.toHaveBeenCalled();
  });

  it("setPlanStatus 无返回行（并发删除）→ NotFoundError", async () => {
    const { service } = setup({ lockedPlan: planRow({ status: "active" }), statusUpdated: null });

    await expect(service.abandonPlan({ userId: USER, planId: PLAN })).rejects.toThrow(NotFoundError);
  });
});

describe("HuluPlanService 事务与红线", () => {
  it("全部写路径经 withTransaction + actorId（owner RLS 表）", async () => {
    const { withTransaction } = await import("@/db/transaction");
    const spy = withTransaction as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    const { service } = setup();

    await service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" });
    await service.getPlan({ userId: USER, planId: PLAN });
    await service.abandonPlan({ userId: USER, planId: PLAN });

    for (const call of spy.mock.calls) {
      expect(call[1]).toEqual({ actorId: USER });
    }
  });

  it("零 FSRS：服务源码不出现 review_logs / user_word_progress / review.service", () => {
    const source = readFileSync(
      new URL("../../src/services/hulu-plan.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("review_logs");
    expect(source).not.toContain("user_word_progress");
    expect(source).not.toContain("review.service");
    expect(source).not.toContain("submitAnswer");
  });
});

describe("HuluPlanService.getPlanPage（R4 页载荷 / R10 卡面全字段）", () => {
  const PAGE_WORDS: PageWordStub[] = [
    { id: "w-a", slug: "alpha", title: "alpha", lemma: "alpha", ipa: "/a/", pos: "n.", short_definition: "甲", mnemonic_text: "m-a" },
    { id: "w-b", slug: "bravo", title: "bravo", lemma: "bravo", ipa: null, pos: null, short_definition: "乙", mnemonic_text: null },
  ];

  it("按定格切片取词并按切片序重排；字段是 R10 的卡面全清单", async () => {
    // 定格 3 词 / page_size 2 → 第 0 页 = [w-a, w-b]，第 1 页 = [w-c]
    const ids = ["w-a", "w-b", "w-c"];
    const { service } = setup({
      planById: planRow({ word_ids: ids, page_size: 2 }),
      // 仓库返回**乱序**（DB 不保证序）：服务层须按切片序重排
      words: [
        { id: "w-b", slug: "bravo", title: "bravo", lemma: "bravo", ipa: null, pos: null, short_definition: "乙", mnemonic_text: null },
        { id: "w-a", slug: "alpha", title: "alpha", lemma: "alpha", ipa: "/a/", pos: "n.", short_definition: "甲", mnemonic_text: "m-a" },
      ],
    });

    const page = await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });

    expect(page.pageIndex).toBe(0);
    expect(page.pages).toBe(2);
    expect(page.total).toBe(3);
    expect(page.alive).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(["w-a", "w-b"]);
    // R10：卡面五层要的 15 列都在（不再是 8 列裁剪 —— 单卡零请求靠它们）
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      "cefr", "core_definitions", "definition_md", "examples", "id", "ipa",
      "lemma", "mnemonic_text", "mnemonic_type", "pos", "prototype_text",
      "semantic_chain", "short_definition", "slug", "title",
    ]);
  });

  it("R10：义项 / 例句 / 语义链等卡面字段原样透传（按切片序重排后仍对齐）", async () => {
    const { service } = setup({
      planById: planRow({ word_ids: ["w-a", "w-b"], page_size: 2 }),
      words: [
        {
          id: "w-a", short_definition: "甲", definition_md: "1. 甲",
          core_definitions: [
            { sense: "甲", en: "alpha", priority: 1, tags: ["core"] },
            { sense: "首要的", en: null, priority: 2, tags: [] },
          ],
          examples: [{ text: "Alpha is first.", translation: "甲是第一个" }],
          prototype_text: "第一个", mnemonic_text: "a 开头", mnemonic_type: "联想",
          semantic_chain: "aleph → alpha", cefr: "A1",
        },
        { id: "w-b", short_definition: "乙", definition_md: "1. 乙" },
      ],
    });

    const page = await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });
    const [first, second] = page.items;

    expect(first!.core_definitions.map((sense) => sense.sense)).toEqual(["甲", "首要的"]);
    expect(first!.examples).toEqual([{ text: "Alpha is first.", translation: "甲是第一个" }]);
    expect(first!.semantic_chain).toBe("aleph → alpha");
    expect(first!.mnemonic_type).toBe("联想");
    expect(first!.prototype_text).toBe("第一个");
    expect(first!.cefr).toBe("A1");
    // 无 core_definitions 的词给空数组（前端据此走 definition_md 降级）
    expect(second!.core_definitions).toEqual([]);
    expect(second!.definition_md).toBe("1. 乙");
  });

  it("取词走 hulu.findHuluPageWords（页载荷的唯一取数方式），不再用 reviews.findWordsByIds", async () => {
    const { service, hulu, reviews } = setup({
      planById: planRow({ word_ids: ["w-a"], page_size: 2 }),
      words: PAGE_WORDS,
    });

    await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });

    expect(hulu.findHuluPageWords).toHaveBeenCalledWith(["w-a"]);
    // findWordsByIds 是 preview 队列的取数口，葫芦页载荷不再碰它（也不动它的实现）
    expect(reviews.findWordsByIds).not.toHaveBeenCalled();
  });

  it("删词只缩不换：切片位置不变，已删词从 items 消失（alive < total）", async () => {
    const ids = ["w-a", "w-b", "w-c"];
    const { service } = setup({
      planById: planRow({ word_ids: ids, page_size: 2 }),
      // w-a 已删（仓库不返回）→ items 只有 w-b
      words: [
        { id: "w-b", slug: "bravo", title: "bravo", lemma: "bravo", ipa: null, pos: null, short_definition: "乙", mnemonic_text: null },
      ],
    });

    const page = await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });

    expect(page.total).toBe(3); // 定格词数不变
    expect(page.alive).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual(["w-b"]);
    expect(page.pages).toBe(2); // 页数只依定格，与删除无关
  });

  it("整页删空 → alive = 0 且 items 为空（合法页，非 404）", async () => {
    const { service } = setup({
      planById: planRow({ word_ids: ["w-a", "w-b"], page_size: 2 }),
      words: [],
    });

    const page = await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });

    expect(page.alive).toBe(0);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(2);
  });

  it("越界页 → NotFoundError（不存在的页，不是空页）", async () => {
    const { service } = setup({ planById: planRow({ word_ids: ["w-a", "w-b"], page_size: 2 }) });

    await expect(service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 1 })).rejects.toThrow(NotFoundError);
    await expect(service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 99 })).rejects.toThrow(NotFoundError);
  });

  it("计划不存在 → NotFoundError；负页号 → ValidationError", async () => {
    const missing = setup({ planById: null });
    await expect(missing.service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 }))
      .rejects.toThrow(NotFoundError);

    const { service } = setup();
    await expect(service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: -1 }))
      .rejects.toThrow(ValidationError);
  });
});

describe("HuluPlanService.startRound（轮次开始）", () => {
  it("首轮：round_no = 已有轮数 + 1，words_total = 定格词数，started_at 缺省 now()", async () => {
    const { service, hulu } = setup({ planById: planRow({ word_ids: ["w-a", "w-b"] }), rounds: [] });

    const round = await service.startRound({ userId: USER, planId: PLAN });

    expect(round.round_no).toBe(1);
    expect(hulu.insertRound).toHaveBeenCalledWith({
      plan_id: PLAN,
      user_id: USER,
      round_no: 1,
      started_at: NOW.toISOString(),
      words_total: 2,
    });
  });

  it("幂等：已有未收尾轮 → 返回它，不新建", async () => {
    const open = roundRow({ round_no: 2, id: "round-2" });
    const { service, hulu } = setup({ openRound: open });

    const round = await service.startRound({ userId: USER, planId: PLAN });

    expect(round).toBe(open);
    expect(hulu.insertRound).not.toHaveBeenCalled();
  });

  it("超过目标轮数 → ConflictError（409）", async () => {
    const { service, hulu } = setup({
      planById: planRow({ target_rounds: 4 }),
      rounds: [roundRow({ round_no: 1 }), roundRow({ round_no: 2, id: "r2" }), roundRow({ round_no: 3, id: "r3" }), roundRow({ round_no: 4, id: "r4" })],
    });

    await expect(service.startRound({ userId: USER, planId: PLAN }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect(hulu.insertRound).not.toHaveBeenCalled();
  });

  it("计划非 active（completed/abandoned）→ ConflictError（409）", async () => {
    const completed = setup({ lockedPlan: planRow({ status: "completed" }) });
    await expect(completed.service.startRound({ userId: USER, planId: PLAN }))
      .rejects.toMatchObject({ httpStatus: 409 });

    const abandoned = setup({ lockedPlan: planRow({ status: "abandoned" }) });
    await expect(abandoned.service.startRound({ userId: USER, planId: PLAN }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it("startedAt 越界夹取到 [now - 7 天, now]（未来 → now，过旧 → 下界）", async () => {
    const future = setup({ rounds: [] });
    await future.service.startRound({ userId: USER, planId: PLAN, startedAt: "2030-01-01T00:00:00.000Z" });
    expect(future.hulu.insertRound).toHaveBeenCalledWith(
      expect.objectContaining({ started_at: NOW.toISOString() }),
    );

    const ancient = setup({ rounds: [] });
    await ancient.service.startRound({ userId: USER, planId: PLAN, startedAt: "2000-01-01T00:00:00.000Z" });
    const expectedFloor = new Date(NOW.getTime() - 7 * 86400 * 1000).toISOString();
    expect(ancient.hulu.insertRound).toHaveBeenCalledWith(
      expect.objectContaining({ started_at: expectedFloor }),
    );
  });

  it("startedAt 形状非法 → ValidationError；计划不存在 → NotFoundError", async () => {
    const { service } = setup({ rounds: [] });
    await expect(service.startRound({ userId: USER, planId: PLAN, startedAt: "yesterday" }))
      .rejects.toThrow(ValidationError);

    const missing = setup({ lockedPlan: null });
    await expect(missing.service.startRound({ userId: USER, planId: PLAN })).rejects.toThrow(NotFoundError);
  });
});

describe("HuluPlanService.settlePage（R7 页结算）", () => {
  const ALIVE_WORDS: PageWordStub[] = [
    { id: "w-a", slug: "a", title: "a", lemma: "a" },
    { id: "w-b", slug: "b", title: "b", lemma: "b" },
  ];

  function settleSetup(overrides: {
    gateRatio?: number;
    wordIds?: string[];
    pageSize?: number;
    words?: typeof ALIVE_WORDS;
    settledRow?: HuluRoundRow | null;
    roundByNo?: HuluRoundRow | null;
  } = {}) {
    const ids = overrides.wordIds ?? ["w-a", "w-b"];
    return setup({
      planById: planRow({ word_ids: ids, page_size: overrides.pageSize ?? 20, gate_ratio: overrides.gateRatio ?? 0.8 }),
      roundByNo: overrides.roundByNo === undefined ? roundRow() : overrides.roundByNo,
      settledRow: overrides.settledRow,
      words: overrides.words ?? ALIVE_WORDS,
    });
  }

  it("过闸（读列值）→ 条件 UPDATE 命中，返回更新后的轮次行", async () => {
    const { service, hulu } = settleSetup({ gateRatio: 0.8 });

    const row = await service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 2, total: 2,
    });

    expect(row.pages_passed).toBe(1);
    expect(hulu.settlePage).toHaveBeenCalledWith({
      userId: USER, roundId: "round-1", pageIndex: 0, passed: 2,
    });
  });

  it("闸门读的是**计划行列值**，不是写死的 0.8：0.5 的计划下 1/2 放行", async () => {
    // 同样 50% 通过率：0.8 闸门下被拒（下一用例），0.5 闸门下放行 —— 证明读列值
    const { service, hulu } = settleSetup({ gateRatio: 0.5 });

    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 1, total: 2,
    })).resolves.toBeTruthy();
    expect(hulu.settlePage).toHaveBeenCalledTimes(1);
  });

  it("不过闸 → ValidationError（422），不发条件 UPDATE", async () => {
    const { service, hulu } = settleSetup({ gateRatio: 0.8 });

    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 1, total: 2,
    })).rejects.toMatchObject({ httpStatus: 422 });
    expect(hulu.settlePage).not.toHaveBeenCalled();
  });

  it("闸门边界：恰等于 gate_ratio 放行，差 0.01 拒绝", async () => {
    // 20 词 / 0.8 → 16 通过恰好放行；15 通过（0.75）拒绝
    const ids = wordIds(20);
    const twenty: PageWordStub[] = ids.map((id, i) => ({
      id, slug: `w${i}`, title: `w${i}`, lemma: `w${i}`,
    }));

    const pass = settleSetup({ gateRatio: 0.8, wordIds: ids, words: twenty });
    await expect(pass.service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 16, total: 20,
    })).resolves.toBeTruthy();

    const block = settleSetup({ gateRatio: 0.8, wordIds: ids, words: twenty });
    await expect(block.service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 15, total: 20,
    })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it("total 必须等于本页存活词数（不符 → 422 + HULU_PAGE_ALIVE_MISMATCH 机器码）", async () => {
    const { service, hulu } = settleSetup();

    // D1（R11）：HTTP 语义仍是 422，但机器码是稳定码（前端据此自动重取本页）
    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 2, total: 3,
    })).rejects.toMatchObject({
      httpStatus: 422,
      code: "HULU_PAGE_ALIVE_MISMATCH",
      message: expect.stringMatching(/存活词数/),
    });
    // 该路径**不落库**：条件 UPDATE 一次都没发
    expect(hulu.settlePage).not.toHaveBeenCalled();
  });

  it("D1 反向：total 等于存活数时照常结算（机器码只挂在漂移路径上）", async () => {
    const { service, hulu } = settleSetup();

    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 2, total: 2,
    })).resolves.toBeTruthy();
    expect(hulu.settlePage).toHaveBeenCalledTimes(1);
  });

  it("D1 归因信息：details 带出 { total, alive, pageIndex }", async () => {
    const { service } = settleSetup();

    const error = await service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 1, total: 3,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HuluPageAliveMismatchError);
    expect((error as HuluPageAliveMismatchError).meta).toEqual({ total: 3, alive: 2, pageIndex: 0 });
  });

  it("alive = 0（整页删空）→ total = 0 合法且自动通过", async () => {
    const { service, hulu } = settleSetup({ words: [] });

    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 0, total: 0,
    })).resolves.toBeTruthy();
    expect(hulu.settlePage).toHaveBeenCalledWith({
      userId: USER, roundId: "round-1", pageIndex: 0, passed: 0,
    });
  });

  it("重复提交（条件 UPDATE 未命中且游标已推进）→ 幂等返回现状，不重复计数", async () => {
    // 定格 40 词 / 每页 20 → 2 页；提交第 1 页（第 2 页）时游标已在 2 → 幂等
    const ids = wordIds(40);
    const page1: PageWordStub[] = ids.slice(20, 40).map((id, i) => ({
      id, slug: `w${20 + i}`, title: `w${20 + i}`, lemma: `w${20 + i}`,
    }));
    const current = roundRow({ pages_passed: 2, words_passed: 36 });
    const { service, hulu } = settleSetup({
      wordIds: ids, words: page1, settledRow: null, roundByNo: current,
    });

    const row = await service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 1, passed: 20, total: 20,
    });

    expect(row).toBe(current);
    expect(row.pages_passed).toBe(2);
    // R7 的幂等来自 WHERE 谓词不匹配（游标已推进），而非「跳过 UPDATE」：
    // 条件 UPDATE 照发一次，rowcount = 0 → 读游标分流为幂等。
    expect(hulu.settlePage).toHaveBeenCalledTimes(1);
  });

  it("跳页（游标落后于提交页）→ ConflictError（409）", async () => {
    // 同上：第 1 页合法（alive = 20），但游标停在 0 → 跳页
    const ids = wordIds(40);
    const page1: PageWordStub[] = ids.slice(20, 40).map((id, i) => ({
      id, slug: `w${20 + i}`, title: `w${20 + i}`, lemma: `w${20 + i}`,
    }));
    const current = roundRow({ pages_passed: 0 });
    const { service, hulu } = settleSetup({
      wordIds: ids, words: page1, settledRow: null, roundByNo: current,
    });

    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 1, passed: 20, total: 20,
    })).rejects.toMatchObject({ httpStatus: 409 });
    expect(hulu.settlePage).toHaveBeenCalledTimes(1); // 条件 UPDATE 发过但未命中
  });

  it("轮次不存在 → NotFoundError；负 pageIndex / passed / total → ValidationError", async () => {
    const noRound = settleSetup({ roundByNo: null });
    await expect(noRound.service.settlePage({
      userId: USER, planId: PLAN, roundNo: 9, pageIndex: 0, passed: 0, total: 0,
    })).rejects.toThrow(NotFoundError);

    const { service, hulu } = settleSetup();
    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: -1, passed: 0, total: 0,
    })).rejects.toThrow(ValidationError);
    await expect(service.settlePage({
      userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: -1, total: 0,
    })).rejects.toThrow(ValidationError);
    expect(hulu.settlePage).not.toHaveBeenCalled();
  });
});

describe("HuluPlanService.finishRound（轮收尾）", () => {
  it("墙钟耗时夹取后写入（ended - started）", async () => {
    // started 2026-10-06T09:00:00Z，now 10:00:00Z → 3600 秒
    const started = roundRow({ started_at: "2026-10-06T09:00:00Z" });
    const { service, hulu } = setup({ roundByNo: started });

    const row = await service.finishRound({ userId: USER, planId: PLAN, roundNo: 1 });

    expect(row.elapsed_seconds).toBe(3600);
    expect(hulu.finishRound).toHaveBeenCalledWith({
      userId: USER,
      roundId: "round-1",
      endedAt: NOW.toISOString(),
      elapsedSeconds: 3600,
    });
  });

  it("耗时超上限（7 天）夹取，不报错、不丢轮", async () => {
    const started = roundRow({ started_at: "2020-01-01T00:00:00Z" });
    const { service, hulu } = setup({ roundByNo: started });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 1 });

    expect(hulu.finishRound).toHaveBeenCalledWith(
      expect.objectContaining({ elapsedSeconds: 7 * 86400 }),
    );
  });

  it("已收尾 → 幂等返回现状（不重写耗时）", async () => {
    const done = roundRow({ ended_at: "2026-10-06T09:30:00Z", elapsed_seconds: 1800 });
    const { service, hulu } = setup({ roundByNo: done });

    const row = await service.finishRound({ userId: USER, planId: PLAN, roundNo: 1 });

    expect(row).toBe(done);
    expect(hulu.finishRound).not.toHaveBeenCalled();
  });

  it("末轮 → 同事务把计划置 completed", async () => {
    const last = roundRow({ round_no: 4 });
    const { service, hulu } = setup({
      lockedPlan: planRow({ target_rounds: 4, status: "active" }),
      roundByNo: last,
      // 条件 UPDATE 的返回行必须是**第 4 轮**（判据取 finished.round_no）
      finishedRow: roundRow({ round_no: 4, ended_at: NOW.toISOString(), elapsed_seconds: 3600 }),
    });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 4 });

    expect(hulu.setPlanStatus).toHaveBeenCalledWith(USER, PLAN, "completed", { ended: true });
  });

  it("非末轮 → 不动计划状态", async () => {
    const { service, hulu } = setup({
      lockedPlan: planRow({ target_rounds: 4, status: "active" }),
      roundByNo: roundRow({ round_no: 2 }),
    });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 2 });

    expect(hulu.setPlanStatus).not.toHaveBeenCalled();
  });

  it("并发双收尾（条件 UPDATE 未命中）→ 幂等返回现状", async () => {
    const fresh = roundRow();
    const raced = roundRow({ ended_at: "2026-10-06T09:59:00Z", elapsed_seconds: 3540 });
    const { service, hulu } = setup({ finishedRow: null });
    let call = 0;
    hulu.findRoundByNo.mockImplementation(async () => {
      call += 1;
      return call === 1 ? fresh : raced;
    });

    const row = await service.finishRound({ userId: USER, planId: PLAN, roundNo: 1 });

    expect(row).toBe(raced);
    expect(hulu.setPlanStatus).not.toHaveBeenCalled();
  });

  it("轮次不存在 → NotFoundError；计划不存在 → NotFoundError", async () => {
    const noRound = setup({ roundByNo: null });
    await expect(noRound.service.finishRound({ userId: USER, planId: PLAN, roundNo: 9 }))
      .rejects.toThrow(NotFoundError);

    const noPlan = setup({ lockedPlan: null });
    await expect(noPlan.service.finishRound({ userId: USER, planId: PLAN, roundNo: 1 }))
      .rejects.toThrow(NotFoundError);
  });

  it("endedAt 越界夹取（未来 → now）", async () => {
    const { service, hulu } = setup({ roundByNo: roundRow({ started_at: "2026-10-06T09:00:00Z" }) });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 1, endedAt: "2030-01-01T00:00:00.000Z" });

    expect(hulu.finishRound).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: NOW.toISOString(), elapsedSeconds: 3600 }),
    );
  });
});

describe("HuluPlanService 挂起恢复（P2：末轮 completed / 放弃 abandoned 同事务回写）", () => {
  const SNAPSHOT = { "w-1": "review", "w-2": "new", "w-3": "learning" };

  it("末轮收尾：同事务恢复快照 + 清 suspend_snapshot", async () => {
    const { service, hulu, reviews } = setup({
      lockedPlan: planRow({ target_rounds: 4, status: "active", suspend_review: true, suspend_snapshot: SNAPSHOT }),
      roundByNo: roundRow({ round_no: 4 }),
      finishedRow: roundRow({ round_no: 4, ended_at: NOW.toISOString(), elapsed_seconds: 3600 }),
    });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 4 });

    // 快照**逐行**回写（不是统一恢复成 review）
    expect(reviews.restoreSuspendSnapshot).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      snapshot: SNAPSHOT,
    });
    // 清快照与置状态同一次调用（同一事务）
    expect(hulu.setPlanStatus).toHaveBeenCalledWith(USER, PLAN, "completed", {
      ended: true,
      suspendSnapshot: null,
    });
  });

  it("非末轮收尾：不恢复、不动计划（挂起要留到计划结束）", async () => {
    const { service, hulu, reviews } = setup({
      lockedPlan: planRow({ target_rounds: 4, status: "active", suspend_review: true, suspend_snapshot: SNAPSHOT }),
      roundByNo: roundRow({ round_no: 2 }),
    });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 2 });

    expect(reviews.restoreSuspendSnapshot).not.toHaveBeenCalled();
    expect(hulu.setPlanStatus).not.toHaveBeenCalled();
  });

  it("未开开关（快照 NULL）：末轮也不调恢复，且不动快照列", async () => {
    const { service, hulu, reviews } = setup({
      lockedPlan: planRow({ target_rounds: 4, status: "active" }),
      roundByNo: roundRow({ round_no: 4 }),
      finishedRow: roundRow({ round_no: 4, ended_at: NOW.toISOString(), elapsed_seconds: 3600 }),
    });

    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 4 });

    expect(reviews.restoreSuspendSnapshot).not.toHaveBeenCalled();
    // 快照本来就是 NULL → 不带 suspendSnapshot（免得白写一次）
    expect(hulu.setPlanStatus).toHaveBeenCalledWith(USER, PLAN, "completed", { ended: true });
  });

  it("放弃计划：同事务恢复快照 + 清 suspend_snapshot", async () => {
    const { service, hulu, reviews } = setup({
      lockedPlan: planRow({ status: "active", suspend_review: true, suspend_snapshot: SNAPSHOT }),
      statusUpdated: planRow({ status: "abandoned" }),
    });

    const row = await service.abandonPlan({ userId: USER, planId: PLAN });

    expect(reviews.restoreSuspendSnapshot).toHaveBeenCalledWith({
      userId: USER,
      wordbookId: WB,
      snapshot: SNAPSHOT,
    });
    expect(hulu.setPlanStatus).toHaveBeenCalledWith(USER, PLAN, "abandoned", {
      ended: true,
      suspendSnapshot: null,
    });
    expect(row.status).toBe("abandoned");
  });

  it("放弃未开开关的计划：不调恢复", async () => {
    const { service, reviews } = setup({ lockedPlan: planRow({ status: "active" }) });

    await service.abandonPlan({ userId: USER, planId: PLAN });

    expect(reviews.restoreSuspendSnapshot).not.toHaveBeenCalled();
  });

  it("已 abandoned 幂等返回：不重复恢复（快照此时已清空）", async () => {
    const { service, reviews } = setup({
      lockedPlan: planRow({ status: "abandoned", suspend_snapshot: null }),
    });

    await service.abandonPlan({ userId: USER, planId: PLAN });

    expect(reviews.restoreSuspendSnapshot).not.toHaveBeenCalled();
  });

  it("挂起与恢复都不写事件日志：服务层只经 ReviewRepository 的两个方法", () => {
    // 完备设计 测试 10 的结构面：服务源码不出现那两张表/服务的名字。
    const source = readFileSync(
      new URL("../../src/services/hulu-plan.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("review_logs");
    expect(source).not.toContain("user_word_progress");
  });
});

describe("HuluPlanService P1 红线", () => {
  it("P1 四个新方法也走 withTransaction + actorId", async () => {
    const { withTransaction } = await import("@/db/transaction");
    const spy = withTransaction as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    const { service } = setup({
      planById: planRow({ word_ids: ["w-a"] }),
      roundByNo: roundRow(),
      words: [],
    });

    await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });
    await service.startRound({ userId: USER, planId: PLAN });
    await service.settlePage({ userId: USER, planId: PLAN, roundNo: 1, pageIndex: 0, passed: 0, total: 0 });
    await service.finishRound({ userId: USER, planId: PLAN, roundNo: 1 });

    for (const call of spy.mock.calls) {
      expect(call[1]).toEqual({ actorId: USER });
    }
  });

  it("页载荷取词走只读的 hulu.findHuluPageWords（不写 sessions、不锚定默认词书）", async () => {
    const { service } = setup({ planById: planRow({ word_ids: ["w-a"] }), words: [] });
    const repos = mockRepos as { hulu?: { findHuluPageWords?: ReturnType<typeof vi.fn> } };

    await service.getPlanPage({ userId: USER, planId: PLAN, pageIndex: 0 });

    expect(repos.hulu?.findHuluPageWords).toHaveBeenCalledWith(["w-a"]);
    // 绝不触达会写 sessions 的队列构建（wordbooks 服务未被注入/调用）
    expect(mockRepos.wordbooks).toBeUndefined();
  });

  it("零 FSRS：服务源码不出现 review_logs / user_word_progress / review.service", () => {
    const source = readFileSync(
      new URL("../../src/services/hulu-plan.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("review_logs");
    expect(source).not.toContain("user_word_progress");
    expect(source).not.toContain("review.service");
    expect(source).not.toContain("submitAnswer");
  });
});
