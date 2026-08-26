/**
 * L3ContextSourceAdapter —— FR-12 接线2：把 L3 语境空间适配为 ContextSource。
 *
 * 职责：包装 L3ContextRepository.listContextsForWord，返回语境片段（带
 * contextId/sourceId/sourceTitle 元数据）供 L2 任务生成器
 * （buildL2ProductionTask）用作 referenceExample + 来源徽标跳转。
 *
 * 红线（ADR-0005 + l2-drill spec D7'）：
 * - 只读消费，绝不写 stability/difficulty/retrievability 等 FSRS 字段
 * - L3 数据是 user-scoped，必须带 actorId=userId 的事务查询（RLS）
 * - best-effort：失败由调用方（L2DrillService.fetchContextSnippets）吞掉返回 []
 *
 * 事务策略：L3ContextSourceAdapter 自带 withTransaction。即使在 L2DrillService
 * 的 L2 事务内被调用，也会开一个独立的 L3 只读事务。两个事务都设置同一个
 * actorId（userId），RLS 都能正确过滤。L3 查询只 LIMIT 3 条，不会长时间占用连接。
 *
 * P3-8 扩展：返回 ContextSnippet[] 而非 string[]，携带 source 元数据用于
 * L2 产出步卡片渲染来源徽标 + 跳转链接（不破坏 text-only 调用方）。
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { L3PaginatedList, L3WordContextListItem } from "../domain";
import type { ContextSnippet, ContextSnippetLookup, ContextSource } from "../domain/context-source";
import type { IL3ContextRepository } from "../repositories/interfaces";

/** 默认返回片段数量上限（避免一次拉太多拖慢 L2 队列建步）。 */
const DEFAULT_SNIPPET_LIMIT = 3;

/** 可注入的事务运行器（测试可替换为 mock）。 */
type TxRunner = typeof withTransaction;

export interface L3ContextSourceAdapterDeps {
  /**
   * 事务运行器。生产环境用原生 withTransaction；测试可注入 mock
   * 以避免真实数据库连接。
   */
  txRunner?: TxRunner;
  /**
   * 仓库工厂。生产环境用 createRepositories；测试可注入 mock
   * 返回预设的 l3Context。
   */
  repoFactory?: (tx?: unknown) => { l3Context: IL3ContextRepository };
}

export class L3ContextSourceAdapter implements ContextSource {
  private readonly txRunner: TxRunner;
  private readonly repoFactory: (tx?: unknown) => { l3Context: IL3ContextRepository };

  constructor(deps: L3ContextSourceAdapterDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repoFactory = deps.repoFactory ?? (createRepositories as unknown as (tx?: unknown) => { l3Context: IL3ContextRepository });
  }

  async getContextSnippets(lookup: ContextSnippetLookup): Promise<ContextSnippet[]> {
    const limit = lookup.limit ?? DEFAULT_SNIPPET_LIMIT;
    // actorId=userId：RLS 依赖 request.jwt.claim.sub，必须在事务内设置
    return this.txRunner(
      async (tx) => {
        const repos = this.repoFactory(tx);
        const page: L3PaginatedList<L3WordContextListItem> = await repos.l3Context.listContextsForWord({
          userId: lookup.userId,
          wordId: lookup.wordId,
          limit,
        });
        // 返回 ContextSnippet：原文 + 可选来源元数据（contextId/sourceId/sourceTitle）
        // L2 任务生成器用 .text 字段作为 referenceExample，前端用 .sourceTitle /
        // .contextId 渲染来源徽标和"查看原文"跳转。
        return page.items.map((item): ContextSnippet => ({
          text: item.context.text,
          contextId: item.context.id,
          sourceId: item.context.source_id,
          sourceTitle: item.source?.title,
        }));
      },
      { actorId: lookup.userId },
    );
  }
}
