import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { Spinner } from "@/frontend/components/ui/Spinner";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const ratings = [
  { value: "again", label: "不会", color: "var(--color-accent-2)" },
  { value: "hard", label: "困难", color: "var(--color-highlight)" },
  { value: "good", label: "良好", color: "var(--color-accent)" },
  { value: "easy", label: "简单", color: "var(--color-accent)" },
] as const;

interface ReviewCardViewProps {
  card: ReviewCard | null;
  loading: boolean;
  error: string | null;
  onAnswer: (rating: "again" | "hard" | "good" | "easy") => void;
  onSkip: () => void;
}

export function ReviewCardView({ card, loading, error, onAnswer, onSkip }: ReviewCardViewProps) {
  if (loading && !card) {
    return (
      <Card className="flex items-center justify-center py-20">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载下一张卡片...</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="py-20 text-center">
        <p className="text-[var(--color-accent-2)]">{error}</p>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          重试
        </Button>
      </Card>
    );
  }

  if (!card) {
    return (
      <Card className="py-20 text-center">
        <p className="text-lg text-[var(--color-ink)]">今日复习已完成 🎉</p>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">没有更多待复习的卡片</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-6">
      <div className="text-center">
        <h2 className="section-title text-3xl font-bold text-[var(--color-ink)]">
          {card.lemma}
        </h2>
        <div className="mt-2 flex items-center justify-center gap-3 text-sm text-[var(--color-ink-soft)]">
          {card.pos && <span>{card.pos}</span>}
          {card.cefr && <span className="rounded-full bg-[var(--color-pill-bg)] px-2 py-0.5 text-[var(--color-pill-text)]">{card.cefr}</span>}
          {card.ipa && <span className="font-mono">{card.ipa}</span>}
        </div>
      </div>

      {card.shortDefinition && (
        <p className="text-center text-[var(--color-ink)]">{card.shortDefinition}</p>
      )}

      {card.definitionMd && (
        <div className="prose prose-sm max-w-none text-[var(--color-ink-soft)]">
          {card.definitionMd}
        </div>
      )}

      <div className="flex justify-center gap-2 pt-4">
        {ratings.map((r) => (
          <Button
            key={r.value}
            variant={r.value === "again" ? "danger" : r.value === "easy" ? "primary" : "secondary"}
            size="lg"
            disabled={loading}
            onClick={() => onAnswer(r.value)}
            style={{ borderColor: r.color }}
          >
            {r.label}
          </Button>
        ))}
      </div>

      <div className="text-center">
        <Button variant="ghost" size="sm" disabled={loading} onClick={onSkip}>
          跳过
        </Button>
      </div>
    </Card>
  );
}
