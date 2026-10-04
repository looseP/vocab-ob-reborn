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
import { L3ContextText } from "@/frontend/components/review/L3ContextText";
import { useAudioController } from "@/frontend/reviewFlow/audioEngine";
import type { Rating, ReviewCard } from "@/frontend/hooks/useReview";
import { buildHintSteps, HINT_STEP_LABEL, type HintStep } from "@/frontend/reviewFlow/hintSteps";
import { useWordDetail } from "@/frontend/hooks/useWordDetail";
import {
  ClueZone,
  TrainingFold,
  parseWordExam,
  parseVerifiedCount,
} from "@/frontend/components/review/WordCardExamLayers";
import type { WordExam } from "@/domain/word-exam";

function EncodeHintStep({
  step,
  onPlaySentence,
  sentencePlaying,
  exam,
}: {
  step: HintStep;
  /** 未接线（环境无声学能力）时传 undefined —— 不渲染死按钮。 */
  onPlaySentence?: () => void;
  sentencePlaying?: boolean;
  /**
   * 词条详情里的 exam 三层。**有切分数据时**，例句步改由 `ClueZone`（analysis 口径）
   * 渲染 —— 编码卡本就全展开，不遮盖，把轨色切分与语法角色直接摊在例句旁。
   * 无切分（v1 批次）时回落到原来的朴素例句块，行为零变化。
   */
  exam?: WordExam | null;
}) {
  if (step.kind === "example") {
    const hasSplit = (exam?.reading?.blocks.length ?? 0) > 0;
    if (hasSplit) {
      return (
        <div className="text-left">
          <ClueZone
            exam={exam ?? null}
            text={step.text}
            maskTerm={null}
            maskRevealed
            onUnmask={() => {}}
            onPlaySentence={onPlaySentence}
            sentencePlaying={sentencePlaying}
            variant="analysis"
            className="mt-0 border-none bg-transparent px-0 py-0"
          />
          {step.translation && (
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">{step.translation}</p>
          )}
        </div>
      );
    }
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
  if (step.kind === "l3_context") {
    // 编码卡是"首学全展开、不遮盖"形态。本卡当前不注入 L3 语境（它已由 #198 的
    // exam 三层承担"真题语境"，重复渲染无收益，见 buildHintSteps 文档）；此分支
    // 只为类型完备与将来复用时的口径正确 —— 不遮盖、不显示中文释义。
    return (
      <div className="space-y-1.5 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        {step.items.map((item) => (
          <div key={item.contextId}>
            <p className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
              <L3ContextText text={item.text} />
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--color-ink-soft)]">—— {item.sourceTitle}</p>
          </div>
        ))}
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

  // ── exam 三层（例句分析 + 训练扩展）────────────────────────────────
  // 与复习卡同一份契约层解析（`parseWordExam`），不重复实现。
  // 依赖详情 API：未到达 / 无 exam 时安静缺席 —— 阶梯卡退回「只有裸例句」的旧观感。
  const detail = useWordDetail(lemma);
  const exampleExam = useMemo(() => {
    const first = detail.word?.examples?.[0] as Record<string, unknown> | undefined;
    return first ? parseWordExam(first.exam) : null;
  }, [detail.word?.examples]);
  const verifiedCount = useMemo(() => {
    const first = detail.word?.examples?.[0] as Record<string, unknown> | undefined;
    return first ? parseVerifiedCount(first.verified) : 0;
  }, [detail.word?.examples]);
  // 训练扩展的「译点 / 骨架」任一存在才值得渲染折叠（两者皆空时是空壳）。
  const hasTraining = (exampleExam?.translation?.keyPoints.length ?? 0) > 0 || Boolean(exampleExam?.writing?.pattern);

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
                exam={step.kind === "example" ? exampleExam : null}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">暂无提示素材，直接看释义学习</p>
      )}

      {/* 译点与骨架：与复习卡共用 TrainingFold（含点金块「先猜后看」自检）。
          挂在阶梯之外而非某一阶之内 —— 它是对整条例句的解析补充，不是提示的一级。 */}
      {hasTraining && (
        <TrainingFold exam={exampleExam} verifiedCount={verifiedCount} />
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
