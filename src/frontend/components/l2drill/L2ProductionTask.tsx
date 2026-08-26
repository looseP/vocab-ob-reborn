import { useState } from "react";
import { Link } from "react-router-dom";
import { Eye, BookMarked } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import type { L2DrillTask } from "@/frontend/hooks/useL2Drill";

interface Props {
  task: L2DrillTask;
  disabled: boolean;
  onVerdict: (verdict: "passed" | "weak") => void;
}

/**
 * Production-step view: active recall + self-assessment.
 * Zero FSRS - verdict only updates the capability stage (spec D6').
 *
 * P3-8: 若 task.sourceTitle / task.contextId 存在，说明 referenceExample 来
 * 自 L3 语境空间。渲染来源徽标 + 跳转链接到 L3 入口（L3Page 是 SPA 内部
 * section 切换，暂不支持 deep link，所以这里只跳到 /l3 让用户手动查找；
 * 后续 P3-9 可加 query param 支持 ?contextId=xxx 自动加载语境详情）。
 */
export function L2ProductionTask({ task, disabled, onVerdict }: Props) {
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const hasL3Source = Boolean(task.sourceTitle);

  return (
    <Card className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
          Active production
        </p>
        <p className="section-title mt-2 text-xl leading-relaxed text-[var(--color-ink)]">
          {task.prompt}
        </p>
        {task.hintTranslation && (
          <div className="mt-3">
            <Badge tone="accent">{task.hintTranslation}</Badge>
          </div>
        )}
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Write your sentence from memory (local only, never saved or judged)"
        rows={3}
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-3 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-border-strong)]"
      />

      {task.referenceExample && (
        <div className="space-y-2">
          {revealed ? (
            <div className="space-y-2">
              <p className="rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm text-[var(--color-ink-soft)]">
                Reference: {task.referenceExample}
              </p>
              {hasL3Source && (
                <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge tone="warm" className="flex items-center gap-1">
                      <BookMarked size={12} /> L3 来源
                    </Badge>
                    <span className="text-xs text-[var(--color-ink-soft)]">
                      {task.sourceTitle}
                    </span>
                  </div>
                  <Link
                    to="/l3"
                    className="text-xs font-semibold text-[var(--color-accent)]"
                    title={task.contextId ? `contextId: ${task.contextId}` : "前往 L3 语境空间"}
                  >
                    查看原文 →
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setRevealed(true)}>
              <Eye className="h-4 w-4" /> Show reference example
            </Button>
          )}
        </div>
      )}

      <div className="flex gap-3">
        <Button disabled={disabled} onClick={() => onVerdict("passed")}>
          I can use it
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={() => onVerdict("weak")}>
          Not sure / forgot
        </Button>
      </div>
    </Card>
  );
}
