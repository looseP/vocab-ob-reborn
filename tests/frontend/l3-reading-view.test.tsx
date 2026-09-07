/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3ReadingView, computeGlobalOffsets } from "@/frontend/components/l3/L3ReadingView";

// 仓库无 @testing-library/react，按 tests/l3-manual-editor-page.test.ts 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
// useToast 依赖 ToastProvider 上下文；圈记用例只关心提交流程，直接 mock 掉。
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
import { apiFetch } from "@/frontend/api/client";

const SPACE = {
  source: { id: "s1", title: "The Economist", source_type: "web", language: "en", content_text: "Alpha beta. Gamma delta epsilon. Zeta." },
  contexts: [
    { id: "c1", text: "Gamma delta epsilon.", position: { start: 12, end: 32 } },
  ],
  occurrences: [],
  links: [],
  words: [{ id: "w-1", slug: "delta", title: "delta" }],
  stats: {},
  limit: 200, cursor: null, nextCursor: null,
};

// 用例 2 的深链断言要求高亮渲染为 Link（context 已绑词）：
// SPACE.occurrences 为空时组件按计划渲染 <mark>，closest("a") 恒为 null，
// 故仅该用例补一条 occurrence 绑定，其余 mock 值与计划保持一致。
const SPACE_WITH_LINK = {
  ...SPACE,
  occurrences: [{ context_id: "c1", word_id: "w-1" }],
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderView(sourceId: string, space: unknown): Promise<void> {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  apiFetchMock.mockResolvedValue(space);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(L3ReadingView, { sourceId }) as ReactElement,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

// 圈记用例会 stub window.getSelection（jsdom Range 支持有限），用后恢复避免污染同文件其他用例。
const realGetSelection = window.getSelection.bind(window);

afterEach(() => {
  Object.defineProperty(window, "getSelection", { value: realGetSelection, configurable: true, writable: true });
  act(() => {
    for (const { root } of mountedRoots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

describe("L3ReadingView", () => {
  beforeEach(() => { (apiFetch as ReturnType<typeof vi.fn>).mockReset(); });

  it("renders full text with highlight only at captured anchors", async () => {
    await renderView("s1", SPACE);
    await waitFor(() => expect(screen.getByText(/Gamma delta epsilon/)).toBeTruthy());
    expect(screen.getByText(/Alpha beta/)).toBeTruthy();
    const mark = screen.getByText(/Gamma delta epsilon/).closest("mark");
    expect(mark).toBeTruthy();
  });

  it("navigates to word detail on highlight click", async () => {
    await renderView("s1", SPACE_WITH_LINK);
    await screen.findByText(/Gamma delta epsilon/);
    await act(async () => {
      fireEvent.click(screen.getByText(/Gamma delta epsilon/));
    });
    // 深链断言：跳词卡由 Link to=/words/delta 完成
    expect(screen.getByText(/Gamma delta epsilon/).closest("a")).toBeTruthy();
  });

  it("shows empty state when source has no content_text", async () => {
    await renderView("s1", {
      ...SPACE, source: { ...SPACE.source, content_text: null },
    });
    await waitFor(() => expect(screen.getByText("该来源无正文")).toBeTruthy());
  });

  describe("computeGlobalOffsets", () => {
    it("accumulates UTF-16 offsets across sibling text nodes", () => {
      const host = document.createElement("div");
      const a = document.createTextNode("Alpha beta. ");
      const mark = document.createElement("mark");
      mark.appendChild(document.createTextNode("Gamma delta epsilon."));
      const c = document.createTextNode(" Zeta.");
      host.append(a, mark, c);
      expect(computeGlobalOffsets(host, a, 0, c, 4)).toEqual({ start: 0, end: 36 });
      expect(computeGlobalOffsets(host, mark.firstChild!, 6, c, 2)).toEqual({ start: 18, end: 34 });
    });

    it("returns null for collapsed or out-of-container ranges", () => {
      const host = document.createElement("div");
      const a = document.createTextNode("Alpha");
      host.append(a);
      expect(computeGlobalOffsets(host, a, 3, a, 3)).toBeNull();
      const outsider = document.createTextNode("outside");
      expect(computeGlobalOffsets(host, outsider, 0, a, 2)).toBeNull();
    });
  });

  it("captures selection as sentence and reloads highlights", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock
      .mockResolvedValueOnce(SPACE) // 初始 load
      .mockResolvedValueOnce({ contextId: "c9", occurrenceId: "o9", word: { id: "w-1", slug: "delta", title: "delta" }, created: false }) // POST /captures
      .mockResolvedValueOnce({       // 圈记成功后 reload
        ...SPACE,
        contexts: [...SPACE.contexts, { id: "c9", text: "Zeta.", position: { start: 34, end: 39 } }],
      });
    await renderView("s1", SPACE);
    await screen.findByText(/Gamma delta epsilon/);
    const container = document.querySelector("[data-reading-text]") as HTMLElement;
    expect(container).toBeTruthy();
    // 模拟选区：stub window.getSelection 返回固定区间。注意 startContainer/endContainer
    // 必须给文本节点（TreeWalker 只遍历文本节点），计划脚注允许按 jsdom 支持度调整。
    const startNode = container.firstChild!.firstChild!;
    const endNode = container.lastChild!.firstChild!;
    Object.defineProperty(window, "getSelection", {
      value: () => ({
        rangeCount: 1,
        getRangeAt: () => ({
          startContainer: startNode,
          startOffset: 0,
          endContainer: endNode,
          endOffset: 4,
          collapsed: false,
          commonAncestorContainer: container,
        }),
      }),
      configurable: true,
    });
    await act(async () => {
      fireEvent.mouseUp(container);
    });
    // 圈记条渲染：已选中预览 + 目标词预填首词 + 三个操作
    await screen.findByText(/已选中/);
    const targetInput = screen.getByPlaceholderText("目标词") as HTMLInputElement;
    expect(targetInput.value).toBe("Alpha");
    expect(screen.getByText("记录整句")).toBeTruthy();
    expect(screen.getByText("记录搭配")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("记录整句"));
      await waitFor(() =>
        expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("/captures"))).toBe(true),
      );
      // POST 成功后 reload() 刷新高亮：初始 load + POST + reload 共 3 次
      await waitFor(() => expect(apiFetchMock.mock.calls).toHaveLength(3));
    });
    const captureCall = apiFetchMock.mock.calls.find(([url]) => String(url).includes("/captures"))!;
    const init = captureCall[1] as { method?: string; body?: string };
    expect(init.method).toBe("POST");
    // sentence 分支：锚点被 findSentenceRange 扩展为覆盖完整句子的区间
    expect(JSON.parse(init.body ?? "{}")).toEqual({
      text: "Alpha beta. Gamma delta epsilon. Zeta.",
      anchorStart: 0,
      anchorEnd: 38,
      surface: "Alpha",
      wordSlug: "alpha",
      contextType: "sentence",
    });
  });
});
