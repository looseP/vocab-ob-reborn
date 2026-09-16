import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";

/**
 * 卷面文栏底部「素材笔记」折叠抽屉（批次一）。
 *
 * 复用 GET /l3/sources/:id/space（只读，零后端新增）：展示该 source 已有圈记
 * context 的单行摘录 + 绑定词数，行尾深链回素材空间阅读视图（?contextId= 既有深链）。
 * 本会话经划词「圈词入笔记」新建的 context 打「缓冲」徽标——仅会话内标记，
 * 事后在素材空间处理。默认折叠，首次展开才请求。
 */

interface SourceSpaceResponse {
  contexts: Array<{ id: string; text: string }>;
  occurrences: Array<{ context_id: string }>;
}

interface NoteRow {
  id: string;
  excerpt: string;
  wordCount: number;
}

export function L3SourceNotesDrawer({
  sourceId,
  bufferedIds,
}: {
  sourceId: string;
  bufferedIds?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NoteRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();
  const bufferedSize = bufferedIds?.size ?? 0;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const space = await apiFetch<SourceSpaceResponse>(
          `/l3/sources/${encodeURIComponent(sourceId)}/space`,
          { timeoutMs: 20_000 },
        );
        if (cancelled) return;
        const counts = new Map<string, number>();
        for (const occurrence of space.occurrences ?? []) {
          counts.set(occurrence.context_id, (counts.get(occurrence.context_id) ?? 0) + 1);
        }
        setRows(
          (space.contexts ?? []).map((context) => ({
            id: context.id,
            excerpt: context.text.replace(/\s+/g, " ").trim(),
            wordCount: counts.get(context.id) ?? 0,
          })),
        );
      } catch (error) {
        if (!cancelled) addToast(error instanceof Error ? error.message : "素材笔记加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
    // 打开中新增缓冲圈记（bufferedSize 变化）即刷新列表
  }, [open, sourceId, bufferedSize, addToast]);

  return (
    <div className="mt-3 border-t border-dashed border-[var(--color-border)] pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between whitespace-nowrap text-[11px] font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]"
      >
        <span>素材笔记{rows ? ` · ${rows.length}` : ""}</span>
        <span className="text-[10px]">{open ? "收起 ▴" : "展开 ▸"}</span>
      </button>
      {open && (
        <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {loading && <li className="text-[11px] text-[var(--color-ink-soft)]">加载中…</li>}
          {!loading && rows?.length === 0 && (
            <li className="text-[11px] text-[var(--color-ink-soft)]">暂无圈记，在原文划词即可快速圈入。</li>
          )}
          {rows?.map((row) => (
            <li key={row.id} className="flex items-center gap-2 text-[11px]">
              <Link
                to={`/l3?contextId=${encodeURIComponent(row.id)}`}
                title={row.excerpt}
                className="min-w-0 flex-1 truncate text-[var(--color-accent)] hover:underline"
              >
                {row.excerpt}
              </Link>
              <span className="shrink-0 text-[var(--color-ink-soft)]">{row.wordCount} 词</span>
              {bufferedIds?.has(row.id) && (
                <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-300">
                  缓冲
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
