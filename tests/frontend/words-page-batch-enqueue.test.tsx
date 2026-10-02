/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordsPage } from "@/frontend/pages/WordsPage";

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

vi.mock("@/frontend/hooks/useRecentSearches", () => ({
  useRecentSearches: () => ({ recent: [], add: vi.fn(), remove: vi.fn(), clear: vi.fn() }),
}));

vi.mock("@/frontend/hooks/useWordSuggest", () => ({
  useWordSuggest: () => ({ suggestions: [] }),
}));

const mockWords = [
  { id: "w1", slug: "apple", title: "apple", lemma: "apple", is_published: true },
  { id: "w2", slug: "banana", title: "banana", lemma: "banana", is_published: true },
];

vi.mock("@/frontend/hooks/useWords", () => ({
  useWords: () => ({
    words: mockWords,
    loading: false,
    loadingMore: false,
    error: null,
    total: 2,
    hasMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/frontend/components/words/WordList", () => ({
  WordList: (props: { words: typeof mockWords; selecting?: boolean; selectedIds?: Set<string>; onToggleSelect?: (id: string) => void }) =>
    createElement("div", { "data-testid": "word-list" },
      props.words.map((w) =>
        createElement("div", { key: w.id },
          props.selecting && createElement("button", {
            "data-testid": `toggle-${w.id}`,
            onClick: () => props.onToggleSelect?.(w.id),
          }, `toggle ${w.lemma}`),
        ),
      ),
    ),
}));

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

describe("WordsPage batch enqueue", () => {
  it("allows selecting words and batch adding to review queue", async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, added: 2, skipped: 0, progressIds: ["p1", "p2"] });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(WordsPage)));
    });

    // 1. Click "多选模式"
    const enterSelectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("多选模式"),
    );
    expect(enterSelectBtn).toBeDefined();

    act(() => {
      enterSelectBtn?.click();
    });

    // 2. Click "全选本页"
    const selectAllBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("全选本页"),
    );
    expect(selectAllBtn).toBeDefined();

    act(() => {
      selectAllBtn?.click();
    });

    // 3. Click "加入复习计划 (2)"
    const batchAddBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("加入复习计划 (2)"),
    );
    expect(batchAddBtn).toBeDefined();

    await act(async () => {
      batchAddBtn?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/review/cards/batch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ wordIds: ["w1", "w2"] }),
      }),
    );

    expect(addToastMock).toHaveBeenCalledWith("success", expect.stringContaining("成功加入 2 词到复习队列"));
  });
});
