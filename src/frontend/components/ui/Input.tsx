import clsx from "clsx";
import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={clsx(
        "h-10 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-input)] px-4 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] transition-colors focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]",
        className,
      )}
      {...props}
    />
  );
}
