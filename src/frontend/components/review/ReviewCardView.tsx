import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { Link } from "react-router-dom";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const ratings = [
  { value: "again", label: "重来", variant: "danger" as const },
  { value: "hard", label: "困难", variant: "secondary" as const },
  { value: "good", label: "良好", variant: "secondary" as const },
  { value: "easy", label: "简单", variant: "primary" as const },
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
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Badge tone="accent">{card.state}</Badge>
          {card.reviewCount > 0 && <Badge>复习 {card.reviewCount} 次</Badge>}
        </div>
        <Link
          to={`/words/${card.word.slug}`}
          className="text-sm font-semibold text-[var(--color-accent)]"
        >
          查看详情
        </Link>
      </div>

      <div className="text-center">
        <h2 className="section-title text-4xl font-bold text-[var(--color-ink)]">
          {card.word.lemma}
        </h2>
        {card.word.title !== card.word.lemma && (
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{card.word.title}</p>
        )}
      </div>

      <div className="flex justify-center gap-2 pt-4">
        {ratings.map((r) => (
          <Button
            key={r.value}
            variant={r.variant}
            size="lg"
            disabled={loading}
            onClick={() => onAnswer(r.value)}
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
