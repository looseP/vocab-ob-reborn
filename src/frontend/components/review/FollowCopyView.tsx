/**
 * FollowCopyView —— 巩固轮跟写视图（拍板④：听写 = 跟写的强化，非独立档位）。
 * 词形可见、逐字照打；阻塞式状态机（useTypingFlow）：错字阻塞标红、wrongTimes 只增不减。
 * 听写强化（TTS 先行、失败降跟写）由 LW-2 在本视图上加按钮位接入。
 */

import { useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { useTypingFlow } from "@/frontend/hooks/useTypingFlow";
import { Badge } from "@/frontend/components/ui/Badge";

interface FollowCopyViewProps {
  lemma: string;
  definition: string | null;
  ipa?: string | null;
  disabled?: boolean;
  onDone: (result: { wrongTimes: number }) => void;
}

export function FollowCopyView({ lemma, definition, ipa, disabled, onDone }: FollowCopyViewProps) {
  const [finished, setFinished] = useState(false);
  const flow = useTypingFlow(lemma, disabled ? undefined : (r) => {
    setFinished(true);
    onDone(r);
  });
  const chars = useMemo(() => Array.from(lemma), [lemma]);

  return (
    <div className="flex w-full flex-col items-center gap-4 py-2" data-testid="follow-copy-view">
      <Badge tone="accent">巩固 · 照着打</Badge>
      <h2 className="section-title text-4xl font-bold tracking-wide text-[var(--color-ink)]">{lemma}</h2>
      {ipa && <span className="font-mono text-sm text-[var(--color-ink-soft)]">{ipa}</span>}
      {definition && <p className="text-sm text-[var(--color-ink-soft)]">{definition}</p>}

      <div className="mt-2 flex flex-wrap items-center justify-center gap-1 font-mono text-2xl" aria-label="逐字跟写区">
        {chars.map((ch, i) => {
          const isTyped = i < flow.typedLength;
          const isWrongFlash = i === flow.typedLength && flow.wrongFlash !== null;
          const isCursor = i === flow.typedLength && flow.wrongFlash === null && !finished;
          return (
            <span
              key={`${ch}-${i}`}
              className={
                "min-w-[1.4ch] rounded px-0.5 text-center " +
                (isTyped
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : isWrongFlash
                    ? "bg-[var(--color-warm-soft,var(--color-surface-muted))] text-[var(--color-accent-2)]"
                    : isCursor
                      ? "border-b-2 border-[var(--color-accent)] text-[var(--color-ink-soft)]"
                      : "text-[var(--color-ink-soft)] opacity-60")
              }
            >
              {isWrongFlash ? (flow.wrongFlash ?? "") : isTyped || isCursor || finished ? ch : "·"}
            </span>
          );
        })}
      </div>

      {!finished && (
        <input
          aria-label="跟写输入"
          data-testid="follow-copy-input"
          autoFocus
          disabled={disabled}
          className="w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] px-3 py-2 text-center font-mono text-lg text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none"
          onKeyDown={(e) => {
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              flow.handleKey(e.key);
            }
          }}
          placeholder="对照词形逐字键入…"
          value=""
        />
      )}

      {finished ? (
        <p className="text-sm text-[var(--color-accent)]">跟写完成 · 错键 {flow.wrongTimes}</p>
      ) : (
        <p className="inline-flex items-center gap-1 text-xs text-[var(--color-ink-soft)] opacity-70">
          <Keyboard className="h-3.5 w-3.5" /> 错字会阻塞提示，键入正确字符继续 · 错键 {flow.wrongTimes}
        </p>
      )}
    </div>
  );
}
