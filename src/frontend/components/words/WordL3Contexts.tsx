/**
 * 详情页 L3 语境区（grill 定案 2026-09-07：词卡访问素材方向）。
 * 数据源 = 既有 GET /api/l3/words/:slug/contexts（只读，零后端新增）。
 * 快记表单见 Task 17（Batch D）。每条目深链 ?sourceId= 直达阅读视图。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";

export interface WordL3ListItem {
  context: { id: string; text: string; created_at: string };
  source: { id: string; title: string };
}

export function WordL3Contexts({ slug }: { slug: string }) {
  const [items, setItems] = useState<WordL3ListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: WordL3ListItem[] }>(`/l3/words/${encodeURIComponent(slug)}/contexts?limit=10`, { timeoutMs: 20_000 });
      setItems(res.items);
      setError(null);
    } catch {
      setError("语境加载失败");
      setItems([]);
    }
  }, [slug]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-500">{error}</p>}
      {items === null && <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>}
      {items !== null && items.length === 0 && !error && (
        <p className="text-sm text-[var(--color-ink-soft)]">暂无语境记录</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.context.id} className="rounded-lg border border-[var(--color-border)] px-3 py-2">
              <p className="text-[13px] leading-relaxed">{item.context.text}</p>
              <Link to={`/l3?sourceId=${encodeURIComponent(item.source.id)}`} className="mt-1 inline-block text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]">
                —— {item.source.title} · 在素材空间查看
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
