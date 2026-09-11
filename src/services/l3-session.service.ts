/**
 * L3SessionService — L3 会话计划服务（ADR-0019 §2）。
 *
 * 会话 = 服务端计划 + 实体引用渲染描述，**不存 HTML 产物**：
 *   - createPlan：确定性抽样 context id → plan = { version, days, seed,
 *     items: [{ day, contextIds }] }（**只存 id 引用**，无任何文本）；
 *   - getSession：读 plan → 按 id 现拉 contexts → 组渲染描述（每次打开都反映最新数据，
 *     素材更新/删除自动体现）；
 *   - endSession：置 completed / abandoned（ended_at=now()，幂等）。
 *
 * 版本拒绝（借 TypeWords 评审的 flow version 思路）：plan.version ≠ 1（未知）→ 抛业务错，
 * 不静默降级；type 非法同理（DB CHECK 不直接透出）。
 *
 * 红线（ADR-0004 §6 / ADR-0005）：零 FSRS 写入；plan 只存引用不存产物；
 * 不用 sessions 表（L3 会话走 l3_sessions）。装配（createServices）留给 T09。
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { BusinessRuleError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  Direction,
  Json,
  L3SessionContextSummary,
  L3SessionPlan,
  L3SessionPlanItem,
  L3SessionRenderDescription,
  L3SessionRow,
  L3SessionStatus,
  L3SessionType,
  L3SubSpace,
} from "../domain";
import type { IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 已知 plan 版本；未知版本拒绝恢复（不静默降级）。 */
export const L3_SESSION_PLAN_VERSION = 1;
export const L3_SESSION_DEFAULT_CONTEXTS = 20;
export const L3_SESSION_MAX_CONTEXTS = 200;
export const L3_SESSION_MAX_DAYS = 90;

/** 会话类型固定枚举（l3_sessions.type CHECK 同值）。 */
export const L3_SESSION_TYPES: readonly L3SessionType[] = [
  "l2_upgrade",
  "l3_practice",
  "cram_pack",
  "knowledge",
];
/** 可主动结束的状态（active 不是结束态）。 */
export const L3_SESSION_END_STATUSES: readonly L3SessionStatus[] = ["completed", "abandoned"];
/** 子空间固定枚举（ADR-0019 §4，l3_source_spaces.space CHECK 同值）。 */
const L3_SUB_SPACES: readonly L3SubSpace[] = ["语法", "阅读", "作文", "翻译", "通用"];
/** 方向固定枚举（ADR-0017，l3_sources.direction CHECK 同值）。 */
const DIRECTIONS: readonly Direction[] = ["通用", "考研", "雅思"];

export interface CreateL3PlanInput {
  userId: string;
  type: L3SessionType;
  title?: string | null;
  space?: L3SubSpace | null;
  direction?: Direction | null;
  contextCount?: number | null;
  days?: number | null;
  /** 缺省由输入派生（确定性）；显式 seed 优先。 */
  seed?: string | null;
}

export interface GetL3SessionInput {
  userId: string;
  sessionId: string;
}

export interface EndL3SessionInput {
  userId: string;
  sessionId: string;
  status: Extract<L3SessionStatus, "completed" | "abandoned">;
}

export interface L3SessionServiceDeps {
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

function requireEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
}

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

function normalizeCount(
  value: number | null | undefined,
  defaultValue: number,
  max: number,
  field: string,
): number {
  if (value == null) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${field} must be between 1 and ${max}`, field);
  }
  return value;
}

/** 缺省 seed 由输入派生（同输入恒同 seed）；显式非空 seed 优先。 */
function resolveSeed(input: CreateL3PlanInput): string {
  const explicit = input.seed;
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  return createHash("sha256")
    .update(
      JSON.stringify({
        userId: input.userId,
        type: input.type,
        title: input.title ?? null,
        space: input.space ?? null,
        direction: input.direction ?? null,
        contextCount: input.contextCount ?? null,
        days: input.days ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/** 把抽样 id 按天切片：plan 只含 day + contextIds（无文本）。 */
function buildSessionPlan(contextIds: string[], days: number, seed: string): L3SessionPlan {
  const perDay = Math.ceil(contextIds.length / days);
  const items: L3SessionPlanItem[] = [];
  for (let day = 1; day <= days; day++) {
    items.push({ day, contextIds: contextIds.slice((day - 1) * perDay, day * perDay) });
  }
  return { version: L3_SESSION_PLAN_VERSION, days, seed, items };
}

/**
 * 读取并校验 plan：未知 version / 非对象 / items 非数组 → 业务错（拒绝恢复，不静默降级）。
 * 单个畸形 item 跳过（无法渲染），但整体结构问题必须显式失败。
 */
function readSessionPlan(plan: Json): L3SessionPlan {
  if (plan == null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new BusinessRuleError("L3 session plan must be a JSON object");
  }
  const record = plan as Record<string, Json>;
  const version = record.version;
  if (version !== L3_SESSION_PLAN_VERSION) {
    throw new BusinessRuleError(
      `Unsupported L3 session plan version: ${version == null ? "missing" : String(version)}`,
    );
  }
  const rawItems = record.items;
  if (!Array.isArray(rawItems)) {
    throw new BusinessRuleError("L3 session plan items must be an array");
  }
  const items: L3SessionPlanItem[] = [];
  for (const raw of rawItems) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, Json>;
    const contextIds = Array.isArray(entry.contextIds)
      ? entry.contextIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    items.push({ day: typeof entry.day === "number" ? entry.day : items.length + 1, contextIds });
  }
  return {
    version: L3_SESSION_PLAN_VERSION,
    days: typeof record.days === "number" ? record.days : items.length,
    seed: typeof record.seed === "string" ? record.seed : "",
    items,
  };
}

export class L3SessionService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;

  constructor(deps: L3SessionServiceDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
  }

  /**
   * 建会话计划：确定性抽样 context id（同 seed 恒同）→ plan 只存引用 → 插入。
   * 无匹配素材时抛业务错（空会话没有意义）。
   */
  async createPlan(input: CreateL3PlanInput): Promise<L3SessionRow> {
    requireNonEmpty(input.userId, "userId");
    requireEnum(input.type, L3_SESSION_TYPES, "type");
    const space = resolveOptionalEnum(input.space, L3_SUB_SPACES, "space");
    const direction = resolveOptionalEnum(input.direction, DIRECTIONS, "direction");
    const contextCount = normalizeCount(
      input.contextCount,
      L3_SESSION_DEFAULT_CONTEXTS,
      L3_SESSION_MAX_CONTEXTS,
      "contextCount",
    );
    const days = normalizeCount(input.days, 1, L3_SESSION_MAX_DAYS, "days");
    const seed = resolveSeed(input);

    return this.txRunner(async (tx) => {
      const repo = this.repositoryFactory(tx).l3Sessions;
      const contextIds = await repo.sampleContextIds({
        userId: input.userId,
        space,
        direction,
        limit: contextCount,
        seed,
      });
      if (contextIds.length === 0) {
        throw new BusinessRuleError("No L3 contexts match the requested space/direction");
      }
      return repo.insertSession({
        user_id: input.userId,
        type: input.type,
        title: input.title ?? null,
        plan: buildSessionPlan(contextIds, days, seed) as unknown as Json,
        version: L3_SESSION_PLAN_VERSION,
      });
    }, { actorId: input.userId });
  }

  /** 现拉现渲染：读 plan 的 id 引用 → 按 id 拉 contexts → 渲染描述（不存产物）。 */
  async getSession(input: GetL3SessionInput): Promise<L3SessionRenderDescription> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.sessionId, "sessionId");

    return this.txRunner(async (tx) => {
      const repo = this.repositoryFactory(tx).l3Sessions;
      const session = await repo.findSessionByIdForUser(input.userId, input.sessionId);
      if (!session) throw new NotFoundError("L3Session", input.sessionId);

      const plan = readSessionPlan(session.plan);
      const ids = [...new Set(plan.items.flatMap((item) => item.contextIds))];
      const contexts = ids.length > 0 ? await repo.findContextsByIds(input.userId, ids) : [];
      const byId = new Map(contexts.map((context) => [context.id, context]));

      return {
        session,
        items: plan.items.map((item) => ({
          day: item.day,
          contexts: item.contextIds
            .map((id) => byId.get(id))
            .filter((context): context is L3SessionContextSummary => context !== undefined),
        })),
      };
    }, { actorId: input.userId });
  }

  /** 结束会话：active → completed/abandoned（幂等；已结束且状态不同则拒绝）。 */
  async endSession(input: EndL3SessionInput): Promise<L3SessionRow> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.sessionId, "sessionId");
    requireEnum(input.status, L3_SESSION_END_STATUSES, "status");

    return this.txRunner(async (tx) => {
      const repo = this.repositoryFactory(tx).l3Sessions;
      const session = await repo.findSessionByIdForUser(input.userId, input.sessionId);
      if (!session) throw new NotFoundError("L3Session", input.sessionId);
      if (session.status === input.status) return session;
      if (session.status !== "active") {
        throw new BusinessRuleError(`L3 session is already ${session.status}`);
      }
      const updated = await repo.updateStatus(input.userId, input.sessionId, input.status, { ended: true });
      if (!updated) throw new NotFoundError("L3Session", input.sessionId);
      return updated;
    }, { actorId: input.userId });
  }
}
