import { useCallback } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CaptureFloatingContent } from "@/frontend/components/capture/CaptureFloatingContent";
import { getBrowserSession } from "@/frontend/api/browserAuth";

/**
 * Document Picture-in-Picture (Chromium 116+) — the only pure-web way to get
 * a real always-on-top floating window. Minimal local typing; the API is not
 * in the current TS DOM lib.
 */
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export function supportsDocumentPiP(target: Window = window): boolean {
  return "documentPictureInPicture" in target && target.documentPictureInPicture != null;
}

export type CaptureWindowLaunchResult =
  | "pip"
  | "popup"
  | "popup-blocked"
  | "unauthenticated";

const PIP_WIDTH = 400;
const PIP_HEIGHT = 620;

let activePipRoot: { window: Window; root: Root } | null = null;

function cloneStylesInto(pipDoc: Document): void {
  for (const node of Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))) {
    pipDoc.head.appendChild(node.cloneNode(true));
  }
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme) pipDoc.documentElement.setAttribute("data-theme", theme);
}

function openPopupFallback(): boolean {
  return window.open("/capture", "vocab-capture", `width=${PIP_WIDTH},height=${PIP_HEIGHT}`) != null;
}

/**
 * Open the capture UI as a floating window:
 * - Chromium: a Document Picture-in-Picture window (always-on-top, OS-draggable)
 *   rendering the same CapturePage component tree.
 * - Otherwise: a plain small popup window at /capture.
 * Returns "unauthenticated" without opening anything when no session exists —
 * cookies are shared with the main window, so logging in there is enough.
 */
/**
 * Pure launcher — no React context required, so it is directly unit-testable.
 * The hook below is a thin memoised wrapper for component use.
 */
export async function launchCaptureWindow(): Promise<CaptureWindowLaunchResult> {
  const session = await getBrowserSession();
  if (!session) return "unauthenticated";

  if (!supportsDocumentPiP()) {
    // The await above may have consumed the user-gesture window; a blocked
    // popup is reported instead of failing silently.
    return openPopupFallback() ? "popup" : "popup-blocked";
  }

  if (activePipRoot && !activePipRoot.window.closed) {
    activePipRoot.window.focus();
    return "pip";
  }

  let pipWindow: Window;
  try {
    pipWindow = await window.documentPictureInPicture!.requestWindow({
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
    });
  } catch {
    // e.g. another PiP request in flight or transient activation expired —
    // degrade to the plain popup instead of crashing the click handler.
    return openPopupFallback() ? "popup" : "popup-blocked";
  }
  pipWindow.document.title = "快速捕获 · Vocab Observatory";
  cloneStylesInto(pipWindow.document);

  const root = createRoot(pipWindow.document.body);
  root.render(createElement(CaptureFloatingContent, { pipWindow }));
  activePipRoot = { window: pipWindow, root };

  requestAnimationFrame(() => {
    pipWindow.document
      .querySelector<HTMLInputElement>('input[aria-label="要捕获的单词"]')
      ?.focus();
  });

  // Keep the floating window in sync when the main window toggles the theme.
  const themeObserver = new MutationObserver(() => {
    const theme = document.documentElement.getAttribute("data-theme");
    if (theme) pipWindow.document.documentElement.setAttribute("data-theme", theme);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  pipWindow.addEventListener("pagehide", () => {
    themeObserver.disconnect();
    root.unmount();
    if (activePipRoot?.window === pipWindow) activePipRoot = null;
  });

  return "pip";
}

export function useCaptureFloatingWindow() {
  return useCallback(() => launchCaptureWindow(), []);
}
