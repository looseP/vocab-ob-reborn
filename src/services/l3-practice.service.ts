/**
 * L3PracticeService — L3 练习记录 + 错题库应用层（ADR-0019 §1/§3）。
 *
 * 边界（ADR-0004 §6 / ADR-0005）：
 *   - "L3 有记录、无调度"：本服务只写 `l3_practice_attempts`。
 *   - **零 FSRS 写入**：绝不触碰 user_word_progress / user_word_l2_progress /
 *     review_logs（不 import 任何 L2/FSRS 仓库）。错题库是 attempts(outcome='wrong')
 *     的派生查询，不建第二真相源。
 *
 * 幂等（与计划的偏差，见任务裁决）：
 *   schema 无 idempotency_key 列，且不新增迁移 → 用 T04 deterministicTaskId 作为
 *   幂等身份存进 payload.taskId，配合 pg_advisory_xact_lock(hashtext(userId),
 *   hashtext(taskId)) + findAttemptByTaskId 的 SELECT-then-INSERT：
 *   taskId 命中即返回既有行，不重复插入。
 *
 * 事务：一个方法 = 一个事务（withTransaction + actorId）；l3_* 表 owner RLS，
 * 所有读写都在携带 actorId 的事务内。服务装配（createServices）留给 T09。
 */

import type { PoolClient } from "pg";
import { ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  Direction,
  Json,
  L3PracticeAttemptPage,
  L3PracticeAttemptRow,
  L3PracticeOutcome,
  L3PracticeType,
  L3SubSpace,
} from "../domain";
import type { IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 练习记录列表默认/上限条数。 */
export const L3_PRACTICE_DEFAULT_LIMIT = 20;
export const L3_PRACTICE_MAX_LIMIT = 100;

/** 题型固定枚举（ADR-0019 §3，l3_practice_attempts.practice_type CHECK 同值）。 */
export const L3_PRACTICE_TYPES: readonly L3PracticeType[] = ["essay_dictation", "context_quiz"];
/** 判定结果固定枚举（l3_practice_attempts.outcome CHECK 同值）。 */
export const L3_PRACTICE_OUTCOMES: readonly L3PracticeOutcome[] = ["correct", "wrong", "skip"];
/** 子空间固定枚举（ADR-0019 §4，l3_source_spaces.space CHECK 同值）。 */
export const L3_SUB_SPACES: readonly L3SubSpace[] = ["语法", "阅读", "作文", "翻译", "通用"];
/** 方向固定枚举（ADR-0017，l3_sources.direction CHECK 同值）。 */
const DIRECTIONS: readonly Direction[] = ["通用", "考研", "雅思"];

export interface RecordL3AttemptInput {
  userId: string;
  contextId: string;
  occurrenceId?: string | null;
  sessionId?: string | null;
  practiceType: L3PracticeType;
  outcome: L3PracticeOutcome;
  /** 必须携带 taskId（T04 deterministicTaskId 产出）作为幂等身份。 */
  payload: Json;
}

export interface ListL3AttemptsInput {
  userId: string;
  practiceType?: L3PracticeType | null;
  outcome?: L3PracticeOutcome | null;
  space?: L3SubSpace | null;
  direction?: Direction | null;
  limit?: number | null;
  offset?: number | null;
}

export interface L3ErrorBookInput {
  userId: string;
  space?: L3SubSpace | null;
  direction?: Direction | null;
  limit?: number | null;
  offset?: number | null;
}

export interface L3PracticeServiceDeps {
  /** 事务执行器（默认 withTransaction；测试可注入）。 */
  txRunner?: TxRunner;
  /** 仓库工厂（默认 createRepositories；测试可注入）。 */
  repositoryFactory?: RepositoryFactory;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

/** 必填枚举校验：把 DB 23514 提前成业务错（不把约束错误直接透出）。 */
function requireEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
}

/** 可选枚举校验：缺省 → null；非法 → ValidationError。 */
function resolveOptionalEnum<T extends string>(
  value: T | null | undefined,
  allowed: readonly string[],
  field: string,
): T | null {
  if (value == null) return null;
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
  return value;
}

function normalizeLimit(limit: number | null | undefined): number {
  if (limit == null) return L3_PRACTICE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return L3_PRACTICE_DEFAULT_LIMIT;
  return Math.min(limit, L3_PRACTICE_MAX_LIMIT);
}

function normalizeOffset(offset: number | null | undefined): number {
  if (offset == null) return 0;
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

/** 幂等身份提取：payload 必须是对象且带非空字符串 taskId。 */
function readTaskId(payload: Json): string {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("payload must be an object carrying taskId", "payload");
  }
  const taskId = (payload as Record<string, Json>).taskId;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new ValidationError("payload.taskId is required", "taskId");
  }
  return taskId;
}

export class L3PracticeService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;

  constructor(deps: L3PracticeServiceDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
  }

  /**
   * 记录一次练习作答。幂等：同 (user, taskId) 重复提交返回既有行（不重复插入）。
   * 先校验枚举/taskId（DB CHECK 不直接透出）；再在单事务内锁 → 查 → 插。
   */
  async recordAttempt(input: RecordL3AttemptInput): Promise<L3PracticeAttemptRow> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.contextId, "contextId");
    requireEnum(input.practiceType, L3_PRACTICE_TYPES, "practiceType");
    requireEnum(input.outcome, L3_PRACTICE_OUTCOMES, "outcome");
    const taskId = readTaskId(input.payload);

    return this.txRunner(async (tx) => {
      const l3Practice = this.repositoryFactory(tx).l3Practice;
      await l3Practice.lockAttemptIdentity(input.userId, taskId);
      const existing = await l3Practice.findAttemptByTaskId(input.userId, taskId);
      if (existing) return existing;
      return l3Practice.insertAttempt({
        user_id: input.userId,
        context_id: input.contextId,
        occurrence_id: input.occurrenceId ?? null,
        session_id: input.sessionId ?? null,
        practice_type: input.practiceType,
        outcome: input.outcome,
        payload: input.payload,
      });
    }, { actorId: input.userId });
  }

  /** 练习记录列表（可选 practiceType/outcome 过滤；space/direction 两轴过滤）。 */
  async listAttempts(input: ListL3AttemptsInput): Promise<L3PracticeAttemptPage> {
    requireNonEmpty(input.userId, "userId");
    const practiceType = resolveOptionalEnum(input.practiceType, L3_PRACTICE_TYPES, "practiceType");
    const outcome = resolveOptionalEnum(input.outcome, L3_PRACTICE_OUTCOMES, "outcome");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);

    return this.txRunner(
      async (tx) =>
        this.repositoryFactory(tx).l3Practice.listAttempts({
          userId: input.userId,
          practiceType,
          outcome,
          space,
          direction,
          limit,
          offset,
        }),
      { actorId: input.userId },
    );
  }

  /** 错题库：attempts(outcome='wrong') 派生查询，按子空间/方向两轴过滤。 */
  async errorBook(input: L3ErrorBookInput): Promise<L3PracticeAttemptPage> {
    requireNonEmpty(input.userId, "userId");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);

    return this.txRunner(
      async (tx) =>
        this.repositoryFactory(tx).l3Practice.listWrongAttempts({
          userId: input.userId,
          space,
          direction,
          limit,
          offset,
        }),
      { actorId: input.userId },
    );
  }
}
