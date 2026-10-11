import clsx from "clsx";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  /** 原生 title（悬停提示）—— 用于承载口径说明等不占版面的注释。 */
  title?: string;
  /**
   * 测试选择器（2026-10-11）。此前 Card 只透传 className/onClick/title，
   * 写在 Card 上的 `data-testid` 会被静默丢弃 —— 测试里
   * `querySelector('[data-testid="ladder-settlement"]')` 恒为 null，
   * 让人误判「结算页没渲染」。显式声明为可选 prop，杜绝这类假阴性。
   */
  "data-testid"?: string;
}

export function Card({ children, className, onClick, title, ...rest }: CardProps) {
  return (
    <div
      onClick={onClick}
      title={title}
      className={clsx(
        "rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-[var(--shadow-panel)] backdrop-blur-xl",
        onClick && "cursor-pointer transition-colors hover:border-[var(--color-border-strong)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
