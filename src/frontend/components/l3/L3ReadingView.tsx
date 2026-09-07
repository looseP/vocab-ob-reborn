/**
 * 阅读视图（grill 定案 2026-09-07）：渲染来源正文，高亮 = 该来源全部 context
 * 锚点（position.{start,end}，UTF-16 码元）的并集——只亮用户亲手圈过的位置，
 * 不做同形匹配（Q7 定案 A）。点击高亮 → 词卡详情（"从素材访问词卡"）。
 * 选区圈记交互（S3）通过 onSelectionAvailable 挂到同一容器。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

export interface L3ReadingWord { id: string; slug: string; title: string }
export interface L3ReadingContext { id: string; text: string; position: { start?: number; end?: number } }
export interface L3ReadingSpace {
  source: { id: string; title: string; source_type: string; language: string | null; content_text: string | null };
  contexts: L3ReadingContext[];
  occurrences: unknown[];
  links: unknown[];
  words: L3ReadingWord[];
  stats: Record<string, unknown>;
}

interface AnchorRange { start: number; end: number; contextId: string; slug: string | null }

function buildRanges(space: L3ReadingSpace): AnchorRange[] {
  const slugById = new Map(space.words.map((w) => [w.id, w.slug]));
  const wordIdByContext = new Map<string, string>();
  for (const occ of space.occurrences as Array<{ context_id: string; word_id: string }>) {
    if (!wordIdByContext.has(occ.context_id)) wordIdByContext.set(occ.context_id, occ.word_id);
  }
  return space.contexts
    .map((c) => {
      const start = typeof c.position?.start === "number" ? c.position.start : null;
      const end = typeof c.position?.end === "number" ? c.position.end : null;
      if (start == null || end == null || end <= start) return null;
      const wordId = wordIdByContext.get(c.id);
      return { start, end, contextId: c.id, slug: wordId ? slugById.get(wordId) ?? null : null } satisfies AnchorRange;
    })
    .filter((r): r is AnchorRange => r !== null)
    .sort((a, b) => a.start - b.start);
}

export function L3ReadingView({ sourceId }: { sourceId: string }) {
  const [space, setSpace] = useState<L3ReadingSpace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<L3ReadingSpace>(`/l3/sources/${encodeURIComponent(sourceId)}/space`, { timeoutMs: 20_000 });
      setSpace(res);
      setError(null);
    } catch (err) {
      setError(err instanceof BrowserApiError ? err.message : "来源加载失败");
      setSpace(null);
    }
  }, [sourceId]);

  useEffect(() => { void reload(); }, [reload]);

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!space) return <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>;
  const text = space.source.content_text;
  if (!text) return <p className="text-sm text-[var(--color-ink-soft)]">该来源无正文</p>;

  const ranges = buildRanges(space);
  const pieces: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    if (r.start > cursor) pieces.push(<span key={`t${i}`}>{text.slice(cursor, r.start)}</span>);
    const slug = r.slug;
    pieces.push(
      slug ? (
        <Link key={`m${i}`} to={`/words/${encodeURIComponent(slug)}`} className="rounded bg-[var(--color-accent-soft)] px-0.5 text-[var(--color-accent)] hover:underline">
          {text.slice(r.start, r.end)}
        </Link>
      ) : (
        <mark key={`m${i}`} className="rounded bg-[var(--color-accent-soft)] px-0.5">{text.slice(r.start, r.end)}</mark>
      ),
    );
    cursor = r.end;
  });
  if (cursor < text.length) pieces.push(<span key="tail">{text.slice(cursor)}</span>);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-ink)]">{space.source.title}</h3>
        <p className="text-[11px] text-[var(--color-ink-soft)]">{space.source.source_type} · {space.source.language ?? "?"} · 圈记 {ranges.length} 处</p>
      </div>
      <div className="whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[13.5px] leading-relaxed text-[var(--color-ink)]" data-reading-text>
        {pieces}
      </div>
      <Link to="/l3" className="inline-block text-xs text-[var(--color-accent)] hover:underline">返回书架</Link>
    </div>
  );
}
