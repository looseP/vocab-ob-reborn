/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 生词本维度（2026-10-11）的前端契约：
 *  - 视图维度写在 URL 上（`/words?scope=stub`），深链、后退、命令面板共用同一处状态
 *  - 维度切换把 scope 交给数据层（useWords），并给出「生词本」语义的标题与标记
 *  - 空列表给的是「去捕获」引导，而不是给正式词条用的「没有找到匹配」
 *
 * 这里刻意不 mock WordList：待补全标记与空态文案正是本次要钉住的行为。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WordsPage } from "@/frontend/pages/WordsPage";

const { apiFetchMock, wordsState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  wordsState: {
    words: [] as Array<Record<string, unknown>>,
    total: 0,
    calls: [] as Array<Record<string, unknown> | undefined>,
  },
}));

vi.mock("@/frontend/api/client", () => ({ apiFetch: apiFetchMock }));

vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock("@/frontend/hooks/useRecentSearches", () => ({
  useRecentSearches: () => ({ recent: [], add: vi.fn(), remove: vi.fn(), clear: vi.fn() }),
}));

vi.mock("@/frontend/hooks/useWordSuggest", () => ({
  useWordSuggest: () => ({ suggestions: [] }),
}));

vi.mock("@/frontend/hooks/useWords", () => ({
  useWords: (params?: Record<string, unknown>) => {
    wordsState.calls.push(params);
    return {
      words: wordsState.words,
      loading: false,
      loadingMore: false,
      error: null,
      total: wordsState.total,
      hasMore: false,
      loadMore: vi.fn(),
    };
  },
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function renderAt(path: string): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(WordsPage)));
  });
  return container;
}

function lastWordsParams(): Record<string, unknown> | undefined {
  return wordsState.calls[wordsState.calls.length - 1];
}

function scopeTab(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.textContent === label,
  );
}

afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  wordsState.words = [];
  wordsState.total = 0;
  wordsState.calls = [];
  vi.clearAllMocks();
});

describe("WordsPage · 生词本维度", () => {
  it("默认是词条库：scope=content，标题与 tab 都停在词条库", () => {
    const container = renderAt("/words");

    expect(lastWordsParams()?.scope).toBe("content");
    expect(container.querySelector("h1")?.textContent).toBe("词条库");
    expect(scopeTab(container, "词条库")?.getAttribute("aria-selected")).toBe("true");
  });

  it("深链 /words?scope=stub 直接进生词本：数据层拿到 stub，标题与 tab 同步切档", () => {
    const container = renderAt("/words?scope=stub");

    expect(lastWordsParams()?.scope).toBe("stub");
    expect(container.querySelector("h1")?.textContent).toBe("生词本");
    expect(scopeTab(container, "生词本")?.getAttribute("aria-selected")).toBe("true");
    expect(scopeTab(container, "词条库")?.getAttribute("aria-selected")).toBe("false");
  });

  it("点击「生词本」把维度写回 URL（可分享、可后退），下一个请求就是 stub", () => {
    const container = renderAt("/words");

    act(() => {
      scopeTab(container, "生词本")?.click();
    });

    expect(lastWordsParams()?.scope).toBe("stub");
    expect(container.querySelector("h1")?.textContent).toBe("生词本");
  });

  it("生词条目带「待补全」标记，计数按「生词」口径描述", () => {
    wordsState.words = [
      { id: "w1", slug: "serendipity", title: "serendipity", lemma: "serendipity", is_published: true },
    ];
    wordsState.total = 1;

    const container = renderAt("/words?scope=stub");

    expect(container.textContent).toContain("待补全");
    expect(container.textContent).toContain("已加载 1 / 1 个生词");
  });

  it("生词本为空时给捕获引导，而不是正式词条口径的「没有找到匹配」", () => {
    const container = renderAt("/words?scope=stub");

    expect(container.textContent).toContain("生词本还空着");
    expect(container.textContent).toContain("去捕获一个词");
    expect(container.textContent).not.toContain("没有找到匹配的单词");
  });
});
