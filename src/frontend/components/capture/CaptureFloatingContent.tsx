import { useCallback, useEffect, useState } from "react";
import { ClipboardType, Maximize2 } from "lucide-react";
import { CapturePage } from "@/frontend/pages/CapturePage";
import { ToastProvider } from "@/frontend/components/ui/Toast";

export type CaptureFloatingMode = "panel" | "ball";

const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 620;
/**
 * Chrome clamps PiP windows to an internal minimum size. When the granted
 * size exceeds the ball budget we fall back to a full-surface capsule bar so
 * there is no dead space; CSS centring keeps the plain-circle form working
 * whenever the OS actually honours 64px.
 */
const BALL_SIZE = 64;
const CLAMP_THRESHOLD_PX = 100;

type BallLayout = "circle" | "bar";

interface CaptureFloatingContentProps {
  pipWindow: Window;
}

function isToggleShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "b"
  );
}

export function CaptureFloatingContent({ pipWindow }: CaptureFloatingContentProps) {
  const [mode, setMode] = useState<CaptureFloatingMode>("panel");
  const [ballLayout, setBallLayout] = useState<BallLayout>("circle");

  const enterBall = useCallback(() => {
    setMode("ball");
    try {
      pipWindow.resizeTo(BALL_SIZE, BALL_SIZE);
    } catch {
      // visibility toggle below still works even where resize is refused
    }
  }, [pipWindow]);

  const enterPanel = useCallback(() => {
    setMode("panel");
    try {
      pipWindow.resizeTo(PANEL_WIDTH, PANEL_HEIGHT);
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      pipWindow.document
        .querySelector<HTMLInputElement>('input[aria-label="要捕获的单词"]')
        ?.focus();
    });
  }, [pipWindow]);

  // Detect OS size clamping while in ball mode and adapt the layout.
  useEffect(() => {
    if (mode !== "ball") return;
    const evaluate = () => {
      const width = pipWindow.innerWidth || 0;
      const height = pipWindow.innerHeight || 0;
      setBallLayout(
        width > CLAMP_THRESHOLD_PX || height > CLAMP_THRESHOLD_PX ? "bar" : "circle",
      );
    };
    evaluate();
    pipWindow.addEventListener("resize", evaluate);
    return () => pipWindow.removeEventListener("resize", evaluate);
  }, [mode, pipWindow]);

  // Ctrl/Cmd+B toggles between ball and panel inside the PiP document.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isToggleShortcut(event)) return;
      event.preventDefault();
      if (mode === "panel") enterBall();
      else enterPanel();
    };
    pipWindow.document.addEventListener("keydown", onKeyDown);
    return () => pipWindow.document.removeEventListener("keydown", onKeyDown);
  }, [mode, enterBall, enterPanel, pipWindow]);

  useEffect(() => {
    try {
      pipWindow.document.body.style.background = "transparent";
    } catch {
      // ignore — opaque corners are cosmetic only
    }
  }, [pipWindow]);

  return (
    <>
      <div data-floating="panel" style={{ display: mode === "panel" ? "block" : "none" }}>
        <ToastProvider>
          <CapturePage onCollapse={enterBall} />
        </ToastProvider>
      </div>
      <div
        data-floating="ball"
        data-ball-layout={ballLayout}
        style={{ display: mode === "ball" ? "flex" : "none" }}
        className="fixed inset-0 items-stretch justify-stretch overflow-hidden bg-[var(--color-canvas)]"
      >
        {ballLayout === "bar" ? (
          <button
            type="button"
            onClick={() => enterPanel()}
            aria-label="展开快速捕获面板"
            title="展开快速捕获面板 (Ctrl+B)"
            className="group flex w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[var(--color-surface-glass-hover)]"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[rgb(var(--color-accent-rgb)/0.72)] text-white shadow-[0_6px_18px_-4px_rgb(var(--color-shadow-warm)/0.45)]">
              <ClipboardType className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight text-[var(--color-ink)]">
                快速捕获
              </span>
              <span className="block text-[11px] leading-tight text-[var(--color-ink-soft)]">
                点击展开面板
              </span>
            </span>
            <Maximize2 className="ml-auto h-4 w-4 shrink-0 text-[var(--color-ink-soft)] transition-transform duration-150 group-hover:scale-110 group-hover:text-[var(--color-accent)]" />
          </button>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <button
              type="button"
              onClick={() => enterPanel()}
              aria-label="展开快速捕获面板"
              title="展开快速捕获面板 (Ctrl+B)"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-accent)] to-[rgb(var(--color-accent-rgb)/0.72)] text-white shadow-[0_6px_18px_-4px_rgb(var(--color-shadow-warm)/0.45)] transition-transform duration-150 hover:scale-105 active:scale-95"
            >
              <ClipboardType className="h-6 w-6" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
