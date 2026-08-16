import clsx from "clsx";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, className, onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        "rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-[var(--shadow-panel)] backdrop-blur-xl",
        onClick && "cursor-pointer transition-colors hover:border-[var(--color-border-strong)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
