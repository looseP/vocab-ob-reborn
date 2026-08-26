import { Loader2 } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import type { L2DrillTask } from "@/frontend/hooks/useL2Drill";

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

interface Props {
  task: L2DrillTask;
  disabled: boolean;
  feedback: "correct" | "incorrect" | null;
  onChoose: (choiceIndex: number) => void;
  onNext: () => void;
}

/**
 * 辨析步视图（cloze_mcq / synonym_discrimination 共用）。
 * 注意：不得展示 word.lemma 等词头信息 —— cloze 场景下会泄漏答案（spec D8）。
 */
export function L2DiscriminationTask({ task, disabled, feedback, onChoose, onNext }: Props) {
  const isCloze = task.taskType === "cloze_mcq";
  return (
    <Card className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
          {isCloze ? "语境填空" : "近义辨析"}
        </p>
        <p className="section-title mt-2 text-xl leading-relaxed text-[var(--color-ink)]">
          {task.prompt}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(task.options ?? []).map((option, index) => (
          <Button
            key={`${task.taskId}:${index}`}
            variant="secondary"
            disabled={disabled || feedback !== null}
            onClick={() => onChoose(index)}
            className="justify-start text-left"
          >
            <span className="mr-2 font-semibold text-[var(--color-accent)]">{OPTION_LABELS[index]}</span>
            {option}
          </Button>
        ))}
      </div>

      {feedback === "correct" && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
          <p className="text-sm text-[var(--color-ink)]">答对了，进入产出练习 →</p>
        </div>
      )}
      {feedback === "incorrect" && (
        <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
          <p className="text-sm text-[var(--color-ink)]">答错了。已安排尽快复习这张卡。</p>
          <Button size="sm" onClick={onNext} disabled={disabled}>
            {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            下一题
          </Button>
        </div>
      )}
    </Card>
  );
}
