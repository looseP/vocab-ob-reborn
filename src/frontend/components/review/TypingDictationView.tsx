/**
 * TypingDictationView —— 产出轮默写视图 + 常驻档位菜单（拍板⑦：选择即信号，不由失败触发）。
 *
 * - 默写：只见释义（不见词形），逐字键入；Tab = T3 提示（仅默写档，逐字母揭示，
 *   每揭一字母评分上限下降：0→easy / 1→good / ≥2→hard，与卡面 hintCapNow 同口径）；
 * - 档位菜单常驻：默写·无上限 / 🔊听写·困难 / 📋照着打·重来；自选切档重置本档尝试
 *   并累计 abandonedChars（放弃的已键入字符数）；
 * - 档内完成 → onDone({ tier, wrongTimes, hintChars, abandonedChars })，
 *   dictMap 由 stageMap.dictMapOf 在会话层结算。
 * - 听写档（listen）LW-2 接 TTS 强化：TTS 先行、失败降跟写（本卡先按跟写语义处理，
 *   词形隐藏 = 听写形态，无 TTS 时按钮降级隐藏）。
 */

import { useRef, useState } from "react";
import { Keyboard, Volume2, ClipboardList } from "lucide-react";
import { useTypingFlow } from "@/frontend/hooks/useTypingFlow";
import { Badge } from "@/frontend/components/ui/Badge";
import type { DictationTier } from "@/frontend/reviewFlow/stageMap";
import { TIER_CAP, TIER_LABEL } from "@/frontend/reviewFlow/stageMap";

const TIER_ICON: Record<DictationTier, typeof Keyboard> = {
  dictation: Keyboard,
  listen: Volume2,
  copy: ClipboardList,
};

const TIER_CAP_TEXT: Record<DictationTier, string> = {
  dictation: "无上限",
  listen: "上限困难",
  copy: "上限重来",
};

interface TypingDictationViewProps {
  lemma: string;
  definition: string | null;
  ipa?: string | null;
  disabled?: boolean;
  onDone: (result: { tier: DictationTier; wrongTimes: number; hintChars: number; abandonedChars: number }) => void;
}

export function TypingDictationView({ lemma, definition, ipa, disabled, onDone }: TypingDictationViewProps) {
  const [tier, setTier] = useState<DictationTier>("dictation");
  const [finished, setFinished] = useState(false);
  const [hintChars, setHintChars] = useState(0);
  const abandonedRef = useRef(0);
  const [finishedResult, setFinishedResult] = useState<{ wrongTimes: number } | null>(null);

  const flow = useTypingFlow(lemma, disabled ? undefined : (r) => {
    setFinishedResult(r);
    setFinished(true);
    onDone({ tier, wrongTimes: r.wrongTimes, hintChars, abandonedChars: abandonedRef.current });
  });

  const chars = Array.from(lemma);
  // 听写/照着打档下词形可见性：听写 = 无字形（纯听觉，TTS 接入前以释义占位）；照着打 = 词形可见。
  const showLemma = tier === "copy";

  const switchTier = (next: DictationTier) => {
    if (disabled || finished || next === tier) return;
    abandonedRef.current += flow.typedLength; // 放弃的已键入字符（选择即信号的差分记录）
    flow.reset();
    setHintChars(0);
    setTier(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      // T3 提示仅默写档：逐字母揭示下一字符
      if (tier !== "dictation" || disabled || finished) return;
      if (flow.typedLength < chars.length) {
        setHintChars((v) => v + 1);
        // 提示即推进一位（揭示即提示消费，不要求重复键入该字母）
        flow.handleKey(chars[flow.typedLength]);
      }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      flow.handleKey(e.key);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4 py-2" data-testid="typing-dictation-view">
      <Badge tone="warm">产出 · {TIER_LABEL[tier]} · {TIER_CAP_TEXT[tier]}</Badge>
      {definition ? (
        <p className="max-w-lg text-center text-lg font-medium leading-relaxed text-[var(--color-ink)]">{definition}</p>
      ) : (
        <p className="text-sm text-[var(--color-ink-soft)]">（无释义，凭记忆键入）</p>
      )}
      {ipa && showLemma && <span className="font-mono text-sm text-[var(--color-ink-soft)]">{ipa}</span>}
      {showLemma && (
        <h2 className="section-title text-2xl font-bold text-[var(--color-ink)]">{lemma}</h2>
      )}
      {tier === "listen" && !finished && (
        <p className="text-xs text-[var(--color-ink-soft)] opacity-70">听写档：词形隐藏，凭读音与释义键入（TTS 强化接入后自动朗读）</p>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-center gap-1 font-mono text-2xl" aria-label="默写键入区">
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
          aria-label="默写输入"
          data-testid="typing-dictation-input"
          autoFocus
          disabled={disabled}
          className="w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] px-3 py-2 text-center font-mono text-lg text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none"
          onKeyDown={handleKeyDown}
          placeholder={tier === "dictation" ? "看释义默写…（Tab 提示下一字母）" : "键入单词…"}
          value=""
        />
      )}

      {/* 档位菜单：常驻（选择即信号） */}
      <div className="flex items-center gap-2" data-testid="tier-menu">
        {(["dictation", "listen", "copy"] as const).map((t) => {
          const Icon = TIER_ICON[t];
          const active = t === tier;
          return (
            <button
              key={t}
              type="button"
              data-testid={`tier-${t}`}
              disabled={disabled || finished}
              onClick={() => switchTier(t)}
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 " +
                (active
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-semibold text-[var(--color-ink)]"
                  : "border-[var(--color-border)] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]")
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {TIER_LABEL[t]} · {TIER_CAP_TEXT[t]}
            </button>
          );
        })}
      </div>

      {finished ? (
        <p className="text-sm text-[var(--color-accent)]">
          {TIER_LABEL[tier]}完成 · 错键 {finishedResult?.wrongTimes ?? 0}{hintChars > 0 ? ` · 提示 ${hintChars} 字母` : ""}
          {abandonedRef.current > 0 ? ` · 切档放弃 ${abandonedRef.current} 字符` : ""}
        </p>
      ) : (
        <p className="text-xs text-[var(--color-ink-soft)] opacity-70">
          错键 {flow.wrongTimes} · 掌握感不足可随时切档（切档会重置本档尝试）
        </p>
      )}
    </div>
  );
}
