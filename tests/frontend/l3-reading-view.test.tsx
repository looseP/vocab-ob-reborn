/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

// ② 多词语境（2026-09-08 用户反馈）：同一句圈了两个词——点击高亮应弹选词菜单。
const SPACE_MULTI_WORD = {
  ...SPACE,
  words: [
    { id: "w-1", slug: "delta", title: "delta" },
    { id: "w-2", slug: "epsilon", title: "epsilon" },
  ],
  occurrences: [
    { context_id: "c1", word_id: "w-1" },
    { context_id: "c1", word_id: "w-2" },
  ],
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderView(sourceId: string, space: unknown, focusContextId?: string): Promise<void> {
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
        createElement(L3ReadingView, { sourceId, focusContextId }) as ReactElement,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

// 圈记用例统一 stub：选中 "Gamm"（跨首尾文本节点，offset 0-4），jsdom Range 支持有限。
// startContainer/endContainer 必须给文本节点（TreeWalker 只遍历文本节点）。
function stubRangeSelection(container: HTMLElement): void {
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
}

// 用后恢复避免污染同文件其他用例。
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

  // 交互隔离（2026-09-08 用户反馈）：高亮文本回归纯标记（可随意划词选中），
  // 跳转入口移到句尾小标号——点击标号从右侧弹出相关词汇面板。
  it("renders highlights as plain marks with a numbered badge that opens the words panel", async () => {
    await renderView("s1", SPACE_MULTI_WORD);
    await screen.findByText(/Gamma delta epsilon/);
    const container = document.querySelector("[data-reading-text]") as HTMLElement;
    expect(container.querySelector("a")).toBeNull();
    // 高亮本身不可点击跳转（无 pointer 光标）
    const mark = screen.getByText(/Gamma delta epsilon/).closest("mark");
    expect(mark?.className).not.toContain("cursor-pointer");
    // 句尾小标号：点击打开右侧面板
    const badge = container.querySelector("[data-context-badge='c1']") as HTMLElement;
    expect(badge?.textContent).toBe("1");
    await act(async () => { fireEvent.click(badge); });
    const panel = document.querySelector("[data-word-panel]") as HTMLElement;
    expect(panel).toBeTruthy();
    const links = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/words/delta");
    expect(links).toContain("/words/epsilon");
    // 面板可关闭
    await act(async () => { fireEvent.click(screen.getByText("关闭")); });
    expect(document.querySelector("[data-word-panel]")).toBeNull();
  });

  // 视觉/交互优化（2026-09-08 用户反馈）：面板是悬浮卡片（不再通天全高），
  // 且支持 Esc 与点击面板外区域关闭。
  it("closes the panel on Escape and on outside click", async () => {
    await renderView("s1", SPACE_MULTI_WORD);
    await screen.findByText(/Gamma delta epsilon/);
    const badge = document.querySelector("[data-context-badge='c1']") as HTMLElement;
    await act(async () => { fireEvent.click(badge); });
    expect(document.querySelector("[data-word-panel]")).toBeTruthy();
    // Esc 关闭
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector("[data-word-panel]")).toBeNull();
    // 重新打开后，点击面板外区域关闭
    await act(async () => { fireEvent.click(badge); });
    expect(document.querySelector("[data-word-panel]")).toBeTruthy();
    await act(async () => { fireEvent.click(document.body); });
    expect(document.querySelector("[data-word-panel]")).toBeNull();
  });

  it("keeps highlighted text inert on click — no navigation, no panel", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock.mockResolvedValue(SPACE_WITH_LINK);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/", element: createElement(L3ReadingView, { sourceId: "s1" }) as ReactElement }),
            createElement(Route, { path: "/words/:slug", element: createElement("div", null, "WORD-PAGE") as ReactElement }),
          ),
        ) as ReactElement,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    // 点高亮文本：不导航、不弹面板（标记与跳转隔离）
    await act(async () => { fireEvent.click(screen.getByText(/Gamma delta epsilon/)); });
    expect(screen.queryByText("WORD-PAGE")).toBeNull();
    expect(document.querySelector("[data-word-panel]")).toBeNull();
    // 经标号面板跳词卡仍然可用（单词语境也走面板）
    const badge = document.querySelector("[data-context-badge='c1']") as HTMLElement;
    await act(async () => { fireEvent.click(badge); });
    await act(async () => { fireEvent.click(document.querySelector("[data-word-panel] a")!); });
    await screen.findByText("WORD-PAGE");
  });

  it("shows empty state when source has no content_text", async () => {
    await renderView("s1", {
      ...SPACE, source: { ...SPACE.source, content_text: null },
    });
    await waitFor(() => expect(screen.getByText("该来源无正文")).toBeTruthy());
  });

  // P0 深链落点（2026-09-08 评估）：?contextId= 不再落工程检查器，而是落阅读视图
  // 并滚动+闪高亮对应语境（L2 Drill「查看原文」、复习卡 Tier 2 的精确落点）。
  it("focuses and flashes the requested context after load", async () => {
    const scrollSpy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollSpy, configurable: true, writable: true });
    try {
      await renderView("s1", SPACE, "c1");
      await screen.findByText(/Gamma delta epsilon/);
      const mark = screen.getByText(/Gamma delta epsilon/).closest("mark") as HTMLElement;
      expect(mark.getAttribute("data-context-id")).toBe("c1");
      expect(mark.className).toContain("l3-focus-flash");
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    }
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
    stubRangeSelection(container);
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
      // POST 成功后 reload() 刷新高亮：初始 load + POST + reload 共 3 次。
      // 排除 /words/ 词库回显调用——目标词 300ms 防抖查询在慢环境下可能在断言前触发。
      await waitFor(() =>
        expect(apiFetchMock.mock.calls.filter(([url]) => !String(url).includes("/words/"))).toHaveLength(3),
      );
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

  // 词库回显（用户反馈 2026-09-08）：目标词在库 → 显示词条基本信息 + 绑定提示；
  // 不在库（404）→ 提示将自动创建生词条目。防抖 300ms，real timers + waitFor 轮询。
  it("echoes library word info when target word exists", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    await renderView("s1", SPACE); // 初始 load 走默认 mock；词库查询的 Once 必须在其后入队
    apiFetchMock.mockResolvedValueOnce({
      slug: "alpha", title: "alpha", pos: "noun", ipa: "/ˈælfə/", short_definition: "the first Greek letter",
    });
    await screen.findByText(/Gamma delta epsilon/);
    const container = document.querySelector("[data-reading-text]") as HTMLElement;
    stubRangeSelection(container);
    await act(async () => {
      fireEvent.mouseUp(container);
    });
    // 防抖窗口内：立即显示查询中
    expect(screen.getByText("查询词库…")).toBeTruthy();
    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("/words/alpha"))).toBe(true),
    );
    await screen.findByText("✓ 词库已有");
    const echoLink = screen.getByText("alpha").closest("a");
    expect(echoLink?.getAttribute("href")).toBe("/words/alpha");
    expect(screen.getByText("/ˈælfə/")).toBeTruthy();
    expect(screen.getByText("noun.")).toBeTruthy();
    expect(screen.getByText(/the first Greek letter/)).toBeTruthy();
    expect(screen.getByText(/圈记将绑定到该词条/)).toBeTruthy();
    expect(screen.queryByText(/自动创建生词条目/)).toBeNull();
  });

  it("hints stub creation when target word is not in the library", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    await renderView("s1", SPACE); // 初始 load 走默认 mock；404 的 Once 在其后入队
    apiFetchMock.mockRejectedValueOnce(new Error("not found"));
    await screen.findByText(/Gamma delta epsilon/);
    const container = document.querySelector("[data-reading-text]") as HTMLElement;
    stubRangeSelection(container);
    await act(async () => {
      fireEvent.mouseUp(container);
    });
    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("/words/alpha"))).toBe(true),
    );
    // findByText 轮询等待 miss 状态提交（waitFor 命中调用注册与 rejection 微任务落账之间有竞态）
    await screen.findByText(/词库中还没有/);
    expect(screen.getByText(/自动创建生词条目/)).toBeTruthy();
    expect(screen.queryByText("✓ 词库已有")).toBeNull();
  });
});
