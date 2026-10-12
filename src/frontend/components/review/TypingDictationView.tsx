/**
 * TypingDictationView —— 产出轮默写视图 + 常驻档位菜单（拍板⑦：选择即信号，不由失败触发）。
 *
 * - 默写：只见释义（不见词形），逐字键入；Tab = T3 提示（仅默写档，逐字母揭示，
 *   每揭一字母评分上限下降：0→easy / 1→good / ≥2→hard，与卡面 hintCapNow 同口径）；
 * - 档位菜单常驻：默写·无上限 / 🔊听写·困难 / 📋照着打·重来；自选切档重置本档尝试
 *   并累计 abandonedChars（放弃的已键入字符数）；
 * - 档内完成 → onDone({ tier, wrongTimes, hintChars, abandonedChars })，
 *   dictMap 由 stageMap.dictMapOf 在会话层结算。
 * - 听写档（listen）LW-2 已接 TTS 强化：进入本档（或换卡）即朗读**题面** —— 音频
 *   就是题目，配「重播读音」按钮。题面朗读**不经「自动伴读」配置**（它不是伴读，
 *   是题面本身）；环境没有发声能力时**降级跟写**（词形转可见），不留按不响的按钮。
 */

import { useEffect, useRef, useState } from "react";
import { Keyboard, Volume2, ClipboardList } from "lucide-react";
import { useTypingFlow } from "@/frontend/hooks/useTypingFlow";
import { Badge } from "@/frontend/components/ui/Badge";
import type { DictationTier } from "@/frontend/reviewFlow/stageMap";
import { TIER_CAP, TIER_LABEL } from "@/frontend/reviewFlow/stageMap";
import { useAudioController } from "@/frontend/reviewFlow/audioEngine";
import { useFaceAutoAudio } from "@/frontend/reviewFlow/useFaceAutoAudio";

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
  /** 听写档题面朗读降级标记：环境无发声能力时置位（词形转可见 = 跟写语义）。 */
  const [promptFailed, setPromptFailed] = useState(false);

  const flow = useTypingFlow(lemma, disabled ? undefined : (r) => {
    setFinishedResult(r);
    setFinished(true);
    onDone({ tier, wrongTimes: r.wrongTimes, hintChars, abandonedChars: abandonedRef.current });
  });

  // 切卡自动伴读：卡面类别**随档位变** —— copy 档词形可见 = ③a（播词形）；
  // dictation 档只见中文 = ③b（默认只读那行中文释义：题面本来就是它，卡一出现
  // 就听见题面，不用手点；词形绝不进默认编排 —— 念英文等于把答案说出口）。
  // **听写档不接伴读**：它的读音就是题面，由下面那条 effect 独占播放（接了就双重）。
  // triggerKey 用 tier：切档即换面，上一档在途的伴读随 effect 清理被掐断。
  const audio = useAudioController();
  useFaceAutoAudio({
    face: tier === "copy" ? "typing-en" : tier === "dictation" ? "typing-zh" : undefined,
    triggerKey: tier,
    lemma,
    definition,
    controller: audio,
  });

  /**
   * 听写档题面朗读（LW-2）：进入本档 / 换卡即放一遍词音 —— 音频本身就是题目。
   *
   * 刻意**不读自动伴读配置**：用户点「听写」就是在要这段读音，总闸管的是伴读，
   * 不该把题面也掐掉。环境两条发声路径都没有（真人音频 + TTS）→ 降级跟写：
   * `promptFailed` 让词形转可见（与照着打同语义），而不是留个按不响的按钮。
   */
  useEffect(() => {
    if (tier !== "listen" || disabled || finished) return;
    if (!audio.available) {
      setPromptFailed(true);
      return;
    }
    audio.playWord(lemma);
  }, [tier, disabled, finished, lemma, audio.available, audio.playWord]);

  const chars = Array.from(lemma);
  // 词形可见性：照着打 = 可见；听写降级跟写时也可见；默写与正常听写 = 隐藏
  // （听写档的「无字形」正是它的题面形态：只给读音与释义）。
  const showLemma = tier === "copy" || (tier === "listen" && promptFailed);

  const switchTier = (next: DictationTier) => {
    if (disabled || finished || next === tier) return;
    abandonedRef.current += flow.typedLength; // 放弃的已键入字符（选择即信号的差分记录）
    flow.reset();
    setHintChars(0);
    setTier(next);
    // 切档掐断在途题面读音：它是自动播放的，不会自己让位给新档位。
    audio.stop();
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
        <div className="flex flex-wrap items-center justify-center gap-2">
          <p className="text-xs text-[var(--color-ink-soft)] opacity-70">
            {promptFailed
              ? "听写档：本环境没有可用的语音朗读，降级为跟写（词形已显示）"
              : "听写档：音频即题面，词形隐藏 —— 听读音键入"}
          </p>
          {!promptFailed && (
            <button
              type="button"
              data-testid="listen-replay"
              // 键盘焦点必须留在键入区：点按钮若抢走焦点，之后的按键就没人接了。
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => audio.playWord(lemma)}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Volume2 className="h-3.5 w-3.5" />
              重播读音
            </button>
          )}
        </div>
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
