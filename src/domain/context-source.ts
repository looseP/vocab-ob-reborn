/**
 * ContextSource —— L3 语境挂载点预留接口（l2-drill spec D7'/原 P D4）。
 *
 * 红线：L3 不参与 FSRS。本接口只允许返回只读语境片段用于题面丰富化；
 * 默认实现恒返 []，任何接线（FR-12）必须另立 ADR。
 *
 * FR-12 接线：接口签名调整为接受 { userId, wordId } 入参。
 * 原因：L3 语境空间是 user-scoped（每个用户有独立的 l3_sources / l3_contexts
 * 表行），不带 userId 无法正确做 RLS 过滤查询，会返回空或越权。
 *
 * P3-8 扩展：返回类型由 string[] 改为 ContextSnippet[]，携带 contextId /
 * sourceId / sourceTitle 元数据。L2 产出步用这些字段渲染来源徽标和跳转
 * 链接到 L3 语境编辑器。text-only 调用方仍可只取 .text 字段。
 */

/**
 * L3 语境片段查询入参。
 *
 * userId：用户身份（RLS 过滤 + l3 表的 user_id 列匹配）。
 * wordId：目标词 id（l3_occurrences.word_id 匹配）。
 * limit：返回片段数量上限（默认 3，避免一次拉太多拖慢队列建步）。
 */
export interface ContextSnippetLookup {
  userId: string;
  wordId: string;
  limit?: number;
}

/**
 * 单条 L3 语境片段（只读快照）。
 *
 * text：l3_contexts.text 原文（题面丰富化主要数据）。
 * contextId：l3_contexts.id，用于前端"查看原文"跳转。
 * sourceId：l3_sources.id，用于来源徽标悬停/点击导航。
 * sourceTitle：l3_sources.title，用于来源徽标显示文本。
 */
export interface ContextSnippet {
  text: string;
  contextId?: string;
  sourceId?: string;
  sourceTitle?: string;
}

export interface ContextSource {
  /**
   * 返回可选的语境片段，用于 FR-12 题面丰富化。
   *
   * 红线约束：
   * - 只读，绝不写 stability / difficulty / retrievability 等 FSRS 字段
   * - 默认实现恒返 []，保证未接线时不影响任何现有行为
   * - 失败必须吞掉异常返回 []（best-effort，不能让 L3 故障阻塞 L2 队列建步）
   *
   * @param lookup 查询入参（userId + wordId + 可选 limit）
   * @returns 语境片段数组（每条带 .text 原文 + 可选 source 元数据）；空数组表示无可用语境
   */
  getContextSnippets(lookup: ContextSnippetLookup): Promise<ContextSnippet[]>;
}

export const noopContextSource: ContextSource = {
  getContextSnippets: async () => [],
};
