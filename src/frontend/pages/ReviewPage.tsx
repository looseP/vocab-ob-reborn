import { useEffect, useState } from "react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Repeat, Zap, BookOpen, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import { useReview } from "@/frontend/hooks/useReview";

function ReviewModeSelector() {
  const modes = [
    { href: "/review/standard", icon: Repeat, title: "标准复习", desc: "按间隔重复算法安排的卡片", variant: "primary" as const },
    { href: "/review/drill", icon: Zap, title: "练习模式", desc: "针对性强化练习", variant: "secondary" as const },
    { href: "/review/free", icon: BookOpen, title: "自由复习", desc: "自由选择词汇复习", variant: "secondary" as const },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {modes.map((m) => {
        const Icon = m.icon;
        return (
          <Card key={m.href} className="h-full">
            <Icon className="mb-3 h-6 w-6 text-[var(--color-accent)]" />
            <h3 className="mb-1 text-lg font-semibold">{m.title}</h3>
            <p className="mb-4 text-sm text-[var(--color-ink-soft)]">{m.desc}</p>
            <Link to={m.href}>
              <Button size="sm" variant={m.variant}>开始</Button>
            </Link>
          </Card>
        );
      })}
    </div>
  );
}

function ReviewSession() {
  const { currentCard, loading, error, sessionStats, fetchNext, answer, skip } = useReview();

  useEffect(() => {
    fetchNext();
  }, [fetchNext]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-sm text-[var(--color-ink-soft)]">
          <span>已复习: <strong className="text-[var(--color-ink)]">{sessionStats.reviewed}</strong></span>
          <span>不会: <strong className="text-[var(--color-accent-2)]">{sessionStats.again}</strong></span>
          <span>困难: <strong className="text-[var(--color-highlight)]">{sessionStats.hard}</strong></span>
          <span>良好: <strong className="text-[var(--color-accent)]">{sessionStats.good}</strong></span>
          <span>简单: <strong className="text-[var(--color-accent)]">{sessionStats.easy}</strong></span>
        </div>
      </div>
      <ReviewCardView
        card={currentCard}
        loading={loading}
        error={error}
        onAnswer={(rating) => answer({ rating, wordId: currentCard?.wordId ?? "" })}
        onSkip={() => currentCard && skip(currentCard.wordId)}
      />
    </div>
  );
}

export function ReviewPage() {
  const [mode, setMode] = useState<"select" | "session">("select");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">复习</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            {mode === "select" ? "选择复习模式开始训练" : "复习进行中"}
          </p>
        </div>
        {mode === "session" && (
          <Button variant="ghost" size="sm" onClick={() => setMode("select")}>
            返回
          </Button>
        )}
      </div>
      {mode === "select" ? (
        <>
          <ReviewModeSelector />
          <Card className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]" onClick={() => setMode("session")}>
            <div className="flex items-center gap-4">
              <Sparkles className="h-8 w-8 text-[var(--color-accent)]" />
              <div>
                <h3 className="text-lg font-semibold">快速开始</h3>
                <p className="text-sm text-[var(--color-ink-soft)]">直接进入标准复习</p>
              </div>
            </div>
          </Card>
        </>
      ) : (
        <ReviewSession />
      )}
    </div>
  );
}
