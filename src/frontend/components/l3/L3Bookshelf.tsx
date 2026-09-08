/**
 * 书架（grill 定案 c 完整版，2026-09-07）：空间前门。重度使用（2-3 篇/天）
 * → 类型筛选 + 标题/正文搜索 + 排序是核心。导入表单零摩擦：标题默认取首行。
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { useToast } from "@/frontend/components/ui/Toast";

export interface L3SourceListItem {
  id: string; title: string; source_type: string; url: string | null; created_at: string; context_count: number;
}

const TYPE_LABELS: Record<string, string> = {
  web: "公众号/网页", article: "文章/真题", manual: "手动/作文",
  book: "书", video: "视频", audio: "音频", chat: "对话", other: "其他",
};
const FILTERABLE = ["web", "article", "manual", "book", "other"];

export function L3Bookshelf({ onOpen }: { onOpen: (sourceId: string) => void }) {
  const [items, setItems] = useState<L3SourceListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sourceType, setSourceType] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "captures">("recent");
  const [importing, setImporting] = useState(false);
  const [importTitle, setImportTitle] = useState("");
  const [importText, setImportText] = useState("");
  const [importType, setImportType] = useState("article");
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ sort });
      if (sourceType) params.set("sourceType", sourceType);
      if (q.trim()) params.set("q", q.trim());
      const res = await apiFetch<{ items: L3SourceListItem[]; total: number }>(`/l3/sources?${params}`, { timeoutMs: 20_000 });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "书架加载失败");
      setItems([]);
    }
  }, [sourceType, q, sort, addToast]);

  useEffect(() => { void load(); }, [load]);

  const submitImport = async () => {
    const text = importText.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ source: { id: string } }>("/l3/sources", {
        method: "POST",
        body: JSON.stringify({ sourceType: importType, title: importTitle.trim() || text.split("\n")[0].slice(0, 80), contentText: text }),
        timeoutMs: 20_000,
      });
      addToast("success", "已导入书架");
      setImporting(false); setImportText(""); setImportTitle("");
      await load();
      onOpen(res.source.id);
    } catch (err) {
      if (err instanceof BrowserApiError && err.status === 409) {
        addToast("error", "书架中已存在相同内容的文章，未重复导入");
      } else {
        addToast("error", err instanceof BrowserApiError ? err.message : "导入失败，请重试");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setImporting((v) => !v)}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-[var(--color-accent-contrast,var(--color-surface))]">导入文章</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题/正文…"
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
        <button type="button" onClick={() => setSort(sort === "recent" ? "captures" : "recent")}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">{sort === "recent" ? "最新" : "圈记最多"}</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setSourceType(undefined)}
          className={`rounded-full px-3 py-1 text-xs ${sourceType === undefined ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>全部 ({total})</button>
        {FILTERABLE.map((t) => (
          <button key={t} type="button" onClick={() => setSourceType(sourceType === t ? undefined : t)}
            className={`rounded-full px-3 py-1 text-xs ${sourceType === t ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>{TYPE_LABELS[t]}</button>
        ))}
      </div>
      {importing && (
        <div className="space-y-2 rounded-xl border border-[var(--color-accent)] p-3">
          <input value={importTitle} onChange={(e) => setImportTitle(e.target.value)} placeholder="标题（留空自动取正文首行）"
            className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
            onBlur={() => { if (!importTitle.trim() && importText.trim()) setImportTitle(importText.trim().split("\n")[0].slice(0, 80)); }}
            placeholder="粘贴正文（公众号文章 / 真题阅读 / 作文）"
            rows={8} className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-[13px]" />
          <div className="flex items-center gap-2">
            <select value={importType} onChange={(e) => setImportType(e.target.value)} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">
              {Object.entries(TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <button type="button" disabled={saving || !importText.trim()} onClick={() => void submitImport()}
              className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">导入</button>
          </div>
        </div>
      )}
      <ul className="space-y-2">
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item.id)}
              className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-ink)]">{item.title}</span>
                <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]">{TYPE_LABELS[item.source_type] ?? item.source_type}</span>
                <span className="shrink-0 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--color-accent)]">{item.context_count} 语境</span>
              </div>
            </button>
          </li>
        ))}
        {items !== null && items.length === 0 && <li className="text-sm text-[var(--color-ink-soft)]">书架空空如也——导入第一篇文章吧</li>}
      </ul>
    </div>
  );
}
