/**
 * 官方证据录入器（2026-09-26）—— 在原文里**框选**生成 evidence 锚点。
 *
 * 为什么是这个交互：`evidence` 是 `l3_sources.content_text` 的 **UTF-16 区间**
 * （`{start, end, label}`）。让人手填 offset 是不可用的摩擦；做题表面里已经有一套
 * 成熟的「段落 data-content-off + 选区→offset」机制（`buildPassageSpans` /
 * `selectionToContentOffsets`），这里复用同一口径，于是：
 *  - 用户在正文里选中一句 → 点「设为本题证据」→ 自动扩到**最小句段**并落锚点；
 *  - 锚点以引用形式列出（能看到标到了哪句），可改标签、可删。
 *
 * 边界：
 *  - **懒加载**：正文只在用户点开本编辑器时才拉（复用
 *    `GET /l3/practice-files/detail` 已有的 `source_content`，不新增端点）；
 *  - 只做**读取与产出锚点**，不写任何题面 —— 提交仍由建卷/改卷面表单负责；
 *  - 选区不在正文内 / 越界 / 与已有锚点重合 → 如实提示，不静默丢弃。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { enclosingSentenceRange } from "./examPassageSpans";

export interface EvidenceAnchor {
  start: number;
  end: number;
  label: string;
}

const LABEL_MAX = 40;

function sourceKey(sourceId: string | null, fileKey: string | null, questionType: string): string {
  return `${questionType}|${sourceId ?? ""}|${fileKey ?? ""}`;
}

/** 段落渲染：每行一个 run，带 `data-content-off`（与做题表面同一坐标口径）。 */
function PassageView({ content, anchors }: { content: string; anchors: readonly EvidenceAnchor[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const ranges = useMemo(
    () => anchors.map((a) => [a.start, a.end] as const),
    [anchors],
  );
  return (
    <div
      ref={ref}
      data-testid="evidence-passage"
      className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] px-3 py-2 text-[13px] leading-relaxed"
    >
      {content.split("\n").map((line, index) => {
        if (line.length === 0) return null;
        // 行首在 content 里的偏移：前面各行 + 每行一个换行符
        const offset = content.split("\n").slice(0, index).reduce((sum, part) => sum + part.length + 1, 0);
        const covered = ranges.some(([start, end]) => start < offset + line.length && end > offset);
        return (
          <span
            key={index}
            data-content-off={offset}
            className={covered ? "rounded bg-[var(--color-highlight)]" : undefined}
          >
            {line}
          </span>
        );
      })}
    </div>
  );
}

export function QuestionEvidenceEditor({
  sourceId,
  fileKey,
  questionType,
  anchors,
  onChange,
  onError,
}: {
  sourceId: string | null;
  fileKey: string | null;
  questionType: string;
  anchors: readonly EvidenceAnchor[];
  onChange(next: EvidenceAnchor[]): void;
  onError(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [nonce, setNonce] = useState(0);

  // 换题/换材料时收起并丢弃已拉正文（正文属于某一 (题型,来源) 组合）
  useEffect(() => {
    setOpen(false);
    setContent(null);
    setLoadFailed(false);
    setPendingLabel("");
  }, [sourceKey(sourceId, fileKey, questionType), nonce]);

  const load = useCallback(() => {
    if (!sourceId) return;
    setLoading(true);
    setLoadFailed(false);
    const params = new URLSearchParams({ questionType });
    if (sourceId) params.set("sourceId", sourceId);
    if (fileKey) params.set("fileKey", fileKey);
    apiFetch<{ source_content: string | null }>(`/l3/practice-files/detail?${params.toString()}`)
      .then((body) => {
        setContent(body.source_content ?? "");
      })
      .catch(() => {
        setLoadFailed(true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [sourceId, fileKey, questionType]);

  const capture = useCallback(() => {
    if (content === null) return;
    const selection = window.getSelection();
    const container = document.querySelector('[data-testid="evidence-passage"]');
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !container) {
      onError("请先在原文里选中一段文字");
      return;
    }
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    const offsetOf = (node: Node): number | null => {
      if (node.nodeType !== Node.TEXT_NODE) return null;
      const host = node.parentElement?.closest<HTMLElement>("[data-content-off]");
      const base = host ? Number(host.dataset.contentOff) : Number.NaN;
      return Number.isFinite(base) ? base : null;
    };
    const startBase = offsetOf(startNode);
    const endBase = offsetOf(endNode);
    if (startBase == null || endBase == null) {
      onError("选区不在原文内：请在上面的正文块里选择");
      return;
    }
    const sentence = enclosingSentenceRange(content, startBase + range.startOffset, endBase + range.endOffset);
    if (sentence.end > content.length || sentence.end <= sentence.start) {
      onError("选区越界：请重新选择");
      return;
    }
    if (anchors.some((a) => a.start === sentence.start && a.end === sentence.end)) {
      onError("这一句已经是证据了");
      return;
    }
    const quote = content.slice(sentence.start, sentence.end);
    const auto = quote.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
    setPendingLabel((prev) => prev || auto);
    const label = (pendingLabel.trim() || auto).slice(0, LABEL_MAX);
    onChange([...anchors, { start: sentence.start, end: sentence.end, label }]);
    setPendingLabel("");
    selection.removeAllRanges();
  }, [anchors, content, onChange, onError, pendingLabel]);

  if (!sourceId) {
    return (
      <p className="text-[11px] text-[var(--color-ink-soft)]">
        该题型无阅读材料，官方证据不适用（证据是原文的区间）。
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="evidence-editor">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="evidence-toggle"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && content === null && !loading) load();
          }}
          className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-[11px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          {open ? "收起原文" : `标官方证据${anchors.length > 0 ? `（已标 ${anchors.length}）` : ""}`}
        </button>
        {anchors.length > 0 && (
          <button
            type="button"
            data-testid="evidence-clear"
            onClick={() => onChange([])}
            className="text-[11px] text-[var(--color-ink-soft)] underline decoration-dotted underline-offset-2"
          >
            清空全部
          </button>
        )}
      </div>

      {open && (
        <>
          {loading && <p className="text-[11px] text-[var(--color-ink-soft)]">原文加载中…</p>}
          {loadFailed && (
            <p className="text-[11px] text-[var(--color-ink-soft)]">
              原文加载失败。
              <button type="button" onClick={load} className="ml-1 underline">重试</button>
            </p>
          )}
          {content !== null && !loading && (
            <>
              <PassageView content={content} anchors={anchors} />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="evidence-capture"
                  onClick={capture}
                  className="rounded-full border border-[var(--color-accent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)]"
                >
                  设为本题证据
                </button>
                <span className="text-[11px] text-[var(--color-ink-soft)]">
                  在上面选中一句 → 自动扩到最小句段
                </span>
              </div>
            </>
          )}
        </>
      )}

      {anchors.length > 0 && (
        <ul className="space-y-1">
          {anchors.map((anchor, index) => (
            <li
              key={`${anchor.start}:${anchor.end}`}
              className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-2 py-1 text-[11px]"
              data-testid="evidence-item"
            >
              <span className="flex-1 text-[var(--color-ink-soft)]">
                <span className="font-medium text-[var(--color-ink)]">{anchor.label}</span>
                {content !== null && (
                  <span className="ml-1">「{content.slice(anchor.start, anchor.end).replace(/\s+/g, " ").slice(0, 60)}」</span>
                )}
                <span className="ml-1 opacity-70">[{anchor.start}, {anchor.end})</span>
              </span>
              <button
                type="button"
                data-testid="evidence-remove"
                onClick={() => onChange(anchors.filter((_, i) => i !== index))}
                className="shrink-0 text-[var(--color-ink-soft)] underline decoration-dotted underline-offset-2"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
