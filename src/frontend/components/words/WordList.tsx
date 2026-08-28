import { Link } from "react-router-dom";
import { Card } from "@/frontend/components/ui/Card";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { HighlightText } from "@/frontend/components/words/HighlightText";
import type { WordListItem } from "@/frontend/hooks/useWords";

interface WordListProps {
  words: WordListItem[];
  loading: boolean;
  error: string | null;
  /** 自由复习勾选模式（P2）：行内渲染复选框，选中词可进入自由复习。 */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  /** 搜索结果关键词高亮（A2）：在 lemma / 中文释义中高亮匹配子串。 */
  highlight?: string;
}

export function WordList({
  words,
  loading,
  error,
  selectable,
  selectedIds,
  onToggleSelect,
  highlight,
}: WordListProps) {
  if (loading && words.length === 0) {
    return (
      <Card className="flex items-center justify-center py-12">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载中...</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="py-12 text-center">
        <p className="text-[var(--color-accent-2)]">{error}</p>
      </Card>
    );
  }

  if (words.length === 0) {
    return (
      <Card className="py-12 text-center">
        <p className="text-[var(--color-ink-soft)]">没有找到匹配的单词</p>
      </Card>
    );
  }

  if (selectable) {
    return (
      <div className="space-y-2">
        {words.map((word) => {
          const checked = selectedIds?.has(word.id) ?? false;
          return (
            <Card
              key={word.id}
              className="flex items-center justify-between py-4 transition-colors hover:border-[var(--color-border-strong)]"
            >
              <label className="flex cursor-pointer items-center gap-4">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelect?.(word.id)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <div>
                  <p className="text-lg font-semibold text-[var(--color-ink)]">
                    <HighlightText text={word.lemma} highlight={highlight ?? ""} />
                  </p>
                  {word.short_definition && (
                    <p className="text-sm text-[var(--color-ink-soft)]">
                      <HighlightText text={word.short_definition} highlight={highlight ?? ""} />
                    </p>
                  )}
                </div>
              </label>
              <div className="flex items-center gap-2 text-xs">
                {word.pos && (
                  <span className="text-[var(--color-ink-soft)]">{word.pos}</span>
                )}
                {word.cefr && (
                  <span className="rounded-full bg-[var(--color-pill-bg)] px-2 py-0.5 text-[var(--color-pill-text)]">
                    {word.cefr}
                  </span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {words.map((word) => (
        <Link key={word.slug} to={`/words/${word.slug}`}>
          <Card className="flex items-center justify-between py-4 transition-colors hover:border-[var(--color-border-strong)]">
            <div className="flex items-center gap-4">
              <div>
                <p className="text-lg font-semibold text-[var(--color-ink)]">
                  <HighlightText text={word.lemma} highlight={highlight ?? ""} />
                </p>
                {word.short_definition && (
                  <p className="text-sm text-[var(--color-ink-soft)]">
                    <HighlightText text={word.short_definition} highlight={highlight ?? ""} />
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {word.pos && (
                <span className="text-[var(--color-ink-soft)]">{word.pos}</span>
              )}
              {word.cefr && (
                <span className="rounded-full bg-[var(--color-pill-bg)] px-2 py-0.5 text-[var(--color-pill-text)]">
                  {word.cefr}
                </span>
              )}
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}
