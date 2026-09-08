/**
 * 详情页 L3 语境区（grill 定案 2026-09-07：词卡访问素材方向）。
 * 数据源 = 既有 GET /api/l3/words/:slug/contexts（只读，零后端新增）。
 * 快记表单见 Task 17（Batch D）。每条目深链 ?sourceId= 直达阅读视图。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { useToast } from "@/frontend/components/ui/Toast";

export interface WordL3ListItem {
  context: { id: string; text: string; created_at: string };
  source: { id: string; title: string };
}

export function WordL3Contexts({ slug }: { slug: string }) {
  const [items, setItems] = useState<WordL3ListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

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

  const quickAdd = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      await apiFetch("/l3/quick-context", { method: "POST", body: JSON.stringify({ slug, text }), timeoutMs: 20_000 });
      setDraft("");
      addToast("success", "已记录一条语境");
      await reload();
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "快记失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  // P0 语境管理出口（2026-09-08 评估）：capture-first 无门控，噪音靠随手清理而非门控。
  // 复用既有 DELETE /api/l3/contexts/:id（服务端 blockers 409 保护）；occurrences 随 FK cascade。
  const deleteContext = async (contextId: string) => {
    if (!window.confirm("删除这条语境记录？阅读视图中的对应高亮将一并移除，此操作不可恢复。")) return;
    try {
      await apiFetch(`/l3/contexts/${encodeURIComponent(contextId)}`, { method: "DELETE", timeoutMs: 20_000 });
      addToast("success", "已删除该语境记录");
      await reload();
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "删除失败，请重试");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void quickAdd(); }}
          placeholder="粘贴句子/长难句，Ctrl+Enter 快记"
          rows={2}
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
        />
        <button type="button" onClick={() => void quickAdd()} disabled={saving || !draft.trim()}
          className="shrink-0 self-end rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">快记</button>
      </div>
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
              <p className="mt-1 flex items-center gap-3 text-[11px] text-[var(--color-ink-soft)]">
                <Link to={`/l3?sourceId=${encodeURIComponent(item.source.id)}&contextId=${encodeURIComponent(item.context.id)}`} className="hover:text-[var(--color-accent)]">
                  —— {item.source.title} · 在素材空间查看
                </Link>
                <button
                  type="button"
                  onClick={() => void deleteContext(item.context.id)}
                  className="transition-colors hover:text-red-500"
                >
                  删除
                </button>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
