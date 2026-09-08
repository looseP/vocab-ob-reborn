import type { L3CacheSignal } from "@/l3/frontend/contract";

interface L3HomePageProps {
  cachePolicy: L3CacheSignal;
}

/**
 * 空间总览（工程工具组）：L3 子应用的挂载状态页。
 * 用户主流程入口是「来源书架」（默认落地）；词空间/关联图/批量导入/
 * 手动编辑/提议审查/推荐等工具面见侧栏「工程工具」组。
 */
export function L3HomePage({ cachePolicy }: L3HomePageProps) {
  return (
    <section className="l3-page">
      <p className="eyebrow">L3 Material Space</p>
      <h2>素材空间已启用：阅读、圈记、词卡双向跳转主链路可用。</h2>
      <p className="lede">
        日常入口是侧栏的「来源书架」——导入文章、阅读原文、划词圈记。
        本页为空间状态总览；词空间、语境条目、关联图、批量导入、手动编辑、提议审查、推荐等工具面见左侧「工程工具」组。
      </p>
      <div className="l3-status-grid">
        <div>
          <span>主流程</span>
          <strong>来源书架 → 阅读视图 → 圈记 → 词卡</strong>
        </div>
        <div>
          <span>回流面</span>
          <strong>复习卡 Tier 2 · 词条详情语境区</strong>
        </div>
        <div>
          <span>Cache reason</span>
          <strong>{cachePolicy.reason}</strong>
        </div>
      </div>
    </section>
  );
}
