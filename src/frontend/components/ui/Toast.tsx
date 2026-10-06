import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X, XCircle } from "lucide-react";

type ToastType = "success" | "error" | "info" | "warning";

/** Toast 内嵌动作按钮（如评分后的「撤销」入口）。 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** 展示时长（ms），默认 4000。带 action 的提示建议 ≥8000。 */
  duration?: number;
  action?: ToastAction;
}

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
  action?: ToastAction;
}

interface ToastContextValue {
  addToast: (type: ToastType, message: string, options?: ToastOptions) => void;
}

export type { ToastContextValue, ToastType };

const ToastContext = createContext<ToastContextValue | null>(null);

const icons = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertCircle,
};

const colors = {
  success: "text-[var(--color-accent)]",
  error: "text-[var(--color-accent-2)]",
  info: "text-[var(--color-ink-soft)]",
  warning: "text-[var(--color-highlight)]",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string, options?: ToastOptions) => {
    const id = Date.now() + Math.random();
    const duration = options?.duration ?? 4000;
    setToasts((prev) => [...prev, { id, type, message, duration, action: options?.action }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = icons[toast.type];
          return (
            <div
              key={toast.id}
              className="flex items-center gap-3 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-strong)] px-5 py-3 shadow-[var(--shadow-panel)] backdrop-blur-xl"
            >
              <Icon className={`h-4 w-4 ${colors[toast.type]}`} />
              <span className="text-sm text-[var(--color-ink)]">{toast.message}</span>
              {toast.action && (
                <button
                  onClick={() => {
                    removeToast(toast.id);
                    toast.action?.onClick();
                  }}
                  className="ml-1 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-surface-muted)]"
                >
                  {toast.action.label}
                </button>
              )}
              <button
                onClick={() => removeToast(toast.id)}
                className="ml-2 text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

/**
 * 无 Provider 时返回 null 的变体（照 `useToast` 的同名语义，但不抛）。
 *
 * 用于**可独立挂载**的会话组件（如 `HuluSprintSession`）：应用根部有
 * `ToastProvider`，但组件级测试与嵌入式用法未必包着它 —— 那种情况下提示应安静
 * 缺席，而不是把整个会话炸掉。调用方负责判空。
 */
export function useOptionalToast(): ToastContextValue | null {
  return useContext(ToastContext);
}
