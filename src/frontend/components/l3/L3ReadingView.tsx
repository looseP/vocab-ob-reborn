/**
 * 阅读视图（grill 定案 2026-09-07）：渲染来源正文，高亮 = 该来源全部 context
 * 锚点（position.{start,end}，UTF-16 码元）的并集——只亮用户亲手圈过的位置，
 * 不做同形匹配（Q7 定案 A）。
 * 交互隔离（2026-09-08 用户反馈）：高亮文本是纯标记（无点击行为，保证划词/选中
 * 不被劫持）；跳转入口 = 每处圈记句尾的小标号，点击从右侧弹出相关词汇面板，
 * 面板内链接到各绑定词的详情页（单词/多词统一）。
 * 选区圈记交互（S3）通过 mouseup 挂在同一容器。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
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

interface AnchorRange { start: number; end: number; contextId: string; slugs: string[] }

function buildRanges(space: L3ReadingSpace): AnchorRange[] {
  const slugById = new Map(space.words.map((w) => [w.id, w.slug]));
  // 一句话可绑多个词（2026-09-08 修正）：收集该语境的全部 occurrence 对应词
  const slugsByContext = new Map<string, string[]>();
  for (const occ of space.occurrences as Array<{ context_id: string; word_id: string }>) {
    const slug = slugById.get(occ.word_id);
    if (!slug) continue;
    const list = slugsByContext.get(occ.context_id) ?? [];
    if (!list.includes(slug)) list.push(slug);
    slugsByContext.set(occ.context_id, list);
  }
  return space.contexts
    .map((c) => {
      const start = typeof c.position?.start === "number" ? c.position.start : null;
      const end = typeof c.position?.end === "number" ? c.position.end : null;
      if (start == null || end == null || end <= start) return null;
      const slugs = slugsByContext.get(c.id) ?? [];
      return { start, end, contextId: c.id, slugs } satisfies AnchorRange;
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

export function L3ReadingView({ sourceId, onBack, focusContextId }: { sourceId: string; onBack?: () => void; focusContextId?: string }) {
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
  // 交互隔离（2026-09-08 用户反馈）：跳转入品收敛到句尾小标号——右侧相关词汇面板
  const [wordPanel, setWordPanel] = useState<{ contextId: string; slugs: string[]; text: string } | null>(null);
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

  // 相关词汇面板：Esc / 点击面板外关闭（交互优化 2026-09-08）。
  // 徽标点击被排除——点另一个标号只切换面板内容，不闪关。
  useEffect(() => {
    if (!wordPanel) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-word-panel]") || t.closest("[data-context-badge]")) return;
      setWordPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWordPanel(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [wordPanel !== null]);

  // P0 深链聚焦（2026-09-08 评估）：?contextId= 落地后滚动至对应高亮（闪高亮样式由
  // l3-focus-flash 类的 CSS animation 完成）。hooks 须在 early return 之前声明。
  useEffect(() => {
    if (!space || !focusContextId) return;
    const el = textRef.current?.querySelector(`[data-context-id="${focusContextId}"]`);
    if (!el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [space, focusContextId]);

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
    // 交互隔离（2026-09-08 用户反馈）：高亮文本 = 纯标记（无 onClick，可随意划词选中）；
    // 跳转入口 = 句尾小标号，点击打开右侧相关词汇面板（单词/多词统一走面板）。
    // 深链聚焦：与 ?contextId= 匹配的高亮携带闪高亮类（P0-2）
    const focus = focusContextId != null && r.contextId === focusContextId ? " l3-focus-flash" : "";
    if (r.slugs.length > 0) {
      pieces.push(
        <mark
          key={`m${i}`}
          data-context-id={r.contextId}
          className={`rounded bg-[var(--color-accent-soft)] px-0.5 text-[var(--color-accent)]${focus}`}
        >
          {text.slice(r.start, r.end)}
        </mark>,
      );
      pieces.push(
        <button
          key={`b${i}`}
          type="button"
          data-context-badge={r.contextId}
          title="查看这句关联的词汇"
          aria-label={`查看第 ${i + 1} 处圈记关联的词汇`}
          onClick={() => setWordPanel({ contextId: r.contextId, slugs: r.slugs, text: text.slice(r.start, r.end) })}
          className="mx-0.5 inline-flex h-4 w-4 -translate-y-2 cursor-pointer items-center justify-center rounded-full bg-[var(--color-accent)] align-super text-[9px] font-semibold leading-none text-[var(--color-accent-contrast,var(--color-surface))] transition-transform hover:scale-110"
        >
          {i + 1}
        </button>,
      );
    } else {
      pieces.push(
        <mark key={`m${i}`} data-context-id={r.contextId} className={`rounded bg-[var(--color-accent-soft)] px-0.5${focus}`}>{text.slice(r.start, r.end)}</mark>,
      );
    }
    cursor = r.end;
  });
  if (cursor < text.length) pieces.push(<span key="tail">{text.slice(cursor)}</span>);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-ink)]">{space.source.title}</h3>
        <p className="text-[11px] text-[var(--color-ink-soft)]">{space.source.source_type} · {space.source.language ?? "?"} · 圈记 {ranges.length} 处</p>
      </div>
      {wordPanel && (
        <div
          data-word-panel
          data-no-flip
          className="l3-word-panel fixed right-4 top-20 z-30 flex max-h-[calc(100vh-6rem)] w-80 max-w-[85vw] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
            <h4 className="text-[13px] font-semibold text-[var(--color-ink)]">
              相关词汇 <span className="ml-1 rounded-full bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--color-accent)]">{wordPanel.slugs.length}</span>
            </h4>
            <button type="button" onClick={() => setWordPanel(null)} className="text-xs text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]">关闭</button>
          </div>
          <div className="overflow-y-auto px-4 py-3">
            <p className="border-l-2 border-[var(--color-accent)] pl-2.5 text-[12px] leading-relaxed text-[var(--color-ink-soft)]">
              {wordPanel.text.slice(0, 140)}{wordPanel.text.length > 140 ? "…" : ""}
            </p>
            <p className="mt-3 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">跳转到词条</p>
            <ul className="space-y-2">
              {wordPanel.slugs.map((slug) => (
                <li key={slug}>
                  <Link
                    to={`/words/${encodeURIComponent(slug)}`}
                    className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2 text-[13px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                  >
                    <span className="font-medium">{slug}</span>
                    <span className="text-[11px] text-[var(--color-ink-soft)]">查看词条 →</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
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
