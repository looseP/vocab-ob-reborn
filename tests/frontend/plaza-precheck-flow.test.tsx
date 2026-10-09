/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlazaPrecheckFlow } from "@/frontend/components/plaza/PlazaPrecheckFlow";

const { apiFetchMock, addToastMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  addToastMock: vi.fn(),
}));

vi.mock("@/frontend/api/client", () => ({
  apiFetch: apiFetchMock,
}));

vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

const words = [
  { id: "w1", lemma: "compare", cefr: "A2", short_definition: "比较，对照" },
  { id: "w2", lemma: "prepare", cefr: "A2", short_definition: "准备" },
  { id: "w3", lemma: "apparent", cefr: "B2", short_definition: "显而易见的" },
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

function renderFlow() {
  const onClose = vi.fn();
  const onEnqueued = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(PlazaPrecheckFlow, { words, onClose, onEnqueued }),
      ),
    );
  });
  return { container, onClose, onEnqueued };
}

describe("PlazaPrecheckFlow 生词预审快闪", () => {
  it("逐词判定后汇总生词，并把生词 id 批量入队（写队列只在显式动作发生）", async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, added: 2, skipped: 0 });

    const { container, onEnqueued } = renderFlow();

    // 判定期间零写入
    act(() => {
      findButton(container, "不认识（←）")?.click(); // w1 生词
    });
    act(() => {
      findButton(container, "认识（→）")?.click(); // w2 认识
    });
    act(() => {
      findButton(container, "不认识（←）")?.click(); // w3 生词
    });
    expect(apiFetchMock).not.toHaveBeenCalled();

    // 汇总页
    expect(container.textContent).toContain("预审完成");
    expect(container.textContent).toContain("已认识 1 · 生词 2");

    await act(async () => {
      findButton(container, "把 2 个生词加入复习计划")?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/review/cards/batch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ wordIds: ["w1", "w3"] }),
      }),
    );
    expect(addToastMock).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("成功加入 2 个生词到复习队列"),
    );
    expect(onEnqueued).toHaveBeenCalledWith({ added: 2, skipped: 0, wordIds: ["w1", "w3"] });
  });

  it("键盘判定：空格翻面看释义，← 标生词 / → 标认识", () => {
    const { container } = renderFlow();

    // 空格翻面：显示释义
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    });
    expect(container.textContent).toContain("比较，对照");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" })); // w1 生词
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); // w2 认识
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); // w3 认识
    });

    expect(container.textContent).toContain("已认识 2 · 生词 1");
  });

  it("全部认识时无入队按钮，提示无需入队", () => {
    const { container } = renderFlow();
    act(() => {
      findButton(container, "认识（→）")?.click();
    });
    act(() => {
      findButton(container, "认识（→）")?.click();
    });
    act(() => {
      findButton(container, "认识（→）")?.click();
    });

    expect(container.textContent).toContain("本组全部认识");
    expect(findButton(container, "加入复习计划")).toBeUndefined();
  });
});
