import clsx from "clsx";
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./Button";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 右侧工具区（例如刷新按钮、更多操作）。 */
  headerRight?: ReactNode;
  children: ReactNode;
  /** 抽屉宽度，sm 约 1/3 屏，lg 约 1/2 屏。 */
  size?: "sm" | "md" | "lg";
  footer?: ReactNode;
}

const sizeClasses: Record<NonNullable<SheetProps["size"]>, string> = {
  sm: "max-w-sm w-[85vw]",
  md: "max-w-md w-[85vw]",
  lg: "max-w-xl w-[90vw]",
};

export function Sheet({ open, onClose, title, subtitle, headerRight, children, size = "md", footer }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={clsx(
          "absolute right-0 top-0 h-full w-full",
          sizeClasses[size],
          "border-l border-[var(--color-border)] bg-[var(--color-panel-strong)] shadow-[var(--shadow-panel-strong)]",
          "flex flex-col animate-[sheet-in_160ms_ease-out]",
        )}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="section-title truncate text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
            </div>
            {subtitle ? (
              <p className="mt-1 truncate text-xs text-[var(--color-ink-soft)]">{subtitle}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerRight}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="border-t border-[var(--color-border)] px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
