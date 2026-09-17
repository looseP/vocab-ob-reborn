/**
 * ForgettingService — 一键遗忘（ADR-0020）。
 *
 * 语义红线（ADR-0020）：
 *   - **遗忘 = 挂起**：L1 非锚点行置 state='suspended'，L2 非锚点行置
 *     l2_paused=true/reason='manual'。**永不删除、永不重置 stability、永不推 due**。
 *   - **作用域必须按书**：所有查询/写入都钉死 (user, wordbook)，一本书的遗忘
 *     绝不打乱其他书的学习节奏。
 *   - **可逆**：apply 前写出一批次 batchId 的日志快照，restore 仅按本批次回写 state。
 *
 * 三段分工（ADR-0020 §3）：本服务只出**确定性候选**（computeAnchorCandidates）→
 * agent 做"模拟遗忘"叙事解读 → **用户确认**。agent 只叙事、不决策；apply 的
 * `confirmedAnchorIds` 即用户确认集，且必须仍在**重算**候选集内，否则视为
 * "preview 已过期"拒绝——这就是防误触（陈旧清单/篡改）的落点。
 *
 * 事务：所有方法（含只读 preview）都经 withTransaction + actorId，因为
 * user_word_progress / user_word_l2_progress / review_logs 均为 owner-RLS 表。
 * 一个方法 = 一个事务：apply 的 L1 挂起 + L2 暂停在同一事务内，L2 段失败则整体回滚。
 *
 * 装配（createServices）留给 T09；本文件只提供可注入依赖的类。
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { BusinessRuleError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import {
  computeAnchorCandidates,
  type AnchorProgressRow,
  type AnchorWordMeta,
} from "../domain/forgetting-anchors";
import type { ForgettingPreviewRow, IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export interface ForgettingServiceDeps {
  /** 事务执行器（默认 withTransaction；测试可注入）。 */
  txRunner?: TxRunner;
  /** 仓库工厂（默认 createRepositories；测试可注入）。 */
  repositoryFactory?: RepositoryFactory;
  /** batchId 生成器（默认 randomUUID；测试可注入确定性实现）。 */
  generateBatchId?: () => string;
}

export interface ForgettingPreviewInput {
  userId: string;
  bookId: string;
}

export interface ForgettingApplyInput {
  userId: string;
  bookId: string;
  /** 用户确认保留的锚点 wordId（必须仍是重算候选集的子集）。 */
  confirmedAnchorIds: string[];
}

export interface ForgettingRestoreInput {
  userId: string;
  bookId: string;
  batchId: string;
}

export interface ForgettingPreview {
  /** 锚点候选 wordId（computeAnchorCandidates 顺序）。 */
  anchors: string[];
  /** 若此刻 apply，将被挂起的 L1 行数（排除锚点 / suspended / new）。 */
  suspendCount: number;
}

export interface ForgettingApplyResult {
  /** 服务生成并写入每条日志 metadata.batchId 的批次 id。 */
  batchId: string;
  suspendedCount: number;
  pausedCount: number;
  anchors: string[];
}

export interface ForgettingRestoreResult {
  restoredCount: number;
  unpausedCount: number;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

/** 去重 + 逐项非空校验；保持用户确认顺序（SQL `<> ALL` 不依赖顺序，但结果回显稳定）。 */
function normalizeAnchorIds(ids: string[]): string[] {
  if (!Array.isArray(ids)) {
    throw new ValidationError("confirmedAnchorIds must be an array", "confirmedAnchorIds");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    requireNonEmpty(id, "confirmedAnchorIds[]");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 仓库预览行 → 纯函数入参（domain 零出向：只做形状映射，无 IO）。 */
function toAnchorInputs(rows: ForgettingPreviewRow[]): {
  progressRows: AnchorProgressRow[];
  wordsMeta: Map<string, AnchorWordMeta>;
} {
  const progressRows: AnchorProgressRow[] = [];
  const wordsMeta = new Map<string, AnchorWordMeta>();
  for (const row of rows) {
    progressRows.push({
      wordId: row.wordId,
      stability: row.stability,
      retrievability: row.retrievability,
      state: row.state,
      recentRatings: row.recentRatings,
      lapseCount: row.lapseCount,
    });
    const meta: AnchorWordMeta = {};
    if (row.morphology != null) meta.morphology = row.morphology;
    if (row.mnemonic != null) meta.mnemonic = row.mnemonic;
    if (row.semanticChain != null) meta.semanticChain = row.semanticChain;
    if (row.aliases.length > 0) meta.aliases = row.aliases;
    wordsMeta.set(row.wordId, meta);
  }
  return { progressRows, wordsMeta };
}

export class ForgettingService {
  private readonly txRunner: TxRunner;
  private readonly repositoryFactory: RepositoryFactory;
  private readonly generateBatchId: () => string;

  constructor(private readonly deps: ForgettingServiceDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repositoryFactory = deps.repositoryFactory ?? createRepositories;
    this.generateBatchId = deps.generateBatchId ?? randomUUID;
  }

  /**
   * 预览（零写入）：读该书 L1 进度 + 词条锚点元数据 → 确定性候选；再给一个
   * "此刻 apply 会挂起多少行"的计数（条件与批量挂起完全一致）。
   */
  async preview({ userId, bookId }: ForgettingPreviewInput): Promise<ForgettingPreview> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(bookId, "bookId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const rows = await repos.reviews.findForgettingPreviewRows(userId, bookId);
      const { progressRows, wordsMeta } = toAnchorInputs(rows);
      const anchors = computeAnchorCandidates({ progressRows, wordsMeta });
      const suspendCount = await repos.reviews.countBulkSuspendCandidates({
        userId,
        wordbookId: bookId,
        keepWordIds: anchors,
      });
      return { anchors, suspendCount };
    }, { actorId: userId });
  }

  /**
   * 应用（单事务）：重算候选 → 校验 confirm 仍在候选集内（陈旧清单/篡改拒绝）
   * → L1 批量挂起（除锚点）+ L2 批量暂停（除锚点）。返回批次与计数。
   */
  async apply({
    userId,
    bookId,
    confirmedAnchorIds,
  }: ForgettingApplyInput): Promise<ForgettingApplyResult> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(bookId, "bookId");
    const anchors = normalizeAnchorIds(confirmedAnchorIds);

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);

      // 重算：候选随复习数据变化，preview 与 apply 之间的漂移必须在这里兜住。
      const rows = await repos.reviews.findForgettingPreviewRows(userId, bookId);
      const { progressRows, wordsMeta } = toAnchorInputs(rows);
      const recomputed = computeAnchorCandidates({ progressRows, wordsMeta });
      const allowed = new Set(recomputed);
      for (const anchorId of anchors) {
        if (!allowed.has(anchorId)) {
          // ADR-0020 防误触落点：清单已过期（或含非本书/未确认的 id）。
          throw new BusinessRuleError("preview 已过期，请重新 preview");
        }
      }

      const batchId = this.generateBatchId();

      // L1 段：批量挂起（除锚点）。L2 段失败 → 整个事务回滚，L1 挂起不落库。
      const suspendedCount = await repos.reviews.bulkSuspendByWordbook({
        userId,
        wordbookId: bookId,
        keepWordIds: anchors,
        batchId,
      });
      const pausedCount = await repos.l2Progress.batchPauseByWordbook({
        userId,
        wordbookId: bookId,
        keepWordIds: anchors,
      });

      return { batchId, suspendedCount, pausedCount, anchors };
    }, { actorId: userId });
  }

  /**
   * 恢复（单事务）：前置校验该批次存在 → 只按本批次日志回写 L1 state →
   * 解除该书 manual 的 L2 暂停。
   *
   * 重复调用语义：无 gone 标记，重复 restore 会在无中间写入的前提下**幂等重放**
   * （再次写入同一快照 state、返回相同计数）——测试显式断言此行为。
   */
  async restore({ userId, bookId, batchId }: ForgettingRestoreInput): Promise<ForgettingRestoreResult> {
    requireNonEmpty(userId, "userId");
    requireNonEmpty(bookId, "bookId");
    requireNonEmpty(batchId, "batchId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const exists = await repos.reviews.findBulkForgetBatch({
        userId,
        wordbookId: bookId,
        batchId,
      });
      if (!exists) {
        throw new NotFoundError("BulkForgetBatch", batchId);
      }
      const restoredCount = await repos.reviews.restoreBulkForget({
        userId,
        wordbookId: bookId,
        batchId,
      });
      const unpausedCount = await repos.l2Progress.batchUnpauseManual(userId, bookId);
      return { restoredCount, unpausedCount };
    }, { actorId: userId });
  }
}
