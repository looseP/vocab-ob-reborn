import clsx from "clsx";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  /** 原生 title（悬停提示）—— 用于承载口径说明等不占版面的注释。 */
  title?: string;
}

export function Card({ children, className, onClick, title }: CardProps) {
  return (
    <div
      onClick={onClick}
      title={title}
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
