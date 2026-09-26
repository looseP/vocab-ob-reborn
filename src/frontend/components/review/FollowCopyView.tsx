/**
 * FollowCopyView —— 巩固轮跟写视图（拍板④：听写 = 跟写的强化，非独立档位）。
 * 词形可见、逐字照打；阻塞式状态机（useTypingFlow）：错字阻塞标红、wrongTimes 只增不减。
 * 听写强化（LW-2）：「🔊 听写」按钮（Web Speech API 能力检测）→ TTS 先行 + 词形隐藏；
 * 无 speechSynthesis / 合成失败 → 按钮隐藏或降回跟写（拍板④：失败降跟写）。
 */

import { useState } from "react";
import { Keyboard, Volume2, Eye } from "lucide-react";
import { useTypingFlow } from "@/frontend/hooks/useTypingFlow";
import { Badge } from "@/frontend/components/ui/Badge";
import { isSpeechSynthesisAvailable, speak } from "@/frontend/reviewFlow/speech";

interface FollowCopyViewProps {
  lemma: string;
  definition: string | null;
  ipa?: string | null;
  disabled?: boolean;
  onDone: (result: { wrongTimes: number }) => void;
}

export function FollowCopyView({ lemma, definition, ipa, disabled, onDone }: FollowCopyViewProps) {
  const [finished, setFinished] = useState(false);
  // 听写强化形态：TTS 先行、词形隐藏；失败/不可用降回跟写（词形可见）
  const [listenMode, setListenMode] = useState(false);
  const [speechUnsupported, setSpeechUnsupported] = useState(false);
  const flow = useTypingFlow(lemma, disabled ? undefined : (r) => {
    setFinished(true);
    onDone(r);
  });
  const chars = Array.from(lemma);
  const hideLemma = listenMode && !speechUnsupported;

  const startListen = () => {
    if (!isSpeechSynthesisAvailable()) {
      setSpeechUnsupported(true); // 无 TTS 环境 → 降级跟写
      return;
    }
    setListenMode(true);
    if (!speak(lemma)) {
      setSpeechUnsupported(true); // 合成失败 → 降级跟写
      setListenMode(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4 py-2" data-testid="follow-copy-view">
      <Badge tone="accent">{hideLemma ? "巩固 · 听写（强化）" : "巩固 · 照着打"}</Badge>
      {!hideLemma && (
        <>
          <h2 className="section-title text-4xl font-bold tracking-wide text-[var(--color-ink)]">{lemma}</h2>
          {ipa && <span className="font-mono text-sm text-[var(--color-ink-soft)]">{ipa}</span>}
        </>
      )}
      {definition && <p className="text-sm text-[var(--color-ink-soft)]">{definition}</p>}
      {hideLemma && (
        <p className="text-xs text-[var(--color-ink-soft)] opacity-70">听写形态：词形隐藏，凭读音键入</p>
      )}

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
        <>
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
            placeholder={hideLemma ? "凭读音键入…" : "对照词形逐字键入…"}
            value=""
          />
          {!hideLemma && !speechUnsupported && (
            <button
              type="button"
              data-testid="listen-strengthen"
              disabled={disabled}
              onClick={startListen}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              <Volume2 className="h-3.5 w-3.5" />
              听写（强化）· 隐藏词形
            </button>
          )}
          {hideLemma && (
            <button
              type="button"
              data-testid="listen-fallback"
              disabled={disabled}
              onClick={() => setListenMode(false)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Eye className="h-3.5 w-3.5" />
              降回跟写（显示词形）
            </button>
          )}
        </>
      )}

      {finished ? (
        <p className="text-sm text-[var(--color-accent)]">
          {hideLemma ? "听写完成" : "跟写完成"} · 错键 {flow.wrongTimes}
        </p>
      ) : (
        <p className="inline-flex items-center gap-1 text-xs text-[var(--color-ink-soft)] opacity-70">
          <Keyboard className="h-3.5 w-3.5" /> 错字会阻塞提示，键入正确字符继续 · 错键 {flow.wrongTimes}
        </p>
      )}
    </div>
  );
}
