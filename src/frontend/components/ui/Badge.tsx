import clsx from "clsx";
import type { ReactNode } from "react";

type Tone = "default" | "warm" | "accent";

const toneClasses: Record<Tone, string> = {
  default: "bg-[var(--color-pill-bg)] border-[var(--color-pill-border)] text-[var(--color-pill-text)]",
  warm: "bg-[var(--color-pill-warm-bg)] border-[var(--color-pill-warm-border)] text-[var(--color-pill-warm-text)]",
  accent: "bg-[var(--color-surface-muted)] border-[var(--color-accent)] text-[var(--color-accent)]",
};

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

export function Badge({ children, tone = "default", className }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
