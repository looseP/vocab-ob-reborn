import { motion } from "framer-motion";
import { PartyPopper, FastForward, Ban } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";

interface CompletionCelebrationProps {
  stats: { reviewed: number; again: number; hard: number; good: number; easy: number };
  /** 本会话跳过的卡数（区分"已评分/跳过"，避免用户误以为全部完成）。 */
  skipped?: number;
  /** 本会话挂起的卡数。 */
  suspended?: number;
  onRestart: () => void;
  onBack: () => void;
}

export function CompletionCelebration({ stats, skipped = 0, suspended = 0, onRestart, onBack }: CompletionCelebrationProps) {
  const unfinished = skipped + suspended;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      <motion.div
        initial={{ scale: 0, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
        className="mb-6"
      >
        <PartyPopper className="h-16 w-16 text-[var(--color-accent)]" />
      </motion.div>

      <h2 className="section-title text-3xl font-bold text-[var(--color-ink)]">
        今日复习已完成 🎉
      </h2>
      <p className="mt-2 text-[var(--color-ink-soft)]">
        已评分 {stats.reviewed} 张卡片
      </p>

      {/* 跳过/挂起提示：让用户知道队列并非全部完成 */}
      {unfinished > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {skipped > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs text-[var(--color-ink-soft)]">
              <FastForward className="h-3.5 w-3.5" />跳过 {skipped}
            </span>
          )}
          {suspended > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rating-again-border)] bg-[var(--color-rating-again-bg)] px-3 py-1 text-xs text-[var(--color-accent-2)]">
              <Ban className="h-3.5 w-3.5" />挂起 {suspended}
            </span>
          )}
          {unfinished > 0 && (
            <span className="text-xs text-[var(--color-ink-soft)]">共 {unfinished} 张未完成，可在下方再复习一轮或稍后处理</span>
          )}
        </div>
      )}

      <div className="mt-8 grid grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[var(--color-rating-again-border)] bg-[var(--color-rating-again-bg)] px-4 py-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-accent-2)]">{stats.again}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">不会</p>
        </div>
        <div className="rounded-2xl border border-[var(--color-rating-hard-border)] bg-[var(--color-rating-hard-bg)] px-4 py-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-ink)]">{stats.hard}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">困难</p>
        </div>
        <div className="rounded-2xl border border-[var(--color-rating-good-border)] bg-[var(--color-surface-muted)] px-4 py-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-accent)]">{stats.good}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">良好</p>
        </div>
        <div className="rounded-2xl border border-[var(--color-rating-easy-border)] bg-[var(--color-rating-easy-bg)] px-4 py-3 text-center">
          <p className="text-2xl font-bold text-[var(--color-accent)]">{stats.easy}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">简单</p>
        </div>
      </div>

      <div className="mt-8 flex gap-3">
        <Button variant="secondary" onClick={onBack}>返回</Button>
        <Button onClick={onRestart}>再复习一轮</Button>
      </div>
    </motion.div>
  );
}
