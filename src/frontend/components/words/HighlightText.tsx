interface HighlightTextProps {
  text: string;
  /** 要高亮的关键词（大小写不敏感）；为空或全空格时不渲染高亮。 */
  highlight: string;
}

/**
 * 搜索结果关键词高亮（A2）：把 text 中与 highlight 大小写不敏感匹配的子串
 * 用 <mark class="search-highlight"> 包裹。查询词已做正则转义，可安全用于 split。
 */
export function HighlightText({ text, highlight }: HighlightTextProps) {
  const q = highlight.trim();
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  const lowerQ = q.toLowerCase();
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lowerQ ? (
          <mark key={i} className="search-highlight">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
