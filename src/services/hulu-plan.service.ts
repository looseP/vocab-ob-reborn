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
import { BusinessRuleError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { isUniqueViolation } from "../repositories/hulu.repository";
import {
  assessHuluRisk,
  HULU_DEFAULT_GATE_RATIO,
  HULU_DEFAULT_PAGE_SIZE,
  HULU_DEFAULT_ROUNDS,
  HULU_MAX_GATE,
  HULU_MAX_PAGE,
  HULU_MAX_ROUNDS,
  HULU_MAX_WORDS,
  HULU_MIN_GATE,
  HULU_MIN_PAGE,
  HULU_MIN_ROUNDS,
  type HuluPlanRow,
  type HuluPlanWithRounds,
  type HuluRiskResult,
} from "../domain/hulu-sprint";
import type { IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 方向三值（ADR-0017，hulu_plans.direction CHECK 同值）。 */
const DIRECTIONS = ["通用", "考研", "雅思"] as const;

/** 距考试日的剩余天数（不足一天算 0；已过 → 负数，由调用方拒绝）。 */
const MS_PER_DAY = 86400000;

export interface HuluPlanServiceDeps {
  /** 事务执行器（默认 withTransaction；测试可注入）。 */
  txRunner?: TxRunner;
  /** 仓库工厂（默认 createRepositories；测试可注入）。 */
  repositoryFactory?: RepositoryFactory;
  /** 「今天」的日期键（YYYY-MM-DD，显示时区）；默认取系统显示时区，测试可注入。 */
  todayKey?: (repos: IRepositories) => string;
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

export class HuluPlanService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;
  /** 「今天」的日期键提供者；缺省用仓库层的显示时区实现（测试可注入固定值）。 */
  private readonly todayKey: (repos: IRepositories) => string;

  constructor(private readonly deps: HuluPlanServiceDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
    this.todayKey = deps.todayKey ?? ((repos) => repos.hulu.findTodayKeyInDisplayTz());
  }

  /**
   * 创建计划（单事务）：① 校验词书归属 → ② 已有 active 计划则**直接返回**（幂等）
   * → ③ 定格取词 → ④ 风险校验（block 抛 422，携带 { need, left, perRound }）
   * → ⑤ 插行。并发撞 idx_hulu_plans_one_active 时重查并返回既有计划。
   *
   * `suspendReview = true` 本期**拒绝**（P2 才开放）。
   */
  async createPlan(input: CreateHuluPlanInput): Promise<HuluPlanRow> {
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
      if (existing) return existing;

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
        return await repos.hulu.insertPlan({
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
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await repos.hulu.findActivePlanByWordbook(input.userId, input.wordbookId);
        if (!raced) throw error;
        return raced;
      }
    }, { actorId: input.userId });
  }

  /** 计划 + 轮次列表（缩时曲线的唯一数据源）。 */
  async getPlan(input: GetHuluPlanInput): Promise<HuluPlanWithRounds> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const plan = await repos.hulu.findPlanById(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);
      const rounds = await repos.hulu.findRoundsByPlan(input.userId, input.planId);
      return { plan, rounds };
    }, { actorId: input.userId });
  }

  /**
   * 放弃计划：active → abandoned（写 ended_at）。
   * 已 abandoned → **幂等返回现状**；已 completed → 抛业务错（409 语义）。
   */
  async abandonPlan(input: AbandonHuluPlanInput): Promise<HuluPlanRow> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.planId, "planId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      // 加锁读改写：并发放弃只有一个写生效，另一个读到已 abandoned 走幂等分支。
      const plan = await repos.hulu.lockPlanForUpdate(input.userId, input.planId);
      if (!plan) throw new NotFoundError("HuluPlan", input.planId);
      if (plan.status === "abandoned") return plan;
      if (plan.status === "completed") {
        throw new BusinessRuleError("计划已完成，无法放弃");
      }
      const updated = await repos.hulu.setPlanStatus(input.userId, input.planId, "abandoned", { ended: true });
      if (!updated) throw new NotFoundError("HuluPlan", input.planId);
      return updated;
    }, { actorId: input.userId });
  }
}
