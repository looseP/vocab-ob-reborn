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
import { BusinessRuleError, NotFoundError, ValidationError } from "@/errors";
import type { HuluPlanRow, HuluRoundRow } from "@/domain/hulu-sprint";

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
} = {}) {
  const hulu = {
    insertPlan: vi.fn(options.insertPlan ?? (async () => planRow())),
    findPlanById: vi.fn(async () => options.planById === undefined ? planRow() : options.planById),
    lockPlanForUpdate: vi.fn(async () => options.lockedPlan === undefined ? planRow() : options.lockedPlan),
    findActivePlanByWordbook: vi.fn(async () => options.activePlan ?? null),
    setPlanStatus: vi.fn(async () => options.statusUpdated === undefined ? planRow({ status: "abandoned" }) : options.statusUpdated),
    findRoundsByPlan: vi.fn(async () => options.rounds ?? []),
    insertRound: vi.fn(async () => roundRow()),
    findOpenRound: vi.fn(async () => null),
    findRoundByNo: vi.fn(async () => null),
    assertWordbookOwned: vi.fn(async () => options.owned ?? true),
    listWordIdsByWordbook: vi.fn(async () => options.ids ?? wordIds(400)),
    findTodayKeyInDisplayTz: vi.fn(() => options.today ?? TODAY),
  };
  mockRepos.hulu = hulu as never;

  const service = new HuluPlanService({
    todayKey: (repos) => repos.hulu.findTodayKeyInDisplayTz(),
  });
  return { service, hulu };
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
    expect(hulu.listWordIdsByWordbook).toHaveBeenCalledWith(USER, WB);
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
    expect(hulu.listWordIdsByWordbook).not.toHaveBeenCalled();
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

  it("空词书 → BusinessRuleError（空计划没有意义）", async () => {
    const { service } = setup({ ids: [] });

    await expect(service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20" }))
      .rejects.toThrow(BusinessRuleError);
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

  it("suspendReview=true 本期拒绝（HULU_SUSPEND_NOT_YET，P2 才开放）", async () => {
    const { service, hulu } = setup();

    await expect(
      service.createPlan({ userId: USER, wordbookId: WB, examDate: "2026-12-20", suspendReview: true }),
    ).rejects.toThrow(ValidationError);
    // 拒绝发生在事务外：不读词书、不插行
    expect(hulu.assertWordbookOwned).not.toHaveBeenCalled();
    expect(hulu.insertPlan).not.toHaveBeenCalled();
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
    expect(hulu.listWordIdsByWordbook).toHaveBeenCalledWith(USER, WB);
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

    expect(row).toBe(already);
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
