/**
 * UpgradeWorkOrderService — ADR-0018 用户主动提前升级（升级工单）的应用层。
 *
 * 生命周期（upgrade_work_orders.status，0028）：
 *
 *   mark（标记中）→ start（升级中）→ complete（已完成）
 *                       ↘ cancel（已取消，进行中态均可）
 *
 * 边界（ADR-0018 / ADR-0002 / ADR-0004 §6）：
 *   - `mark` 只把三档升级建议（computeUpgradeSuggestion 纯函数）写进
 *     suggestion_snapshot——**纯提示、零 FSRS 写入**，不设卡、不阻断。
 *   - `complete` 是唯一写 L2 的路径，且走 L2TransitionService.promoteWithSeed
 *     （seed 一次性继承；seed ≠ merge，来源行不改写）。
 *   - 自动晋升门槛（ADR-0002）与 promoteNow/checkAndTransition 一字不动。
 *
 * 事务：工单表与 user_word_* 均 owner-RLS，所有读写都在携带 actorId 的事务内。
 * 服务实例的装配（createServices）留给 W3/T09；本文件只提供可注入依赖的类。
 */

import type { PoolClient } from "pg";
import { BusinessRuleError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import {
  computeUpgradeSuggestion,
  type CurrentBookL1Signal,
  type OtherBookL2Signal,
  type UpgradeSuggestionLevel,
} from "../domain/upgrade-suggestion";
import type {
  Direction,
  Json,
  UpgradeWorkOrderRow,
  UserWordL2ProgressRow,
  UserWordProgressRow,
} from "../domain";
import type { IRepositories } from "../repositories/interfaces";
import type { L1ProgressSnapshot, L2SeedSource } from "./l2-transition.service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** 待升级清单默认/上限条数（与 L3 列表页惯例一致）。 */
export const UPGRADE_WORK_ORDER_DEFAULT_LIMIT = 50;
export const UPGRADE_WORK_ORDER_MAX_LIMIT = 200;

/** 固定枚举（ADR-0017）：direction 三值，DB CHECK 同值。 */
const DIRECTIONS: readonly Direction[] = ["通用", "考研", "雅思"];

/** promoteWithSeed 的最小端口（便于测试替身；L2TransitionService 结构兼容）。 */
export interface PromoteWithSeedPort {
  promoteWithSeed(
    progress: L1ProgressSnapshot,
    seed: L2SeedSource | null,
  ): Promise<{ alreadyPromoted: boolean; l2DueAt: string | null; seeded: boolean }>;
}

export interface UpgradeWorkOrderServiceDeps {
  l2Transition: PromoteWithSeedPort;
  /** 事务执行器（默认 withTransaction；测试可注入）。 */
  txRunner?: TxRunner;
  /** 仓库工厂（默认 createRepositories；测试可注入）。 */
  repositoryFactory?: RepositoryFactory;
}

/** 建议快照（suggestion_snapshot 的形状）：档位 + 判定输入 + 采集时刻。 */
export interface UpgradeSuggestionSnapshot {
  level: UpgradeSuggestionLevel;
  currentBookL1: CurrentBookL1Signal;
  otherBooksL2: OtherBookL2Signal[];
  capturedAt: string;
}

export interface MarkUpgradeResult {
  workOrder: UpgradeWorkOrderRow;
  suggestion: UpgradeSuggestionLevel;
  suggestionSnapshot: UpgradeSuggestionSnapshot;
}

export interface CompleteUpgradeResult {
  workOrder: UpgradeWorkOrderRow;
  alreadyPromoted: boolean;
  l2DueAt: string | null;
  /** true = 用了他书 seed；false = 无他书记录，回退 L1 继承。 */
  seeded: boolean;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function requireDirection(value: string | undefined): Direction {
  const direction = (value ?? "通用") as Direction;
  if (!DIRECTIONS.includes(direction)) {
    throw new ValidationError(`Invalid direction: ${value}`, "direction");
  }
  return direction;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

function toL1Snapshot(row: UserWordProgressRow): L1ProgressSnapshot {
  return {
    user_id: row.user_id,
    wordbook_id: row.wordbook_id,
    word_id: row.word_id,
    // stability 可能为 null（新卡）；promoteWithSeed 的 L1 派生算术对 0 收敛到 floor。
    stability: row.stability ?? 0,
    difficulty: row.difficulty,
    review_count: row.review_count,
    last_rating: row.last_rating,
  };
}

/** 他书最佳 L2 行 → seed 源；无行 → null（回退 L1 继承路径）。 */
function toSeedSource(row: UserWordL2ProgressRow | null): L2SeedSource | null {
  if (!row) return null;
  return {
    progressId: row.id,
    wordbookId: row.wordbook_id,
    stability: row.l2_stability,
    difficulty: row.l2_difficulty,
    schedulerPayload: (row.l2_scheduler_payload ?? null) as Json | null,
  };
}

export class UpgradeWorkOrderService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;

  constructor(private readonly deps: UpgradeWorkOrderServiceDeps) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
  }

  /**
   * 升级标记（ADR-0018 §1）：写工单 + 采集三档建议快照。零 FSRS 写入。
   *
   * 同一 (user, word, wordbook) 已有进行中工单时视为"重复标记"：刷新
   * direction + suggestion_snapshot（不重置 status），不新增第二张工单
   * （部分唯一索引 idx_upgrade_work_orders_one_active 是 DB 层兜底）。
   */
  async mark(
    userId: string,
    wordbookId: string,
    wordId: string,
    direction?: Direction,
  ): Promise<MarkUpgradeResult> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(wordbookId, "wordbookId");
    requireNonEmpty(wordId, "wordId");
    const resolvedDirection = requireDirection(direction);

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);

      // 当前书 L1 表现（首学/首复习时刻）。无 L1 行 → 零证据（保守默认）。
      const l1 = await repos.reviews.findByUserWordbookWord(userId, wordbookId, wordId);
      const currentBookL1: CurrentBookL1Signal = {
        recentRatings: l1?.recent_ratings ?? [],
        state: l1?.state ?? "new",
      };
      // 他书 L2 掌握信号（跨书数据只喂建议，永不改进度）。
      const otherBooksL2 = await repos.l2Progress.findOtherBookSignals(userId, wordId, wordbookId);
      const level = computeUpgradeSuggestion({ currentBookL1, otherBooksL2 });
      const suggestionSnapshot: UpgradeSuggestionSnapshot = {
        level,
        currentBookL1,
        otherBooksL2,
        capturedAt: new Date().toISOString(),
      };
      const snapshotJson = suggestionSnapshot as unknown as Json;

      const active = await repos.upgradeWorkOrders.findActiveByScope(userId, wordbookId, wordId);
      if (active) {
        const updated = await repos.upgradeWorkOrders.updateSuggestion(
          userId,
          active.id,
          resolvedDirection,
          snapshotJson,
        );
        return { workOrder: updated ?? active, suggestion: level, suggestionSnapshot };
      }

      try {
        const created = await repos.upgradeWorkOrders.insert({
          user_id: userId,
          word_id: wordId,
          wordbook_id: wordbookId,
          direction: resolvedDirection,
          suggestion_snapshot: snapshotJson,
        });
        return { workOrder: created, suggestion: level, suggestionSnapshot };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // 并发首插竞态：另一事务已建进行中工单 → 复用并刷新建议快照。
        const raced = await repos.upgradeWorkOrders.findActiveByScope(userId, wordbookId, wordId);
        if (!raced) throw error;
        const updated = await repos.upgradeWorkOrders.updateSuggestion(
          userId,
          raced.id,
          resolvedDirection,
          snapshotJson,
        );
        return { workOrder: updated ?? raced, suggestion: level, suggestionSnapshot };
      }
    }, { actorId: userId });
  }

  /** 待升级清单：该词书进行中工单（标记中 + 升级中），创建时间倒序。 */
  async list(
    userId: string,
    wordbookId: string,
    limit: number = UPGRADE_WORK_ORDER_DEFAULT_LIMIT,
  ): Promise<UpgradeWorkOrderRow[]> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(wordbookId, "wordbookId");
    const bounded = Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), UPGRADE_WORK_ORDER_MAX_LIMIT)
      : UPGRADE_WORK_ORDER_DEFAULT_LIMIT;
    return this.txRunner(
      async (tx) =>
        this.repositoryFactory(tx).upgradeWorkOrders.listPending(userId, wordbookId, bounded),
      { actorId: userId },
    );
  }

  /** 开始升级：标记中 → 升级中（幂等；已完成/已取消拒绝）。 */
  async start(userId: string, workOrderId: string): Promise<UpgradeWorkOrderRow> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(workOrderId, "workOrderId");
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const order = await repos.upgradeWorkOrders.findByIdForUser(userId, workOrderId);
      if (!order) throw new NotFoundError("UpgradeWorkOrder", workOrderId);
      if (order.status === "升级中") return order;
      if (order.status !== "标记中") {
        throw new BusinessRuleError(`Cannot start an upgrade work order in status ${order.status}`);
      }
      const updated = await repos.upgradeWorkOrders.updateStatus(userId, workOrderId, "升级中");
      if (!updated) throw new NotFoundError("UpgradeWorkOrder", workOrderId);
      return updated;
    }, { actorId: userId });
  }

  /** 取消工单（幂等；已完成拒绝）。已取消返回原行。 */
  async cancel(userId: string, workOrderId: string): Promise<UpgradeWorkOrderRow> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(workOrderId, "workOrderId");
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const order = await repos.upgradeWorkOrders.findByIdForUser(userId, workOrderId);
      if (!order) throw new NotFoundError("UpgradeWorkOrder", workOrderId);
      if (order.status === "已取消") return order;
      if (order.status === "已完成") {
        throw new BusinessRuleError("Completed upgrade work order cannot be cancelled");
      }
      const updated = await repos.upgradeWorkOrders.updateStatus(userId, workOrderId, "已取消");
      if (!updated) throw new NotFoundError("UpgradeWorkOrder", workOrderId);
      return updated;
    }, { actorId: userId });
  }

  /**
   * 完成升级（ADR-0018 §3）：seed 一次性继承入 L2 + 工单置已完成。
   *
   * 幂等：重复 complete 时 promoteWithSeed 命中既有 L2 行（alreadyPromoted），
   * 工单已是"已完成"则不再改写——绝不产生第二行 L2。
   * 取消态拒绝（已取消之后不允许升级）。
   */
  async complete(userId: string, workOrderId: string): Promise<CompleteUpgradeResult> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(workOrderId, "workOrderId");

    // 一次性读：工单 + 当前书 L1 快照 + 他书最佳 seed 候选（同一 actor 事务）。
    const prepared = await this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const order = await repos.upgradeWorkOrders.findByIdForUser(userId, workOrderId);
      if (!order) throw new NotFoundError("UpgradeWorkOrder", workOrderId);
      if (order.status === "已取消") {
        throw new BusinessRuleError("Cancelled upgrade work order cannot be completed");
      }
      const l1 = await repos.reviews.findByUserWordbookWord(userId, order.wordbook_id, order.word_id);
      if (!l1) {
        throw new BusinessRuleError(
          "Cannot complete the upgrade without an L1 progress row for the word",
        );
      }
      const seedRow = await repos.l2Progress.findBestByWordAndUser(
        userId,
        order.word_id,
        order.wordbook_id,
      );
      return { order, l1Snapshot: toL1Snapshot(l1), seed: toSeedSource(seedRow) };
    }, { actorId: userId });

    // seed 继承（内部自带 actor 事务与幂等/23505 语义）。
    const promotion = await this.deps.l2Transition.promoteWithSeed(
      prepared.l1Snapshot,
      prepared.seed,
    );

    const workOrder = prepared.order.status === "已完成"
      ? prepared.order
      : (await this.txRunner(async (tx) => {
          const updated = await this.repositoryFactory(tx).upgradeWorkOrders.updateStatus(
            userId,
            workOrderId,
            "已完成",
            { completed: true },
          );
          return updated ?? prepared.order;
        }, { actorId: userId }));

    return {
      workOrder,
      alreadyPromoted: promotion.alreadyPromoted,
      l2DueAt: promotion.l2DueAt,
      seeded: promotion.seeded,
    };
  }
}
