/**
 * EncodeCardView —— 新词 T3 初见编码卡（ADR-0036 LW-2，VISIT_TEMPLATE.NEW 首段）。
 *
 * state=new 词在再认轮的编码形态：自动逐级展开全部可用提示
 * （H1 揭示词形 → H1′ 语义链 → H2 原型 → H3 助记锚，复用 buildHintSteps 降级链：
 * 数据缺失级自动跳过、isSpoiler 剧透过滤）+ 词义翻卡（H4）。
 * 「我认识」跳过提示直接首评（偏 easy）；翻卡后四键首评。
 * 首评不 POST（会话内唯一一次调度提交仍在产出轮末）。
 *
 * 声学（Phase 1 补齐）：新词初见是建立**语音回路**（Phonological Loop）的黄金窗口，
 * 上一轮只在标准复习卡落了声学底座，初见卡是哑的。现在补齐三层：
 * 1. 挂载即自动发音一次（首发音印象），卸载/换卡时掐断；
 * 2. 顶部声学胶囊：发音按钮 + UK/US 口音开关（与 ReviewCardView 共用同一组件）；
 * 3. H1 例句可朗读 + 全局快捷键 R / Shift+R / E（与按钮同一入口，播放中可打断）。
 *    （文案是「听例句」不是「真题例句」—— 例句来自报刊/词典，非历年真题，见 ClueZone 注释。）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, Volume2 } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Card } from "@/frontend/components/ui/Card";
import { AcousticStickyAnchor } from "@/frontend/components/review/AcousticAnchor";
import { useAudioController } from "@/frontend/reviewFlow/audioEngine";
import type { Rating, ReviewCard } from "@/frontend/hooks/useReview";
import { buildHintSteps, HINT_STEP_LABEL, type HintStep } from "@/frontend/reviewFlow/hintSteps";

function EncodeHintStep({
  step,
  onPlaySentence,
  sentencePlaying,
}: {
  step: HintStep;
  /** 未接线（环境无声学能力）时传 undefined —— 不渲染死按钮。 */
  onPlaySentence?: () => void;
  sentencePlaying?: boolean;
}) {
  if (step.kind === "example") {
    return (
      <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        <div className="flex items-start gap-2">
          <p className="flex-1 text-[13px] leading-relaxed text-[var(--color-ink)]">{step.text}</p>
          {onPlaySentence && (
            <button
              type="button"
              data-no-flip
              data-testid="encode-play-example"
              aria-label="朗读例句 (E)"
              title="朗读例句（快捷键 E）· 听觉线索，不消耗提示级"
              onClick={(e) => {
                e.stopPropagation();
                onPlaySentence();
              }}
              className="mt-0.5 inline-flex flex-none items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Volume2 className="h-3 w-3" /> {sentencePlaying ? "播放中…" : "听例句"}
            </button>
          )}
        </div>
        {step.translation && (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">{step.translation}</p>
        )}
      </div>
    );
  }
  if (step.kind === "chain") {
    const nodes = step.text.split("->").map((n) => n.trim()).filter(Boolean);
    return (
      <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        <p className="font-mono text-xs leading-relaxed text-[var(--color-ink)]">
          {nodes.map((node, i) => (
            <span key={`${node}-${i}`}>
              {i > 0 && <span className="px-1 font-bold text-[var(--color-accent)]">→</span>}
              {node}
            </span>
          ))}
        </p>
      </div>
    );
  }
  if (step.kind === "prototype") {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        <span aria-hidden className="pt-0.5">🎯</span>
        <span className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
          {step.text.replace(/\*\*/g, "").replace(/`/g, "")}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
      <span aria-hidden className="pt-0.5">💡</span>
      <span className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
        {step.text}
        {step.mtype && <span className="ml-1.5 text-[10px] text-[var(--color-ink-soft)]">（{step.mtype}）</span>}
      </span>
    </div>
  );
}

interface EncodeCardViewProps {
  card: ReviewCard;
  disabled?: boolean;
  onRate: (rating: Rating) => void;
}

export function EncodeCardView({ card, disabled, onRate }: EncodeCardViewProps) {
  const [revealed, setRevealed] = useState(false);
  // 编码模式：自动逐级展开全部可用提示（缺失级已被 buildHintSteps 跳过）
  const steps = useMemo(() => buildHintSteps(card.word), [card.word]);

  // 播放控制拆成局部常量：`audio` 每次渲染都是新对象身份，直接进依赖会让
  // 回调和键盘 effect 每帧重建；拆开后依赖全是稳定引用或原始值。
  const {
    available,
    isPlaying,
    currentSource,
    accent,
    toggleAccent,
    playWord,
    playSentence,
    stop,
  } = useAudioController();

  // H1 例句步（buildHintSteps 至多产出一条 example）
  const exampleText = useMemo(() => {
    const example = steps.find((step) => step.kind === "example");
    return example ? example.text : null;
  }, [steps]);

  const lemma = card.word.lemma;

  /** 例句朗读唯一入口：快捷键 E 与按钮共用；播放中再次触发 = 打断复位。 */
  const toggleOrPlaySentence = useCallback(() => {
    if (!exampleText) return;
    if (isPlaying && currentSource === "sentence") stop();
    else playSentence(exampleText);
  }, [exampleText, isPlaying, currentSource, playSentence, stop]);

  // 首学初见自动发音：挂载（含换卡）即念一次，给大脑植入第一发音印象。
  // 无任何发声能力时静默跳过；换卡/卸载时掐断上一张卡的音轨（不留幽灵发音）。
  // progressId 参与依赖与守卫：阶梯会话复用同一组件实例，换卡即换 progressId，
  // 必须重新植入发音印象（即使前后两张卡的词形巧合相同）。
  useEffect(() => {
    if (!available || !lemma || !card.progressId) return;
    playWord(lemma);
    return () => stop();
  }, [available, lemma, card.progressId, playWord, stop]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      // Ctrl/Cmd/Alt 组合键一律放行 —— 别抢浏览器刷新（Ctrl+R）等原生快捷键
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();

      // Shift+R = 切换英音/美音：口音是会话级偏好，与当前卡状态无关
      if (key === "r" && event.shiftKey) {
        event.preventDefault();
        toggleAccent();
        return;
      }

      // 空格 / Enter = 展开释义（H4）。已展开则不拦默认行为（避免无意义的 preventDefault）
      if (key === " " || key === "enter") {
        if (event.repeat || revealed) return;
        // 焦点落在按钮/链接上时交给原生激活路径处理，避免一次按键双重触发
        if (target && typeof target.closest === "function" && target.closest("button, a, [data-no-flip]")) return;
        event.preventDefault();
        setRevealed(true);
        return;
      }

      if (key === "r") {
        event.preventDefault();
        playWord(lemma);
        return;
      }

      if (key === "e") {
        if (!exampleText) return;
        event.preventDefault();
        toggleOrPlaySentence();
        return;
      }

      if (key === "1" || key === "2" || key === "3") {
        // 与按钮保持同一准入规则：提交中不评分；「初见（难）」必须已翻卡（H4）
        if (disabled) return;
        if (key === "3" && !revealed) return;
        event.preventDefault();
        onRate(key === "1" ? "easy" : key === "2" ? "good" : "hard");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [disabled, exampleText, lemma, playWord, revealed, toggleAccent, toggleOrPlaySentence, onRate]);

  return (
    <Card className="space-y-4" data-testid="encode-card-view">
      <div className="flex items-center justify-center">
        <Badge tone="warm">新词编码 · 首学</Badge>
      </div>

      <AcousticStickyAnchor
        lemma={lemma}
        ipa={card.word.ipa ?? null}
        accent={accent}
        available={available}
        isPlaying={isPlaying}
        source={currentSource}
        onPlayWord={() => playWord(lemma)}
        onToggleAccent={toggleAccent}
        hint={exampleText ? "R 拼读 · Shift+R 口音 · E 例句" : "R 拼读 · Shift+R 口音"}
      />

      <h2 className="section-title text-center text-4xl font-bold text-[var(--color-ink)]">
        {lemma}
      </h2>
      {card.word.ipa && (
        <p className="text-center font-mono text-sm text-[var(--color-ink-soft)]">{card.word.ipa}</p>
      )}

      {steps.length > 0 ? (
        <div className="space-y-1.5">
          {steps.map((step, i) => (
            <div key={`${step.kind}-${i}`} className="space-y-0.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-ink-soft)] opacity-70">
                {HINT_STEP_LABEL[step.kind]}
              </p>
              <EncodeHintStep
                step={step}
                onPlaySentence={step.kind === "example" && available ? toggleOrPlaySentence : undefined}
                sentencePlaying={isPlaying && currentSource === "sentence"}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">暂无提示素材，直接看释义学习</p>
      )}

      {!revealed ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => setRevealed(true)} disabled={disabled}>
            <Eye className="h-4 w-4" />
            看释义（H4）
          </Button>
        </div>
      ) : (
        <div className="rounded-xl bg-[var(--color-surface-muted)] px-4 py-3 text-center">
          <p className="text-lg font-medium text-[var(--color-ink)]">
            {card.word.short_definition ?? "暂无释义"}
          </p>
        </div>
      )}

      <div className="flex justify-center gap-2 pt-1" data-testid="encode-rating">
        <Button variant="secondary" size="lg" disabled={disabled} onClick={() => onRate("easy")}>
          我认识
        </Button>
        <Button variant="secondary" size="lg" disabled={disabled} onClick={() => onRate("good")}>
          有印象
        </Button>
        <Button variant="primary" size="lg" disabled={disabled || !revealed} onClick={() => onRate("hard")}>
          初见（难）
        </Button>
      </div>
      <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">
        首学编码：提示已自动逐级展开（缺失级自动跳过）；首评在会话产出轮后随调度一并提交
      </p>
    </Card>
  );
}
