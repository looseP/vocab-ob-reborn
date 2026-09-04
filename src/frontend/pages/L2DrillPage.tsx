import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RotateCcw, Undo2, Zap } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewProgressBar } from "@/frontend/components/review/ReviewProgressBar";
import { L2DiscriminationTask } from "@/frontend/components/l2drill/L2DiscriminationTask";
import { L2ProductionTask } from "@/frontend/components/l2drill/L2ProductionTask";
import { useL2Drill } from "@/frontend/hooks/useL2Drill";

function DrillIntro({ onStart }: { onStart: () => void }) {
  return (
    <Card
      className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]"
      onClick={onStart}
    >
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
          <Zap className="h-7 w-7 text-[var(--color-accent)]" />
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-[var(--color-ink)]">Start drill</h3>
          <p className="text-sm text-[var(--color-ink-soft)]">
            Four-choice discrimination + production self-assessment (L2 track)
          </p>
        </div>
        <Button size="sm">Start</Button>
      </div>
    </Card>
  );
}

function DrillSession({ onBack }: { onBack: () => void }) {
  const {
    currentItem,
    production,
    feedback,
    loading,
    error,
    completed,
    stats,
    remaining,
    startDrill,
    submitChoice,
    submitVerdict,
    advanceAfterFeedback,
    undo,
  } = useL2Drill();

  useEffect(() => {
    startDrill();
  }, [startDrill]);

  if (completed) {
    return (
      <Card>
        <EmptyState
          title="Drill set complete"
          description={`Discrimination ${stats.answered} (correct ${stats.correct} / wrong ${stats.incorrect}) - production self-assessment ${stats.selfPassed + stats.selfWeak}`}
          action={
            <div className="flex gap-3">
              <Button onClick={() => startDrill()}><RotateCcw className="h-4 w-4" />Another set</Button>
              <Link to="/review"><Button variant="secondary">Back to review</Button></Link>
            </div>
          }
        />
      </Card>
    );
  }

  if (error && !currentItem) {
    return (
      <Card>
        <EmptyState
          title="Failed to load drill queue"
          description={error}
          action={<Button onClick={() => startDrill()}><RotateCcw className="h-4 w-4" />Retry</Button>}
        />
      </Card>
    );
  }

  if (!loading && !currentItem) {
    return (
      <Card>
        <EmptyState
          title="No L2 words due for training"
          description="Words graduate here after more L1 review"
          action={<Link to="/review"><Button variant="secondary">Go to review</Button></Link>}
        />
      </Card>
    );
  }

  const doneCount = stats.answered + stats.selfPassed + stats.selfWeak;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Badge tone="accent">Answered {stats.answered}</Badge>
          {stats.correct > 0 && <Badge tone="accent">Correct {stats.correct}</Badge>}
          {stats.incorrect > 0 && <Badge tone="warm">Wrong {stats.incorrect}</Badge>}
          {stats.selfWeak > 0 && <Badge tone="warm">Weak output {stats.selfWeak}</Badge>}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={undo} disabled={loading || doneCount === 0}>
            <Undo2 className="h-4 w-4" />Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>Exit</Button>
        </div>
      </div>

      <ReviewProgressBar completed={doneCount} remaining={remaining} />

      {currentItem && production ? (
        <div className="space-y-3">
          {/* C3 业务联动：单步降级 = 缺辨析素材 → 深链到词条详情的扩展面板 */}
          {currentItem.singleStep && (
            <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2 text-sm text-[var(--color-ink-soft)]">
              「{currentItem.word.lemma}」缺少辨析素材（语料/近义），本次跳过辨析直接产出。
              <Link
                to={`/words/${currentItem.word.slug}`}
                className="ml-1 font-semibold text-[var(--color-accent)]"
              >
                去补充 →
              </Link>
            </p>
          )}
          <L2ProductionTask task={production.task} disabled={loading} onVerdict={submitVerdict} />
        </div>
      ) : currentItem ? (
        <L2DiscriminationTask
          task={currentItem.task}
          disabled={loading}
          feedback={feedback}
          onChoose={submitChoice}
          onNext={advanceAfterFeedback}
        />
      ) : null}
    </div>
  );
}

export function L2DrillPage() {
  const [mode, setMode] = useState<"intro" | "session">("intro");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">Discrimination Drill</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">L2 track - fine-grained word sense discrimination and active production</p>
      </div>
      {mode === "intro" ? (
        <DrillIntro onStart={() => setMode("session")} />
      ) : (
        <DrillSession onBack={() => setMode("intro")} />
      )}
    </div>
  );
}
