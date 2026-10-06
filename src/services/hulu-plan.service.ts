/**
 * HuluPlanService — 葫芦冲刺计划容器（ADR-0041，完备设计 §三/§五）。
 *
 * 葫芦 = 挂在 L1 词书上的阶段性冲刺计划：整批词按页推进、页级检索闸门、多轮滚动、
 * 只记轮次耗时。本期（P0）只做**计划容器**：创建 / 读取 / 放弃 + 风险校验 + 幂等创建。
 *
 * 红线（ADR-0041 / 执行计划 P0 验收）：
 *   - **零 FSRS 写入**：本服务不触碰复习写入面（事件日志、进度表、复习服务、
 *     评分提交）—— 服务层只调 hulu 仓库与纯函数；挂起能力经 ReviewRepository 的
 *     方法调用，且本期**不接线**（suspendReview=true 直接拒绝）。为把这条纪律做成
 *     可机检的，本文件刻意**不出现**那几张表/服务的名字（完备设计 测试 10 的 grep）。
 *   - **不改已有表**：只写 hulu_plans / hulu_rounds。
 *   - 词集**创建时定格**（整本词书；direction 仅标签不过滤 —— R6）。
 *
 * 事务：所有方法（含只读）都经 withTransaction + actorId —— hulu_plans /
 * hulu_rounds 是 owner-RLS 表，读也要带 actor。
 */

import type { PoolClient } from "pg";
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { isUniqueViolation } from "../repositories/hulu.repository";
import {
  assessHuluRisk,
  clampElapsedSeconds,
  HULU_DEFAULT_GATE_RATIO,
  HULU_DEFAULT_PAGE_SIZE,
  HULU_DEFAULT_ROUNDS,
  HULU_MAX_GATE,
  HULU_MAX_PAGE,
  HULU_MAX_ROUNDS,
  HULU_MAX_SINGLE_ROUND_SECONDS,
  HULU_MAX_WORDS,
  HULU_MIN_GATE,
  HULU_MIN_PAGE,
  HULU_MIN_ROUNDS,
  huluGateDecision,
  huluPageCount,
  huluPageSlice,
  toHuluPlanSummary,
  type HuluPagePayload,
  type HuluPageWordItem,
  type HuluPlanSummary,
  type HuluPlanWithRounds,
  type HuluRiskResult,
  type HuluRoundRow,
} from "../domain/hulu-sprint";
import type { IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 方向三值（ADR-0017，hulu_plans.direction CHECK 同值）。 */
const DIRECTIONS = ["通用", "考研", "雅思"] as const;

/** 距考试日的剩余天数（不足一天算 0；已过 → 负数，由调用方拒绝）。 */
const MS_PER_DAY = 86400000;

const MS_PER_SECOND = 1000;

export interface HuluPlanServiceDeps {
  /** 事务执行器（默认 withTransaction；测试可注入）。 */
  txRunner?: TxRunner;
  /** 仓库工厂（默认 createRepositories；测试可注入）。 */
  repositoryFactory?: RepositoryFactory;
  /** 「今天」的日期键（YYYY-MM-DD，显示时区）；默认取系统显示时区，测试可注入。 */
  todayKey?: (repos: IRepositories) => string;
  /** 墙钟（默认系统时钟；测试可注入固定值）。轮次起止时刻的唯一来源。 */
  now?: () => Date;
}

export interface CreateHuluPlanInput {
  userId: string;
  wordbookId: string;
  /** 仅标签，不过滤词集（R6）。 */
  direction?: string | null;
  /** 考试日期（YYYY-MM-DD）。 */
  examDate: string;
  targetRounds?: number;
  pageSize?: number;
  gateRatio?: number;
  /** P0 期恒 false：true 直接抛 ValidationError("HULU_SUSPEND_NOT_YET")（P2 开放）。 */
  suspendReview?: boolean;
}

export interface GetHuluPlanInput {
  userId: string;
  planId: string;
}

export interface AbandonHuluPlanInput {
  userId: string;
  planId: string;
}

/** 开始下一轮的入参；`startedAt` 缺省取服务端 now()，越界夹取到当前时刻。 */
export interface StartHuluRoundInput {
  userId: string;
  planId: string;
  startedAt?: string;
}

/** 页结算入参（R7）。`passed`/`total` 都是**本页存活词**的口径。 */
export interface SettleHuluPageInput {
  userId: string;
  planId: string;
  roundNo: number;
  pageIndex: number;
  passed: number;
  total: number;
}

/** 轮次收尾入参；`endedAt` 缺省取服务端 now()。 */
export interface FinishHuluRoundInput {
  userId: string;
  planId: string;
  roundNo: number;
  endedAt?: string;
}

/** 页载荷入参（R4）。 */
export interface GetHuluPlanPageInput {
  userId: string;
  planId: string;
  pageIndex: number;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

/** 整数区间校验（越界 → ValidationError，与 DB CHECK 同边界）。 */
function requireIntInRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`, field);
  }
  return value;
}

function requireNumberInRange(value: number, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a number between ${min} and ${max}`, field);
  }
  return value;
}

/** YYYY-MM-DD 形状校验（不解析时区：exam_date 是日历日，不是时刻）。 */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireDateKey(value: string, field: string): string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) {
    throw new ValidationError(`${field} must be a YYYY-MM-DD date`, field);
  }
  return value;
}

/**
 * 剩余天数（考试日 - 今天，日历日粒度）：
 * 用两个日期键各自的 UTC 零点求差，避开夏令时/时区偏移对天数的影响。
 */
function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * 客户端可选时刻的夹取（`startedAt` / `endedAt` 共用）：不早于 `now - 7 天`、
 * 不晚于 `now`。上界防「未来起跑」（会让 elapsed 为负），下界与
 * `clampElapsedSeconds` 的单轮上限同界（早于 7 天前起跑等价于超上限）。
 *
 * 缺省 → now()。形状非法 → ValidationError（路由 schema 已挡一层，此处是
 * 服务层的防御性复验，照 createPlan 的 requireDateKey 先例）。
 */
function clampMoment(value: string | undefined, now: Date, field: string): string {
  if (value === undefined) return now.toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} must be an ISO datetime`, field);
  }
  const maxMs = now.getTime();
  const minMs = maxMs - HULU_MAX_SINGLE_ROUND_SECONDS * MS_PER_SECOND;
  return new Date(Math.min(Math.max(parsed, minMs), maxMs)).toISOString();
}

/** 非负整数校验（页结算的计数口径：pageIndex / passed / total 都是 ≥ 0 的整数）。 */
function requireNonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, field);
  }
  return value;
}

export class HuluPlanService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;
  /** 「今天」的日期键提供者；缺省用仓库层的显示时区实现（测试可注入固定值）。 */
  private readonly todayKey: (repos: IRepositories) => string;
  /** 墙钟；轮次起止时刻的唯一来源（测试可注入固定值）。 */
  private readonly now: () => Date;

  constructor(private readonly deps: HuluPlanServiceDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
    this.todayKey = deps.todayKey ?? ((repos) => repos.hulu.findTodayKeyInDisplayTz());
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 创建计划（单事务）：① 校验词书归属 → ② 已有 active 计划则**直接返回**（幂等）
   * → ③ 定格取词 → ④ 风险校验（block 抛 422，携带 { need, left, perRound }）
   * → ⑤ 插行。并发撞 idx_hulu_plans_one_active 时重查并返回既有计划。
   *
   * `suspendReview = true` 本期**拒绝**（P2 才开放）。
   *
   * 出参是**摘要**（`toHuluPlanSummary`）：全量 `word_ids` / `suspend_snapshot` 不出参
   * （P1 起前端不需要；页载荷走 pages 端点、曲线走 rounds）。
   */
  async createPlan(input: CreateHuluPlanInput): Promise<HuluPlanSummary> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.wordbookId, "wordbookId");
    const examDate = requireDateKey(input.examDate, "examDate");
    const targetRounds = requireIntInRange(
      input.targetRounds ?? HULU_DEFAULT_ROUNDS, HULU_MIN_ROUNDS, HULU_MAX_ROUNDS, "targetRounds",
    );
    const pageSize = requireIntInRange(
      input.pageSize ?? HULU_DEFAULT_PAGE_SIZE, HULU_MIN_PAGE, HULU_MAX_PAGE, "pageSize",
    );
    const gateRatio = requireNumberInRange(
      input.gateRatio ?? HULU_DEFAULT_GATE_RATIO, HULU_MIN_GATE, HULU_MAX_GATE, "gateRatio",
    );
    const direction = input.direction ?? null;
    if (direction !== null && !(DIRECTIONS as readonly string[]).includes(direction)) {
      throw new ValidationError(`Invalid direction: ${direction}`, "direction");
    }
    // P0 拒绝挂起（执行计划 P0-5）：P2 才接线 apply/restore。
    if (input.suspendReview === true) {
      throw new ValidationError("HULU_SUSPEND_NOT_YET", "suspendReview");
    }

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);

      const leftDays = daysBetween(this.todayKey(repos), examDate);
      if (leftDays <= 0) {
        // 未填考试日期或日期已过 → 422（完备设计 §三 风险三级第一行）。
        throw new BusinessRuleError("考试日期已过或就是今天，无法建立冲刺计划", undefined, {
          examDate,
          left: leftDays,
        });
      }

      // ① 词书归属（照 insertNewCard 的显式检查先例；越权表现为 404）。
      const owned = await repos.hulu.assertWordbookOwned(input.userId, input.wordbookId);
      if (!owned) throw new NotFoundError("Wordbook", input.wordbookId);

      // ② 幂等：同词书已有 active 计划 → 直接返回它，不报冲突。
      const existing = await repos.hulu.findActivePlanByWordbook(input.userId, input.wordbookId);
      if (existing) return toHuluPlanSummary(existing);

      // ③ 定格取词（整本词书，稳定序）。
      const wordIds = await repos.hulu.listWordIdsByWordbook(input.userId, input.wordbookId);
      if (wordIds.length === 0) {
        throw new BusinessRuleError("词书内没有可取词的条目，无法建立冲刺计划");
      }
      if (wordIds.length > HULU_MAX_WORDS) {
        throw new BusinessRuleError(`词数超出上限 ${HULU_MAX_WORDS}`, undefined, { wordCount: wordIds.length });
      }

      // ④ 风险校验（服务端重算，不信任前端）。
      const risk: HuluRiskResult = assessHuluRisk({
        wordCount: wordIds.length,
        targetRounds,
        leftDays,
      });
      if (risk.level === "block") {
        throw new BusinessRuleError("冲刺计划所需天数超出剩余天数太多", undefined, {
          need: risk.need,
          left: risk.left,
          perRound: risk.perRound,
        });
      }

      // ⑤ 插行。并发双创建由 idx_hulu_plans_one_active 兜底：撞索引 → 重查返回既有计划。
      try {
        return toHuluPlanSummary(await repos.hulu.insertPlan({
          user_id: input.userId,
          wordbook_id: input.wordbookId,
          direction,
          exam_date: examDate,
          target_rounds: targetRounds,
          page_size: pageSize,
          gate_ratio: gateRatio,
          word_ids: wordIds,
          suspend_review: false,
          suspend_snapshot: null,
        }));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await repos.hulu.findActivePlanByWordbook(input.userId, input.wordbookId);
        if (!raced) throw error;
        return toHuluPlanSummary(raced);
      }
    }, { actorId: input.userId });
  }

  /** 计划 + 轮次列表（缩时曲线的唯一数据源）。计划出参为摘要（P1 裁剪）。 */
  async getPlan(input: GetHuluPlanInput): Promise<HuluPlanWithRounds> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const plan = await repos.hulu.findPlanById(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);
      const rounds = await repos.hulu.findRoundsByPlan(input.userId, input.planId);
      return { plan: toHuluPlanSummary(plan), rounds };
    }, { actorId: input.userId });
  }

  /**
   * 页载荷（R4，只读）：按**定格** `word_ids` 切片 → 批量取存活词 → 按切片序重排。
   *
   * 只读、零副作用 —— 这正是它存在的原因：`/review/queue?mode=preview&wordIds=`
   * 会 `getOrCreateTodaySession` 写一行 sessions 且锚定默认词书（完备设计 R4）。
   *
   * 越界页 → 404（越界不是「空页」，是「不存在的页」）；`alive = 0` 是合法页
   * （整页定格词已删），前端跳过、服务端结算自动通过。
   */
  async getPlanPage(input: GetHuluPlanPageInput): Promise<HuluPagePayload> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");
    requireNonNegativeInt(input.pageIndex, "pageIndex");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const plan = await repos.hulu.findPlanById(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);

      const total = plan.word_ids.length;
      const pages = huluPageCount(total, plan.page_size);
      const slice = huluPageSlice(plan.word_ids, plan.page_size, input.pageIndex);
      if (slice.length === 0) {
        // pageIndex ≥ pages（或定格为空，创建时已拒绝，防御性）→ 不存在的页。
        throw new NotFoundError("HuluPlanPage", `${input.planId}:${input.pageIndex}`);
      }

      const found = await repos.reviews.findWordsByIds(slice);
      // 按切片顺序重排（照 getQueue 的 orderMap 做法）：findWordsByIds 的返回序
      // 由 DB 决定，而定格序才是「只缩不换」的语义所在。
      const orderMap = new Map(slice.map((id, index) => [id, index]));
      const items: HuluPageWordItem[] = found
        .filter((word) => orderMap.has(word.id))
        .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
        .map((word) => ({
          id: word.id,
          slug: word.slug,
          title: word.title,
          lemma: word.lemma,
          ipa: word.ipa,
          pos: word.pos,
          short_definition: word.short_definition,
          mnemonic_text: word.mnemonic_text,
        }));

      return { pageIndex: input.pageIndex, pages, total, alive: items.length, items };
    }, { actorId: input.userId });
  }

  /**
   * 开始下一轮：计划行 `FOR UPDATE` 串行化（「全计划至多一个未收尾轮」的保证）。
   *
   * ① 已有未收尾轮 → **返回它**（幂等；网络重试不会开出第二个轮）；
   * ② `round_no = 已有轮数 + 1`，超过 `target_rounds` → 409；
   * ③ `started_at` 由请求体给（夹取），缺省 now()。
   *
   * 计划已 completed / abandoned → 409（不能再开轮）。
   */
  async startRound(input: StartHuluRoundInput): Promise<HuluRoundRow> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const plan = await repos.hulu.lockPlanForUpdate(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);
      if (plan.status !== "active") {
        throw new ConflictError("计划已结束，无法开始新一轮");
      }

      // ① 幂等：已有未收尾轮 → 返回它（不新建）。
      const open = await repos.hulu.findOpenRound(input.userId, input.planId);
      if (open) return open;

      // ② 轮号 = 已有轮数 + 1；超过目标轮数 → 409。
      const rounds = await repos.hulu.findRoundsByPlan(input.userId, input.planId);
      const nextNo = rounds.length + 1;
      if (nextNo > plan.target_rounds) {
        throw new ConflictError("已达目标轮数，无法开始新一轮", undefined, {
          targetRounds: plan.target_rounds,
          rounds: rounds.length,
        });
      }

      // ③ started_at 夹取（缺省 now()）。
      const startedAt = clampMoment(input.startedAt, this.now(), "startedAt");
      return repos.hulu.insertRound({
        plan_id: plan.id,
        user_id: input.userId,
        round_no: nextNo,
        started_at: startedAt,
        words_total: plan.word_ids.length,
      });
    }, { actorId: input.userId });
  }

  /**
   * 页结算（R7）：服务端先**复算**本页存活词数并**复验**闸门，再走单条条件 UPDATE。
   *
   * 顺序即防线：
   *  ① `total` 必须等于本页存活词数（`alive = 0` 时 `total = 0` 合法）→ 不符 422；
   *  ② `huluGateDecision(passed, total, plan.gate_ratio)` 为 block → 422（读列值，不写死）；
   *  ③ 条件 UPDATE：命中 → 200；未命中且 `pages_passed > pageIndex` → 幂等返回现状；
   *     未命中且 `<` → 跳页 409。
   *
   * 前端「不过闸整页清零、不发请求」是 UX 路径；这里的 422 是**服务端防线** ——
   * 不信任前端（完备设计 §三）。
   */
  async settlePage(input: SettleHuluPageInput): Promise<HuluRoundRow> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");
    requireNonNegativeInt(input.roundNo, "roundNo");
    const pageIndex = requireNonNegativeInt(input.pageIndex, "pageIndex");
    const passed = requireNonNegativeInt(input.passed, "passed");
    const total = requireNonNegativeInt(input.total, "total");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const plan = await repos.hulu.findPlanById(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);

      const round = await repos.hulu.findRoundByNo(input.userId, input.planId, input.roundNo);
      if (!round) throw new NotFoundError("HuluRound", `${input.planId}:${input.roundNo}`);

      // ① total 必须等于本页**存活**词数（服务端复算，不信任前端）。
      const slice = huluPageSlice(plan.word_ids, plan.page_size, pageIndex);
      const alive = (await repos.reviews.findWordsByIds(slice)).filter((word) => slice.includes(word.id)).length;
      if (total !== alive) {
        throw new ValidationError("total 与本页存活词数不符", "total");
      }

      // ② 闸门复验（读计划行列值，不写死 0.8）。total = 0（整页删空）→ pass。
      if (huluGateDecision(passed, total, plan.gate_ratio) === "block") {
        throw new ValidationError("本页未达闸门，不能结算", "passed");
      }

      // ③ 单条条件 UPDATE（R7 原文）。
      const settled = await repos.hulu.settlePage({
        userId: input.userId,
        roundId: round.id,
        pageIndex,
        passed,
      });
      if (settled) return settled;

      // 未命中：重读游标分流（并发/重试下的幂等语义）。
      const current = await repos.hulu.findRoundByNo(input.userId, input.planId, input.roundNo);
      if (!current) throw new NotFoundError("HuluRound", `${input.planId}:${input.roundNo}`);
      if (current.pages_passed > pageIndex) {
        // 重复提交：本页已结算过，返回现状（不重复计数）。
        return current;
      }
      // pages_passed < pageIndex → 跳页；pages_passed === pageIndex 而 0 行
      // 只能是本轮已收尾（ended_at 非空）。
      throw new ConflictError("页结算被拒绝：轮次已收尾或提交了未来的页", undefined, {
        pageIndex,
        pagesPassed: current.pages_passed,
      });
    }, { actorId: input.userId });
  }

  /**
   * 轮次收尾：`elapsed_seconds = clampElapsedSeconds(ended - started)`（墙钟，R5）。
   *
   * 已收尾 → **幂等返回现状**（不重写耗时）；末轮（`round_no == target_rounds`）
   * 同事务把计划置 `completed` 并写 `ended_at`。
   */
  async finishRound(input: FinishHuluRoundInput): Promise<HuluRoundRow> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");
    requireNonNegativeInt(input.roundNo, "roundNo");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const plan = await repos.hulu.lockPlanForUpdate(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);

      const round = await repos.hulu.findRoundByNo(input.userId, input.planId, input.roundNo);
      if (!round) throw new NotFoundError("HuluRound", `${input.planId}:${input.roundNo}`);
      // 已收尾 → 幂等返回现状。
      if (round.ended_at !== null) return round;

      const now = this.now();
      const endedAt = clampMoment(input.endedAt, now, "endedAt");
      const elapsedSeconds = clampElapsedSeconds(
        (Date.parse(endedAt) - Date.parse(round.started_at)) / MS_PER_SECOND,
      );

      const finished = await repos.hulu.finishRound({
        userId: input.userId,
        roundId: round.id,
        endedAt,
        elapsedSeconds,
      });
      if (!finished) {
        // 并发双收尾：另一个请求先写成功 → 幂等返回现状。
        const current = await repos.hulu.findRoundByNo(input.userId, input.planId, input.roundNo);
        if (!current) throw new NotFoundError("HuluRound", `${input.planId}:${input.roundNo}`);
        return current;
      }

      // 末轮 → 同事务完成计划（P2 在此同事务恢复挂起快照）。
      if (finished.round_no >= plan.target_rounds && plan.status === "active") {
        await repos.hulu.setPlanStatus(input.userId, input.planId, "completed", { ended: true });
      }
      return finished;
    }, { actorId: input.userId });
  }

  /**
   * 放弃计划：active → abandoned（写 ended_at）。
   * 已 abandoned → **幂等返回现状**；已 completed → 抛业务错（409 语义）。
   */
  async abandonPlan(input: AbandonHuluPlanInput): Promise<HuluPlanSummary> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      // 加锁读改写：并发放弃只有一个写生效，另一个读到已 abandoned 走幂等分支。
      const plan = await repos.hulu.lockPlanForUpdate(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);
      if (plan.status === "abandoned") return toHuluPlanSummary(plan);
      if (plan.status === "completed") {
        throw new BusinessRuleError("计划已完成，无法放弃");
      }
      const updated = await repos.hulu.setPlanStatus(input.userId, input.planId, "abandoned", { ended: true });
      if (!updated) throw new NotFoundError("HuluPlan", input.planId);
      return toHuluPlanSummary(updated);
    }, { actorId: input.userId });
  }
}
