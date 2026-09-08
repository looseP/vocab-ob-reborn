/**
 * 阅读视图（grill 定案 2026-09-07）：渲染来源正文，高亮 = 该来源全部 context
 * 锚点（position.{start,end}，UTF-16 码元）的并集——只亮用户亲手圈过的位置，
 * 不做同形匹配（Q7 定案 A）。点击高亮 → 词卡详情（"从素材访问词卡"）。
 * 选区圈记交互（S3）通过 onSelectionAvailable 挂到同一容器。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { findSentenceRange } from "@/services/l3-segmentation";
import { useToast } from "@/frontend/components/ui/Toast";

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

/** 选区 → 正文全局 UTF-16 偏移：TreeWalker 累计各文本节点长度。抽为纯函数便于绕过 jsdom Range 限制直测。 */
export function computeGlobalOffsets(container: HTMLElement, startNode: Node, startOffset: number, endNode: Node, endOffset: number): { start: number; end: number } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.textContent?.length ?? 0;
    if (node === startNode) start = total + startOffset;
    if (node === endNode) { end = total + endOffset; break; }
    total += len;
  }
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

export function L3ReadingView({ sourceId, onBack }: { sourceId: string; onBack?: () => void }) {
  const [space, setSpace] = useState<L3ReadingSpace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [capture, setCapture] = useState<{ start: number; end: number; text: string } | null>(null);
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [targetInfo, setTargetInfo] = useState<
    | { state: "idle" }
    | { state: "loading" }
    | { state: "found"; word: { slug: string; title: string; pos: string | null; ipa: string | null; short_definition: string | null } }
    | { state: "miss" }
  >({ state: "idle" });
  const lookupSeq = useRef(0);
  const navigate = useNavigate();
  const { addToast } = useToast();

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

  // 目标词词库回显（用户反馈 2026-09-08）：在库 → 显示基本信息（绑定已有词条）；
  // 不在库 → 提示将自动创建生词条目。300ms 防抖 + seq 忽略过期响应。
  useEffect(() => {
    const slug = target.trim().toLowerCase();
    if (!slug) { setTargetInfo({ state: "idle" }); return; }
    const seq = ++lookupSeq.current;
    setTargetInfo({ state: "loading" });
    const timer = setTimeout(() => {
      apiFetch<{ slug: string; title: string; pos: string | null; ipa: string | null; short_definition: string | null }>(
        `/words/${encodeURIComponent(slug)}`, { timeoutMs: 10_000 })
        .then((word) => {
          if (lookupSeq.current !== seq) return;
          if (word && word.slug) setTargetInfo({ state: "found", word });
          else setTargetInfo({ state: "miss" });
        })
        .catch(() => {
          if (lookupSeq.current === seq) setTargetInfo({ state: "miss" });
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [target]);

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!space) return <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>;
  const text = space.source.content_text;
  if (!text) return <p className="text-sm text-[var(--color-ink-soft)]">该来源无正文</p>;

  const onMouseUp = () => {
    const sel = window.getSelection();
    const container = textRef.current;
    if (!sel || sel.rangeCount === 0 || !container) return setCapture(null);
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return setCapture(null);
    const off = computeGlobalOffsets(container, range.startContainer, range.startOffset, range.endContainer, range.endOffset);
    if (!off) return setCapture(null);
    const selected = text.slice(off.start, off.end);
    if (!selected.trim()) return setCapture(null);
    setCapture({ ...off, text: selected });
    setTarget(selected.trim().split(/\s+/)[0] ?? "");
  };

  const submitCapture = async (mode: "sentence" | "excerpt") => {
    if (!capture || saving) return;
    const surface = target.trim();
    if (!surface) { addToast("error", "请填写目标词"); return; }
    let record = capture.text;
    let anchor = { start: capture.start, end: capture.end };
    if (mode === "sentence" && space?.source.content_text) {
      const seg = findSentenceRange(space.source.content_text, capture.start, capture.end);
      record = seg.text;
      anchor = { start: seg.start, end: seg.end };
    }
    setSaving(true);
    try {
      await apiFetch(`/l3/sources/${encodeURIComponent(sourceId)}/captures`, {
        method: "POST",
        body: JSON.stringify({
          text: record, anchorStart: anchor.start, anchorEnd: anchor.end,
          surface, wordSlug: surface.toLowerCase(), contextType: mode === "sentence" ? "sentence" : "excerpt",
        }),
        timeoutMs: 20_000,
      });
      addToast("success", "已圈记，词卡与语境已关联");
      setCapture(null);
      await reload();
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "圈记失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const ranges = buildRanges(space);
  const pieces: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    if (r.start > cursor) pieces.push(<span key={`t${i}`}>{text.slice(cursor, r.start)}</span>);
    const slug = r.slug;
    pieces.push(
      slug ? (
        // 已绑定高亮用 span 而非 <a>：Chromium 从链接上起手 mousedown 不启动文本选择
        // （拖动被当成点击导航，draggable=false 也无效）；span 保证划词可用，
        // onClick（无活动选区时）编程式跳词卡，保留"点击高亮跳词卡"交互（FR-6.2）。
        <span
          key={`m${i}`}
          className="cursor-pointer rounded bg-[var(--color-accent-soft)] px-0.5 text-[var(--color-accent)] hover:underline"
          title="点击查看词卡"
          onClick={() => {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            navigate(`/words/${encodeURIComponent(slug)}`);
          }}
        >
          {text.slice(r.start, r.end)}
        </span>
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
      {capture && (
        <div className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3 text-[12.5px]" data-no-flip>
          <p className="mb-1.5">已选中：<span className="font-mono">{capture.text.slice(0, 80)}{capture.text.length > 80 ? "…" : ""}</span></p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="目标词"
              className="w-40 rounded border border-[var(--color-border)] px-2 py-1"
            />
            <button type="button" disabled={saving} onClick={() => void submitCapture("sentence")}
              className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">记录整句</button>
            <button type="button" disabled={saving} onClick={() => void submitCapture("excerpt")}
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] disabled:opacity-50">记录搭配</button>
            <button type="button" onClick={() => setCapture(null)} className="text-xs text-[var(--color-ink-soft)]">取消</button>
          </div>
          {targetInfo.state === "loading" && (
            <p className="mt-1.5 text-[11px] text-[var(--color-ink-soft)]">查询词库…</p>
          )}
          {targetInfo.state === "found" && targetInfo.word && (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--color-ink)]">
              <span className="font-semibold text-[var(--color-accent)]">✓ 词库已有</span>
              <Link
                to={`/words/${encodeURIComponent(targetInfo.word.slug)}`}
                className="mx-1 underline"
                onClick={(e) => e.stopPropagation()}
              >
                {targetInfo.word.title}
              </Link>
              {targetInfo.word.ipa && <span className="mr-1 font-mono">{targetInfo.word.ipa}</span>}
              {targetInfo.word.pos && <span className="mr-1 italic">{targetInfo.word.pos}.</span>}
              {targetInfo.word.short_definition && <span>— {targetInfo.word.short_definition} </span>}
              <span className="text-[var(--color-ink-soft)]">（圈记将绑定到该词条）</span>
            </p>
          )}
          {targetInfo.state === "miss" && (
            <p className="mt-1.5 text-[11px] text-[var(--color-ink-soft)]">
              词库中还没有「{target.trim()}」——提交后会自动创建生词条目并绑定
            </p>
          )}
        </div>
      )}
      <div ref={textRef} onMouseUp={onMouseUp} className="whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[13.5px] leading-relaxed text-[var(--color-ink)]" data-reading-text>
        {pieces}
      </div>
      {onBack ? (
        <button type="button" onClick={onBack} className="inline-block text-xs text-[var(--color-accent)] hover:underline">返回书架</button>
      ) : (
        <Link to="/l3" className="inline-block text-xs text-[var(--color-accent)] hover:underline">返回书架</Link>
      )}
    </div>
  );
}
