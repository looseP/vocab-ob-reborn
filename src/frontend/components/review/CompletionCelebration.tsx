import { motion } from "framer-motion";
import { PartyPopper } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";

interface CompletionCelebrationProps {
  stats: { reviewed: number; again: number; hard: number; good: number; easy: number };
  onRestart: () => void;
  onBack: () => void;
}

export function CompletionCelebration({ stats, onRestart, onBack }: CompletionCelebrationProps) {
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
        共复习 {stats.reviewed} 张卡片
      </p>

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
