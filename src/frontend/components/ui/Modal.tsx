import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Button";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const sizeClasses = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Modal({ open, onClose, title, children, footer, size = "md" }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", handleEsc);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  // Portal 到 body（2026-10-10）：Modal 若渲染在带 backdrop-filter / transform 的祖先
  // 子树内（如「一键遗忘」所在的 Card），该祖先会成为 position:fixed 的包含块 ——
  // fixed inset-0 被锁进卡片几何，弹窗被压扁、页脚按钮溢出（真机实测：外层 86px 高、
  // 内容区被压到 32px）。渲染到 body 后 fixed 恒相对视口，任意祖先样式都安全。
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* 高度护栏（2026-10-10）：卡片限高到视口内并改列向 flex —— 内容超高时
          仅内容区滚动，标题与页脚（确认/取消）恒可见。此前无 max-h，高内容
          弹窗底部按钮被挤出视口且无法滚动到（一键遗忘锚点多时实测）。 */}
      <div
        className={`relative flex max-h-full w-full ${sizeClasses[size]} flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-strong)] shadow-[var(--shadow-panel-strong)] backdrop-blur-xl`}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
            <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border)] px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
