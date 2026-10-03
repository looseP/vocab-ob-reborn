/// <reference lib="dom" />
/**
 * exam 切分块的**共享渲染件**（2026-10-03）。
 *
 * 为什么要独立成文件：`reading.split[i]` 里的 `[]` 与 `｜` 是**数据编码**，不是句子内容。
 * 实测真库 154 个片段含 `[`、其中 153 个含 `｜`，编码形态有三种：
 *   ① `[片段｜定]` ② `[片段]` ③ `[片段]｜状,`
 * （分布与解析规则见 `@/domain/word-exam` 的 `parseSplitSegments`）
 *
 * 修复前有两个渲染点各自"半解析"：
 * - `review/WordCardExamLayers.tsx` 只 `slice(1,-1)` 剥方括号 ⇒ `｜定` 落进正文（126 词受害）
 * - `words/WordExamPanel.tsx`（词条详情页）直接渲染 `{b.text}` 原文 ⇒ `[]` 与 `｜` 一起泄漏
 *
 * 现在**编码只在契约层解析一次**，两个页面都渲染 `block.segments`，本组件是唯一渲染实现。
 *
 * 设计稿口径（`wordcard-mock-2026-09-11.html`）：
 * - 嵌套片段走 `.nest`（按深度分色：d2 虚线下划线、d3 降透明度）
 * - 分类走**独立的 `.nest-type` 角标**（`:287` v0.5「嵌套类型角标」）
 *   —— 角标与嵌套片段分开渲染，正是「`｜` 不进正文」的关键。
 */
import { Fragment } from "react";
import type { WordExamSplitSegment } from "@/domain/word-exam";

/** 正则元字符转义（目标词可能含 `.` 或 `-`）。 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 嵌套深度样式（mock `.nest` / `.nest.d2` / `.nest.d3` 口径）。 */
const NEST_CLASS: Record<number, string> = {
  1: "font-medium text-[var(--color-accent)]",
  2: "font-medium text-[var(--color-accent)] opacity-80 underline decoration-dotted underline-offset-[3px]",
  3: "font-medium text-[var(--color-accent)] opacity-60",
};

/**
 * 单段文本的遮盖 / 高亮渲染（mock `.mask` 口径）。
 *
 * **不解析任何编码** —— 那是契约层的事。这里只负责"目标词遮挡"这一件事：
 * 未揭示时以**高亮底色隐形**呈现（点击揭示，保留句法结构、不泄露词形长度）；
 * 已揭示时按强调色显示。`term` 为空退化为普通文本。
 */
export function MaskedPiece({
  text,
  term,
  revealed,
  onUnmask,
}: {
  text: string;
  term: string | null;
  revealed: boolean;
  onUnmask?: () => void;
}) {
  const t = term !== null && term.trim().length > 0 ? term : null;
  if (t === null) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(t)})`, "gi"));
  return (
    <>
      {parts.map((part, i) => {
        if (part.toLowerCase() !== t.toLowerCase()) return <span key={i}>{part}</span>;
        if (revealed) {
          return (
            <span key={i} className="font-semibold text-[var(--color-accent)]">
              {part}
            </span>
          );
        }
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            title="点击揭示词形（消耗 H1 提示）"
            data-testid="clue-mask"
            className="inline-block min-w-[4.2em] cursor-pointer rounded-md px-1 text-center align-baseline transition-colors"
            // 同色底 + 同色字 = 隐形但占位：保留句法结构，不泄露词形长度以外的信息
            style={{ background: "var(--color-highlight)", color: "var(--color-highlight)" }}
            onClick={(e) => {
              e.stopPropagation();
              onUnmask?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onUnmask?.();
              }
            }}
          >
            {part}
          </span>
        );
      })}
    </>
  );
}

/**
 * 切分块渲染：嵌套走 `.nest`（按深度分色），分类走独立 `.nest-type` 角标。
 *
 * `maskTerm` 为空时不做遮挡（词条详情页就是这种用法 —— 那里没有"提示等级"概念）。
 */
export function ExamSplitText({
  segments,
  maskTerm = null,
  maskRevealed = true,
  onUnmask,
}: {
  segments: readonly WordExamSplitSegment[];
  maskTerm?: string | null;
  maskRevealed?: boolean;
  onUnmask?: () => void;
}) {
  return (
    <>
      {segments.map((seg, i) => {
        const piece = (
          <MaskedPiece text={seg.text} term={maskTerm} revealed={maskRevealed} onUnmask={onUnmask} />
        );
        if (seg.depth === 0) return <span key={i}>{piece}</span>;
        return (
          <Fragment key={i}>
            <span className={NEST_CLASS[seg.depth] ?? NEST_CLASS[1]}>{piece}</span>
            {seg.nestType !== null && (
              <span
                data-testid="nest-type"
                className="ml-px inline-block rounded-[3px] px-[3px] align-[1px] text-[9.5px] leading-none text-[var(--color-accent)]"
                style={{ background: "rgba(15, 111, 98, 0.08)" }}
              >
                {seg.nestType}
              </span>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
