/**
 * 复习队列的 L3 语境注入（2026-09-07 引入，2026-10-04 从 `review.ts` **外迁**）。
 *
 * 为什么外迁：`src/http/routes/review.ts` 已被路由复杂度棘轮冻结在基线
 * （见 `scripts/verify-route-complexity.ts`），而 FR-12 接线1 升级要给注入项加
 * `surface`（目标词词面，供提示阶梯 H1′ 级遮盖目标词）。仓库惯例是
 * 「受棘轮冻结的路由文件不许增长 ⇒ 逻辑外迁成新文件」
 * （同 `l2-shared.ts` / `l3/sheets-export.ts` 先例）。
 *
 * 口径**完全不变**（外迁只搬家，不改行为）：
 * - 只读 best-effort：L3 故障不阻塞队列（ADR-0016 ContextSource 的 best-effort 哲学）；
 * - 每卡一个独立小查询（带 RLS actor 事务），`limit = 2`，批量方法留作后续优化；
 * - 无语境 / 查不到词条的卡回空数组（前端据此不渲染折叠、也不生成 H1′ 级）。
 */
/** 注入到队列条目上的语境形态（与 `review-response-contract` 的 `l3_contexts[]` 同形）。 */
export interface ReviewL3ContextInjection {
  context_id: string;
  source_id: string;
  text: string;
  source_title: string;
  /** 语境义快照（Bound sense）：绑定释义/搭配文本，未绑定为 null。 */
  bound_sense: string | null;
  /**
   * 目标词在该语境里的词面（`occurrence.surface`）。
   * 消费点：提示阶梯 H1′ 级据此遮盖目标词；缺失时前端回退 lemma，
   * 再定位不到就**整级不生成**（fail-closed，不给未遮盖的句子）。
   */
  surface: string | null;
}

/** 每卡语境条数上限（保持既有口径，勿随手调大：每卡一次独立查询）。 */
export const REVIEW_L3_CONTEXT_LIMIT = 2;

/**
 * 单条语境的**最小结构**（只取注入需要的字段）。
 *
 * 刻意不写 `L3WordContextListItem`：真实仓库返回值字段更宽（含 `links` 等），
 * 而这里的端口只需要"注入用得到的那几个"。窄契约让 http 层与 repository 解耦，
 * 也让测试能直接构造最小 fixture。
 */
export interface L3ContextLookupItem {
  context: { id: string; text: string };
  source: { id: string; title: string };
  occurrence?: { bound_sense?: string | null; surface?: string | null } | null;
}

/** `listContextsForWord` 的最小结构（http 层不直接依赖 repository 类型）。 */
export type L3ContextLookup = (input: {
  userId: string;
  slug: string;
  limit: number;
}) => Promise<{ items: readonly L3ContextLookupItem[] }>;

/**
 * 逐卡取 L3 语境，返回 `wordId → 语境列表`。
 *
 * 无 `slug` 的卡回空数组（队列里允许 slug 缺失）；查询抛错也回空数组 ——
 * 这是 best-effort 契约的落点，调用方不需要再包 try/catch。
 */
export async function loadL3ContextsByWord(input: {
  userId: string;
  words: ReadonlyArray<{ id: string; slug?: string | null }>;
  listContextsForWord: L3ContextLookup;
}): Promise<Map<string, ReviewL3ContextInjection[]>> {
  const results = await Promise.all(
    input.words.map(async (word): Promise<readonly [string, ReviewL3ContextInjection[]]> => {
      if (!word.slug) return [word.id, []] as const;
      try {
        const page = await input.listContextsForWord({
          userId: input.userId,
          slug: word.slug,
          limit: REVIEW_L3_CONTEXT_LIMIT,
        });
        return [
          word.id,
          page.items.map((entry) => ({
            context_id: entry.context.id,
            source_id: entry.source.id,
            text: entry.context.text,
            source_title: entry.source.title,
            // 语境义快照：Tier 2 优先展示绑定释义，fallback 短释义（前端处理）
            bound_sense: entry.occurrence?.bound_sense ?? null,
            /** 词面：H1′ 遮盖锚（见接口注释）。 */
            surface: entry.occurrence?.surface ?? null,
          })),
        ] as const;
      } catch {
        return [word.id, []] as const;
      }
    }),
  );
  return new Map(results);
}
