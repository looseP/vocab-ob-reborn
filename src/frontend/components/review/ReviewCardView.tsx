import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Eye, EyeOff, Zap } from "lucide-react";
import type { ReviewCard } from "@/frontend/hooks/useReview";
import { labelReviewState } from "@/frontend/hooks/useReview";

const ratings = [
  { value: "again", label: "重来", variant: "danger" as const, key: "1" },
  { value: "hard", label: "困难", variant: "secondary" as const, key: "2" },
  { value: "good", label: "良好", variant: "secondary" as const, key: "3" },
  { value: "easy", label: "简单", variant: "primary" as const, key: "4" },
] as const;

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-soft)]">
      {children}
    </kbd>
  );
}

interface ReviewCardViewProps {
  card: ReviewCard | null;
  loading: boolean;
  error: string | null;
  /** Free browse mode — hide rating, use prev/next navigation, no persistence. */
  preview?: boolean;
  onAnswer: (rating: "again" | "hard" | "good" | "easy") => void;
  onSkip: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onClearWeakSignal?: (wordId: string) => void;
  /** 挂起当前卡（P0：v1 的 p/P 快捷键对齐）。 */
  onSuspend?: () => void;
  /** 撤销最近一次评分（P0：v1 的 u/U 快捷键对齐 + Ctrl/Cmd+Z）。 */
  onUndo?: () => void;
  /** 是否存在可撤销的评分。 */
  canUndo?: boolean;
  /** 当前复习会话的 mode 与 wordIds，点击"查看详情"时塞入路由 state，便于返回按钮渲染。 */
  reviewContext?: { mode: string; wordIds?: string[] };
  /** 当前在队列中的进度，仅用于文案展示（返回复习后会通过缓存还原）。 */
  reviewProgress?: { reviewed: number; total: number };
}

/**
 * 翻转卡片交互（P2）：非 preview 模式点击卡片在「词形 ↔ 释义」间切换，
 * 先自测回忆再评分；preview 模式直接展示全部内容用于浏览。
 */
export function ReviewCardView({ card, loading, error, preview, onAnswer, onSkip, onPrev, onNext, onClearWeakSignal, onSuspend, onUndo, canUndo, reviewContext, reviewProgress }: ReviewCardViewProps) {
  const [revealed, setRevealed] = useState(false);

  // 操作区容器：评分/跳过/挂起/撤销/翻页后把焦点移回这里，
  // 避免按钮卸载后焦点掉回 body（键盘/读屏用户的焦点链断裂）。
  const actionRef = useRef<HTMLDivElement>(null);
  const refocusActions = () => {
    requestAnimationFrame(() => actionRef.current?.focus());
  };
  const handleAnswer = (rating: "again" | "hard" | "good" | "easy") => {
    onAnswer(rating);
    refocusActions();
  };
  const handleSkip = () => {
    onSkip();
    refocusActions();
  };
  const handleSuspend = () => {
    onSuspend?.();
    refocusActions();
  };
  const handleUndo = () => {
    onUndo?.();
    refocusActions();
  };
  const handlePrev = () => {
    onPrev?.();
    refocusActions();
  };
  const handleNext = () => {
    onNext?.();
    refocusActions();
  };

  // 切换卡片时重置翻转状态
  useEffect(() => {
    setRevealed(false);
  }, [card?.progressId]);

  // 键盘快捷键（P0，对齐 v1）：
  //   评分模式：空格/Enter 翻转、1-4 评分、S 跳过、P 挂起、U 或 Ctrl/Cmd+Z 撤销；
  //   preview 模式：←/→ 翻页。
  // 输入控件聚焦时豁免。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      const modifierActive = Boolean(event.metaKey || event.ctrlKey);
      const key = event.key.toLowerCase();
      const isPreview = Boolean(preview);

      // Ctrl/Cmd+Z = 撤销（即使卡面仍在 loading，只要 canUndo 就触发）
      if (modifierActive && !event.altKey && (key === "z" || event.key === "Z")) {
        if (isPreview) return; // preview 不评分，无可撤销
        if (!canUndo) return;
        event.preventDefault();
        onUndo?.();
        return;
      }
      if (modifierActive || event.altKey) return;

      if (isPreview) {
        if (key === "arrowleft") {
          event.preventDefault();
          onPrev?.();
        } else if (key === "arrowright") {
          event.preventDefault();
          onNext?.();
        }
        return;
      }

      if (key === " " || key === "enter") {
        if (event.repeat) return;
        // 翻转卡片本身是原生 button：Enter/Space 走原生 click（含读屏合成激活），
        // 这里跳过避免与 onClick 双重翻转。
        const target = event.target as HTMLElement | null;
        if (target && typeof target.closest === "function" && target.closest("[data-flip-card]")) {
          return;
        }
        event.preventDefault();
        setRevealed((v) => !v);
        return;
      }
      if (!card || loading) return;
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        event.preventDefault();
        onAnswer(ratings[Number(key) - 1].value);
      } else if (key === "s") {
        event.preventDefault();
        onSkip();
      } else if (key === "p") {
        event.preventDefault();
        onSuspend?.();
      } else if (key === "u") {
        if (!canUndo) return;
        event.preventDefault();
        onUndo?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [card, loading, preview, onAnswer, onSkip, onSuspend, onUndo, canUndo, onPrev, onNext]);

  if (loading && !card) {
    return (
      <Card className="flex items-center justify-center py-20">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载下一张卡片...</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="py-20 text-center">
        <p className="text-[var(--color-accent-2)]">{error}</p>
      </Card>
    );
  }

  if (!card) {
    return (
      <Card className="py-20 text-center">
        <p className="text-lg text-[var(--color-ink)]">今日复习已完成 🎉</p>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">没有更多待复习的卡片</p>
      </Card>
    );
  }

  const showDefinition = preview || revealed;

  // 卡片主体内容：aria-live 区域在翻转时向读屏播报词形↔释义切换。
  const flipBody = (
    <span aria-live="polite" className="block w-full">
      <AnimatePresence mode="wait">
        {showDefinition ? (
          <motion.div
            key="back"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="flex h-full flex-col items-center justify-center text-center"
          >
            <div className="flex flex-wrap items-center justify-center gap-2">
              {card.word.pos && <Badge>{card.word.pos}</Badge>}
              {card.word.cefr && <Badge tone="warm">CEFR {card.word.cefr}</Badge>}
              {card.word.ipa && (
                <span className="font-mono text-sm text-[var(--color-ink-soft)]">{card.word.ipa}</span>
              )}
            </div>
            {card.word.short_definition ? (
              <p className="mt-3 text-lg text-[var(--color-ink)]">{card.word.short_definition}</p>
            ) : (
              <p className="mt-3 text-sm text-[var(--color-ink-soft)]">暂无释义</p>
            )}
            {!preview && (
              <span className="mt-4 inline-flex items-center gap-1 text-xs text-[var(--color-ink-soft)] opacity-70">
                <EyeOff className="h-3.5 w-3.5" /> 点击返回词形
              </span>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="front"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="flex h-full flex-col items-center justify-center text-center"
          >
            <h2 className="section-title text-4xl font-bold text-[var(--color-ink)]">
              {card.word.lemma}
            </h2>
            {card.word.ipa && (
              <span className="mt-2 font-mono text-sm text-[var(--color-ink-soft)]">{card.word.ipa}</span>
            )}
            <span className="mt-4 inline-flex items-center gap-1 text-xs text-[var(--color-ink-soft)] opacity-70">
              <Eye className="h-3.5 w-3.5" /> 点击显示释义
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );

  return (
    <Card className="space-y-6">
      {card.l1WeakSignal && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--color-warm-border,transparent)] bg-[var(--color-surface-muted)] px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge tone="warm" className="flex items-center gap-1">
              <Zap size={12} /> 弱信号
            </Badge>
            <span className="text-xs text-[var(--color-ink-soft)]">
              L2 连续判错，已触发 L1 重刷
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => onClearWeakSignal?.(card.word.id)}
          >
            清除标记
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <Badge tone="accent">{labelReviewState(card.state)}</Badge>
          {card.queueLabel && <Badge>{card.queueLabel}</Badge>}
          {card.reviewCount > 0 && <Badge>复习 {card.reviewCount} 次</Badge>}
          {typeof card.retrievability === "number" && (
            <Badge tone="warm">记忆留存 {Math.round(card.retrievability * 100)}%</Badge>
          )}
        </div>
        <Link
          to={{ pathname: `/words/${card.word.slug}` }}
          state={{
            from: "review",
            mode: reviewContext?.mode,
            wordIds: reviewContext?.wordIds,
            reviewed: reviewProgress?.reviewed,
            total: reviewProgress?.total,
          }}
          className="text-sm font-semibold text-[var(--color-accent)]"
        >
          查看详情
        </Link>
      </div>

      {/* 卡片主体：preview 直接展示；评分模式先词形后释义。
          翻转控件为原生 button（读屏/键盘可达）：Enter/Space 走原生 click，
          全局空格快捷键在 [data-flip-card] 上跳过，避免双重翻转。 */}
      {!preview ? (
        <button
          type="button"
          data-flip-card
          aria-pressed={revealed}
          aria-label={revealed ? `翻转「${card.word.lemma}」，隐藏释义` : `翻转「${card.word.lemma}」，显示释义`}
          title="点击翻转"
          className="relative flex min-h-[12rem] w-full cursor-pointer items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-6 py-8 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
          onClick={() => setRevealed((v) => !v)}
        >
          {flipBody}
        </button>
      ) : (
        <div className="relative flex min-h-[12rem] w-full cursor-pointer items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-6 py-8">
          {flipBody}
        </div>
      )}

      {preview ? (
        <div
          ref={actionRef}
          tabIndex={-1}
          aria-label="卡片导航操作区"
          className="flex justify-center gap-3 pt-4 focus:outline-none"
        >
          <Button variant="secondary" size="lg" disabled={loading} onClick={handlePrev}>
            <ArrowLeft className="h-4 w-4" /> 上一个
          </Button>
          <Button variant="secondary" size="lg" disabled={loading} onClick={handleNext}>
            下一个 <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <>
          <div
            ref={actionRef}
            tabIndex={-1}
            aria-label="评分操作区"
            className="flex justify-center gap-2 pt-4 focus:outline-none"
          >
            {ratings.map((r) => (
              <Button
                key={r.value}
                variant={r.variant}
                size="lg"
                disabled={loading}
                onClick={() => handleAnswer(r.value)}
              >
                {r.label}
                <Kbd>{r.key}</Kbd>
              </Button>
            ))}
          </div>

          <div className="text-center">
            <Button variant="ghost" size="sm" disabled={loading} onClick={handleSkip}>
              跳过<Kbd>S</Kbd>
            </Button>
            {onSuspend && (
              <Button variant="ghost" size="sm" disabled={loading} onClick={handleSuspend} className="ml-3">
                挂起<Kbd>P</Kbd>
              </Button>
            )}
          </div>

          <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">
            空格 翻转 · 1-4 评分 · S 跳过 · P 挂起 · H 历史{canUndo ? " · U / Ctrl+Z 撤销上一张" : ""}
          </p>
        </>
      )}
    </Card>
  );
}
