import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Repeat, Zap, BookOpen, Sparkles, RotateCcw, Infinity as InfinityIcon, Undo2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import { DrillSession } from "@/frontend/components/review/DrillSession";
import { ReviewProgressBar } from "@/frontend/components/review/ReviewProgressBar";
import { CompletionCelebration } from "@/frontend/components/review/CompletionCelebration";
import { useReview } from "@/frontend/hooks/useReview";

const reviewModes = [
  { key: "review", icon: Repeat, title: "标准复习", desc: "按 FSRS 间隔重复算法安排的到期卡片", variant: "primary" as const },
  { key: "cram", icon: Zap, title: "练习模式", desc: "完形填空 / 词汇填空自测，错题回尾，不写入复习数据", variant: "secondary" as const },
  { key: "preview", icon: BookOpen, title: "自由复习", desc: "自由浏览词汇，不评分、不写入数据", variant: "secondary" as const },
  { key: "zen", icon: InfinityIcon, title: "禅模式", desc: "无限循环复习，巩固记忆", variant: "secondary" as const },
] as const;

function ReviewModeSelector({ onStart }: { onStart: (mode: string) => void }) {
  return (
    <div className="space-y-6">
      <Card
        className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]"
        onClick={() => onStart("review")}
      >
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
            <Sparkles className="h-7 w-7 text-[var(--color-accent)]" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-[var(--color-ink)]">快速开始</h3>
            <p className="text-sm text-[var(--color-ink-soft)]">直接进入标准复习</p>
          </div>
          <Button size="sm">开始</Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {reviewModes.map((m) => {
          const Icon = m.icon;
          return (
            <Card key={m.key} className="h-full">
              <Icon className="mb-3 h-6 w-6 text-[var(--color-accent)]" />
              <h3 className="mb-1 text-lg font-semibold text-[var(--color-ink)]">{m.title}</h3>
              <p className="mb-4 text-sm text-[var(--color-ink-soft)]">{m.desc}</p>
              <Button size="sm" variant={m.variant} onClick={() => onStart(m.key)}>开始</Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ReviewSession({ reviewMode, wordIds, onBack }: { reviewMode: string; wordIds?: string[]; onBack: () => void }) {
  const { currentCard, mode, loading, error, stats, deferredNewCards, completed, currentIndex, remaining, lastAnswer, startReview, answer, skip, suspendCurrent, undoLast, browseNext, browsePrev, clearWeakSignal } = useReview();

  // 从词条库勾选进入（P2）：强制自由复习浏览模式，不评分、不写入数据
  const isFreeSelection = !!wordIds && wordIds.length > 0;
  const apiMode = isFreeSelection ? "preview" : reviewMode === "zen" ? "review" : reviewMode;
  const isZen = reviewMode === "zen";
  const isPreview = reviewMode === "preview" || isFreeSelection;

  useEffect(() => {
    startReview(apiMode, wordIds);
  }, [startReview, apiMode, wordIds]);

  // Zen mode: auto-restart when completed
  useEffect(() => {
    if (completed && isZen) {
      const timer = setTimeout(() => startReview(apiMode), 800);
      return () => clearTimeout(timer);
    }
  }, [completed, isZen, apiMode, startReview]);

  if (completed && !isZen) {
    return (
      <CompletionCelebration
        stats={stats}
        onRestart={() => startReview(apiMode)}
        onBack={onBack}
      />
    );
  }

  if (completed && isZen) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="text-center">
          <InfinityIcon className="mx-auto mb-3 h-8 w-8 animate-pulse text-[var(--color-accent)]" />
          <p className="text-sm text-[var(--color-ink-soft)]">重新加载队列中...</p>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">禅模式 · 已复习 {stats.reviewed} 张</p>
        </div>
      </div>
    );
  }

  if (error && !currentCard) {
    return (
      <Card>
        <EmptyState
          title="无法加载复习队列"
          description={error}
          action={<Button onClick={() => startReview(reviewMode)}><RotateCcw className="h-4 w-4" />重试</Button>}
        />
      </Card>
    );
  }

  if (!loading && !currentCard && remaining === 0) {
    return (
      <Card>
        <EmptyState
          title="没有待复习的单词"
          description="导入更多单词或稍后再来"
          action={
            <Link to="/words">
              <Button variant="secondary">浏览词条库</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">已复习 {stats.reviewed}</Badge>
          {stats.again > 0 && <Badge tone="warm">不会 {stats.again}</Badge>}
          {stats.hard > 0 && <Badge>困难 {stats.hard}</Badge>}
          {stats.good > 0 && <Badge tone="accent">良好 {stats.good}</Badge>}
          {stats.easy > 0 && <Badge tone="accent">简单 {stats.easy}</Badge>}
          {deferredNewCards > 0 && !isPreview && (
            <Badge tone="warm">{deferredNewCards} 张新卡已延迟（新卡配额）</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastAnswer && !isPreview && (
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void undoLast()}>
              <Undo2 className="h-4 w-4" />撤销
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onBack}>退出</Button>
        </div>
      </div>

      <ReviewProgressBar completed={stats.reviewed} remaining={remaining} />

      <ReviewCardView
        card={currentCard}
        loading={loading}
        error={error}
        preview={isPreview}
        onAnswer={answer}
        onSkip={skip}
        onSuspend={isPreview ? undefined : suspendCurrent}
        onUndo={isPreview ? undefined : undoLast}
        canUndo={!isPreview && !!lastAnswer}
        onPrev={browsePrev}
        onNext={browseNext}
        onClearWeakSignal={clearWeakSignal}
      />
    </div>
  );
}

export function ReviewPage() {
  const [searchParams] = useSearchParams();
  const wordIdsParam = searchParams.get("wordIds");
  const freeWordIds = wordIdsParam ? wordIdsParam.split(",").filter(Boolean) : undefined;
  const [mode, setMode] = useState<"select" | "session">("select");
  const [reviewMode, setReviewMode] = useState("review");

  const handleStart = (m: string) => {
    setReviewMode(m);
    setMode("session");
  };

  const isFreeSelection = !!freeWordIds && freeWordIds.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">复习</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">
          {mode === "select" ? "选择复习模式开始训练" : "复习进行中"}
        </p>
      </div>
      {mode === "select" && !isFreeSelection ? (
        <ReviewModeSelector onStart={handleStart} />
      ) : isFreeSelection ? (
        <ReviewSession reviewMode="preview" wordIds={freeWordIds} onBack={() => setMode("select")} />
      ) : reviewMode === "cram" ? (
        <DrillSession onBack={() => setMode("select")} />
      ) : (
        <ReviewSession reviewMode={reviewMode} onBack={() => setMode("select")} />
      )}
    </div>
  );
}
