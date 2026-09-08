// src/frontend/components/review/L3ContextsFold.tsx
/**
 * Tier 2 语境折叠（grill 定案 2026-09-07）：L3 语境是用户自己圈记的真实用法
 * （锚点/网络性质），与 L2 corpus 例句（词典内容，永不上 L1 卡）是两个概念。
 * 折叠保 L1 <5s 速刷节奏；深链 ?sourceId= 直达来源阅读视图（P3-9 模式）。
 * 整个容器 stopPropagation + data-no-flip 防翻转。
 */
import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";

export interface ReviewL3ContextItem {
  context_id: string;
  source_id: string;
  text: string;
  source_title: string;
  /** 语境义快照（Bound sense）：绑定释义/搭配文本，未绑定为 null。 */
  bound_sense: string | null;
}

export function L3ContextsFold({ items }: { items: ReviewL3ContextItem[]; slug: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3 w-full text-left" onClick={(e) => e.stopPropagation()}>
      <details className="group w-full rounded-xl border border-dashed border-[var(--color-border)]" data-no-flip>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-accent)]">
          <BookOpen className="h-3.5 w-3.5" />
          {items.length} 条语境
        </summary>
        <div className="space-y-2 border-t border-[var(--color-border)] px-3 py-2.5 text-left text-[12.5px] leading-relaxed text-[var(--color-ink)]">
          {items.map((item) => (
            <div key={item.context_id}>
              {/* Bound sense（grill 2026-09-08）：圈记时绑定的语境义快照，有则显示 */}
              {item.bound_sense && (
                <p className="text-[11px] text-[var(--color-accent)]">绑定释义：{item.bound_sense}</p>
              )}
              <p>{item.text}</p>
              <p className="text-[11px] text-[var(--color-ink-soft)]">
                {/* P0-2：逐条携带 contextId——深链直达阅读视图并滚动+闪高亮该语境 */}
                <Link
                  to={`/l3?sourceId=${encodeURIComponent(item.source_id)}&contextId=${encodeURIComponent(item.context_id)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="hover:text-[var(--color-accent)]"
                >
                  —— {item.source_title} · 在素材空间查看
                </Link>
              </p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
