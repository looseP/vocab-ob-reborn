import { useState } from "react";
import { Markdown } from "./Markdown";

/**
 * 自测模式的点击揭示组件：子内容默认模糊（布局占位不变），点击揭示、再点隐藏。
 * 用于词条页自测模式下的答案字段（释义/翻译/辨析结论等）。
 */
export function Reveal({
  children,
  hint = "点击揭示",
  block = false,
}: {
  children: React.ReactNode;
  hint?: string;
  /** block=true 时占满一行（用于整段释义），false 为行内元素。 */
  block?: boolean;
}) {
  const [shown, setShown] = useState(false);

  return (
    <span
      role="button"
      tabIndex={0}
      data-testid="reveal"
      data-shown={shown ? "true" : "false"}
      onClick={() => setShown((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setShown((v) => !v);
        }
      }}
      title={shown ? "点击隐藏" : hint}
      className={`relative ${block ? "block" : "inline-block"} cursor-pointer align-top ${
        shown ? "" : "select-none"
      }`}
    >
      <span
        aria-hidden={!shown}
        className={`transition-all duration-200 ${
          shown ? "" : "pointer-events-none blur-[6px] opacity-70"
        }`}
      >
        {children}
      </span>
      {!shown && (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-[var(--color-ink-soft)]">
          👁 {hint}
        </span>
      )}
    </span>
  );
}

/**
 * 自测模式的 Markdown 渲染：仅模糊加粗（strong）答案片段，其余解释文字保持可见。
 * 释义等富文本无法内插 React 组件（dangerouslySetInnerHTML），
 * 因此用事件委托逐个切换 strong 的揭示状态。
 */
export function RevealMarkdown({ content }: { content: string }) {
  const toggleStrong = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const strong = target.closest("strong");
    if (!strong) return;
    if (strong.style.filter) {
      // 已揭示 → 恢复模糊
      strong.style.filter = "";
      strong.style.opacity = "";
    } else {
      strong.style.filter = "none";
      strong.style.opacity = "1";
    }
  };

  return (
    <div
      data-testid="reveal-markdown"
      onClick={toggleStrong}
      title="先回忆，再点击加粗内容揭示"
      className="[&_strong]:cursor-pointer [&_strong]:select-none [&_strong]:blur-[6px] [&_strong]:opacity-70 [&_strong]:transition-all"
    >
      <Markdown content={content} />
    </div>
  );
}
