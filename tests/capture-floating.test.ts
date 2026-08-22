/// <reference lib="dom" />
// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureFloatingContent } from "@/frontend/components/capture/CaptureFloatingContent";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) {
      mounted.root.unmount();
    }
  });
  document.body.innerHTML = "";
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeFakePipWindow(size: { width: number; height: number } = { width: 400, height: 620 }): Window & {
  resizeTo: ReturnType<typeof vi.fn>;
  innerWidth: number;
  innerHeight: number;
  fireResize: () => void;
  fireKeydown: (event: Partial<KeyboardEvent>) => void;
} {
  const windowResizeListeners: Array<() => void> = [];
  const keydownListeners: Array<(event: KeyboardEvent) => void> = [];
  const fake = {
    resizeTo: vi.fn(),
    innerWidth: size.width,
    innerHeight: size.height,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "resize") windowResizeListeners.push(listener);
    }),
    removeEventListener: vi.fn(),
    document: {
      title: "",
      querySelector: () => null,
      body: { style: {} as CSSStyleDeclaration },
      documentElement: { style: {} as CSSStyleDeclaration },
      addEventListener: vi.fn((_type: string, listener: (event: KeyboardEvent) => void) => {
        keydownListeners.push(listener);
      }),
      removeEventListener: vi.fn(),
    },
    fireResize() {
      for (const listener of [...windowResizeListeners]) listener();
    },
    fireKeydown(event: Partial<KeyboardEvent>) {
      const full = { preventDefault: () => undefined, ...event } as KeyboardEvent;
      for (const listener of [...keydownListeners]) listener(full);
    },
  };
  return fake as unknown as Window & {
    resizeTo: ReturnType<typeof vi.fn>;
    innerWidth: number;
    innerHeight: number;
    fireResize: () => void;
    fireKeydown: (event: Partial<KeyboardEvent>) => void;
  };
}

function renderContent(pipWindow: Window): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(CaptureFloatingContent, { pipWindow }));
  });
  mountedRoots.push({ container, root });
  return container;
}

describe("CaptureFloatingContent — dual-form switching", () => {
  it("starts in panel mode with the ball hidden", () => {
    const pipWindow = makeFakePipWindow();
    const container = renderContent(pipWindow as unknown as Window);

    const panel = container.querySelector('[data-floating="panel"]')!;
    const ball = container.querySelector('[data-floating="ball"]')!;
    expect(panel.getAttribute("style")).toContain("block");
    expect(ball.getAttribute("style")).toContain("none");
  });

  it("collapses to the ball, resizes the window, and preserves panel state on expand", async () => {
    const pipWindow = makeFakePipWindow();
    const container = renderContent(pipWindow as unknown as Window);

    // Type into the panel input first — this state must survive the round trip.
    const input = document.body.querySelector('input[aria-label="要捕获的单词"]')!;
    act(() => {
      fireEvent.change(input, { target: { value: "ephemeral" } });
    });

    const collapseButton = document.body.querySelector('button[aria-label="收起为悬浮球"]')!;
    await act(async () => {
      fireEvent.click(collapseButton);
    });

    await waitFor(() => {
      expect(pipWindow.resizeTo).toHaveBeenCalledWith(64, 64);
    });
    const panel = container.querySelector('[data-floating="panel"]')!;
    const ball = container.querySelector('[data-floating="ball"]')!;
    expect(panel.getAttribute("style")).toContain("none");
    expect(ball.getAttribute("style")).toContain("flex");

    const expandButton = document.body.querySelector('button[aria-label="展开快速捕获面板"]')!;
    await act(async () => {
      fireEvent.click(expandButton);
    });

    await waitFor(() => {
      expect(pipWindow.resizeTo).toHaveBeenLastCalledWith(400, 620);
    });
    expect(container.querySelector('[data-floating="panel"]')!.getAttribute("style")).toContain("block");

    // State preservation: the typed value is still there after the round trip.
    const inputAfter = document.body.querySelector<HTMLInputElement>('input[aria-label="要捕获的单词"]')!;
    expect(inputAfter.value).toBe("ephemeral");
  });

  it("marks the PiP body transparent once for the rounded ball", async () => {
    const pipWindow = makeFakePipWindow();
    renderContent(pipWindow as unknown as Window);

    await waitFor(() => {
      expect(
        (pipWindow as unknown as { document: { body: { style: CSSStyleDeclaration } } }).document.body.style
          .background,
      ).toBe("transparent");
    });
  });

  it("toggles ball/panel with Ctrl+B inside the PiP document", async () => {
    const pipWindow = makeFakePipWindow();
    const container = renderContent(pipWindow as unknown as Window);

    await act(async () => {
      (pipWindow as unknown as { fireKeydown: (e: Partial<KeyboardEvent>) => void }).fireKeydown({
        ctrlKey: true,
        key: "b",
      });
    });

    expect(container.querySelector('[data-floating="panel"]')!.getAttribute("style")).toContain("none");
    expect(container.querySelector('[data-floating="ball"]')!.getAttribute("style")).toContain("flex");

    await act(async () => {
      (pipWindow as unknown as { fireKeydown: (e: Partial<KeyboardEvent>) => void }).fireKeydown({
        ctrlKey: true,
        key: "b",
      });
    });

    expect(container.querySelector('[data-floating="panel"]')!.getAttribute("style")).toContain("block");
    expect(container.querySelector('[data-floating="ball"]')!.getAttribute("style")).toContain("none");
  });

  it("switches the collapsed form to the capsule bar when the OS clamps the size", async () => {
    const pipWindow = makeFakePipWindow({ width: 480, height: 160 });
    const container = renderContent(pipWindow as unknown as Window);

    const collapseButton = document.body.querySelector('button[aria-label="收起为悬浮球"]')!;
    await act(async () => {
      fireEvent.click(collapseButton);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-floating="ball"]')!.getAttribute("data-ball-layout")).toBe("bar");
    });
    expect(container.textContent).toContain("快速捕获");
    expect(container.textContent).toContain("点击展开面板");
  });
});
