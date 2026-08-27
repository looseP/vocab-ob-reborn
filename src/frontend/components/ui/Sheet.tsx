import clsx from "clsx";
import { useEffect, useRef, type ReactNode } from "react";
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
  const dialogRef = useRef<HTMLDivElement>(null);
  // 打开前焦点元素：关闭后还原，避免键盘/读屏用户焦点"失踪"
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // 记录打开前焦点，供关闭后还原
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Tab 焦点陷阱：Tab / Shift+Tab 在 dialog 内循环（首尾回绕）
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    // 打开后把初始焦点移到对话框标题（读屏播报对话框语义），
    // 延迟一帧确保动画渲染完成后再聚焦。
    const focusInitial = () => {
      dialogRef.current?.querySelector<HTMLElement>("[data-sheet-title]")?.focus();
    };
    const raf = requestAnimationFrame(focusInitial);

    window.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
      // 关闭后还原焦点到打开前的元素
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
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
        ref={dialogRef}
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
              <h2
                data-sheet-title
                tabIndex={-1}
                className="section-title truncate text-lg font-semibold text-[var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
              >
                {title}
              </h2>
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
