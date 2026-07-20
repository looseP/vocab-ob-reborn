import { motion } from "framer-motion";

interface ReviewProgressBarProps {
  completed: number;
  remaining: number;
  className?: string;
}

export function ReviewProgressBar({ completed, remaining, className }: ReviewProgressBarProps) {
  const total = completed + remaining;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className={className}>
      <div className="flex items-center justify-between text-sm">
        <span className="text-[var(--color-ink-soft)]">复习进度</span>
        <span className="font-medium tabular-nums text-[var(--color-ink)]">
          {completed}/{total}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
        <motion.div
          className="h-full rounded-full bg-[var(--color-accent)]"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
    </div>
  );
}
