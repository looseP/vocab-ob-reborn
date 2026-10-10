/**
 * ReviewCardsService — 复习队列编辑（P1，2026-10-10）。
 *
 * 两个能力，均为**用户主动的队列编辑**（与 ADR-0020「遗忘 = 挂起」的分野见
 * 迁移 0053 头注释）：
 *  - `removeCards`：移出复习队列 —— 物理删除进度行 + `card_removed` 审计日志；
 *    幂等（未命中即零行）；重新加入后 FSRS 从头。
 *  - `expireCards`：提前到期 —— due_at 提到现在（只提前、从不延后；挂起词除外）。
 *    复习候选池排序 `due_at ASC NULLS LAST` 使这批词立即先于其他新卡、与到期卡
 *    同池排队 —— 这就是「优先学习指定内容」的最小实现（不动调度算法）。
 *
 * 事务：user_word_progress 为 owner-RLS 表，两个方法都经 withTransaction + actorId，
 * 一个方法 = 一个事务。scope 由服务层校验（非空、去重）后钉死 (user, wordbook) 传入。
 */

import type { PoolClient } from "pg";
import { BusinessRuleError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IRepositories } from "../repositories/interfaces";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export interface ReviewCardsMutationInput {
  userId: string;
  wordbookId: string;
  wordIds: string[];
}

export interface ReviewCardsMutationResult {
  ok: true;
  /** 实际生效的行数（remove：被删行数；expire：被提前的行数——已到期的词不在内）。 */
  count: number;
  /** 实际生效的 wordId（未命中/无需变更的 id 不返回）。 */
  wordIds: string[];
}

export class ReviewCardsService {
  constructor(
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  /** 归一化：去重 + 非空校验（与 enqueueCards 的输入口径一致）。 */
  private normalize(input: ReviewCardsMutationInput): string[] {
    if (input.wordIds.length === 0) {
      throw new BusinessRuleError("wordIds must not be empty");
    }
    return [...new Set(input.wordIds)];
  }

  /** 移出复习队列：删除进度行 + card_removed 审计（同一事务）。 */
  async removeCards(input: ReviewCardsMutationInput): Promise<ReviewCardsMutationResult> {
    const wordIds = this.normalize(input);
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const removed = await repos.reviews.removeCardsByWordIds({
          userId: input.userId,
          wordbookId: input.wordbookId,
          wordIds,
        });
        return { ok: true as const, count: removed.length, wordIds: removed };
      },
      { actorId: input.userId },
    );
  }

  /** 提前到期：due_at 提到现在（只提前、从不延后；挂起词不动）。 */
  async expireCards(input: ReviewCardsMutationInput): Promise<ReviewCardsMutationResult> {
    const wordIds = this.normalize(input);
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const expired = await repos.reviews.expireCardsByWordIds({
          userId: input.userId,
          wordbookId: input.wordbookId,
          wordIds,
        });
        return { ok: true as const, count: expired.length, wordIds: expired };
      },
      { actorId: input.userId },
    );
  }
}
