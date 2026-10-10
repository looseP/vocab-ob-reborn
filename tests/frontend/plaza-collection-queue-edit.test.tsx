/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlazaCollectionPage } from "@/frontend/pages/PlazaCollectionPage";

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

const mockDetail = {
  slug: "root-par",
  title: "par",
  kind: "root_affix",
  count: 2,
  updatedAt: "2026-10-10T00:00:00.000Z",
  type: "simple",
  words: [
    { id: "w1", slug: "compare", lemma: "compare", cefr: "A2", short_definition: "比较，对照", semantic_chain: null, root: "par", prefix: "com", suffix: null },
    { id: "w2", slug: "prepare", lemma: "prepare", cefr: "A2", short_definition: "准备", semantic_chain: null, root: "par", prefix: "pre", suffix: null },
  ],
};

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

function renderCollection() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/plaza/root-par"] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: "/plaza/:slug", element: createElement(PlazaCollectionPage) }),
        ),
      ),
    );
  });
  return container;
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

describe("PlazaCollectionPage 队列编辑（P1）", () => {
  it("整组移出：cards/remove 提交集合全量词 id，成功后按钮回到「加入复习计划」并刷新统计", async () => {
    apiFetchMock
      .mockResolvedValueOnce(mockDetail) // 1 详情
      .mockResolvedValueOnce({ tracked: 0, due: 0, mastered: 0, learning: 0 }) // 2 初始统计
      .mockResolvedValueOnce({ ok: true, added: 2, skipped: 0, progressIds: ["p1", "p2"] }) // 3 入队
      .mockResolvedValueOnce({ tracked: 2, due: 0, mastered: 1, learning: 1 }) // 4 入队后统计
      .mockResolvedValueOnce({ ok: true, count: 2, wordIds: ["w1", "w2"] }) // 5 移出
      .mockResolvedValueOnce({ tracked: 0, due: 0, mastered: 0, learning: 0 }); // 6 移出后统计

    const container = renderCollection();
    await act(async () => { /* flush */ });

    await act(async () => {
      findButton(container, "加入复习计划 (2)")?.click();
    });

    const removeBtn = findButton(container, "移出队列 (2)");
    expect(removeBtn).toBeDefined();

    await act(async () => {
      removeBtn?.click();
    });

    expect(apiFetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/review/cards/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ wordIds: ["w1", "w2"] }) }),
    );
    expect(addToastMock).toHaveBeenCalledWith("success", "已从复习队列移出 2 词");
    // 按钮回到未入队态
    expect(findButton(container, "加入复习计划 (2)")).toBeDefined();
    expect(findButton(container, "移出队列 (2)")).toBeUndefined();
    // 移出后统计刷新（第 6 次调用）
    expect(apiFetchMock).toHaveBeenNthCalledWith(6, "/plaza/review-stats/root-par");
  });

  it("优先学这一组：先 batch 入队再 expire 提前到期，成功后进入已入队态", async () => {
    apiFetchMock
      .mockResolvedValueOnce(mockDetail) // 1 详情
      .mockResolvedValueOnce({ tracked: 0, due: 0, mastered: 0, learning: 0 }) // 2 初始统计
      .mockResolvedValueOnce({ ok: true, added: 2, skipped: 0, progressIds: ["p1", "p2"] }) // 3 batch
      .mockResolvedValueOnce({ ok: true, count: 2, wordIds: ["w1", "w2"] }) // 4 expire
      .mockResolvedValueOnce({ tracked: 2, due: 2, mastered: 0, learning: 0 }); // 5 统计刷新

    const container = renderCollection();
    await act(async () => { /* flush */ });

    await act(async () => {
      findButton(container, "优先学这一组")?.click();
    });

    expect(apiFetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/review/cards/batch",
      expect.objectContaining({ body: JSON.stringify({ wordIds: ["w1", "w2"] }) }),
    );
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/review/cards/expire",
      expect.objectContaining({ body: JSON.stringify({ wordIds: ["w1", "w2"] }) }),
    );
    expect(addToastMock).toHaveBeenCalledWith("success", "已把 2 词提到队列最前");
    // 已入队态（可继续移出）
    expect(findButton(container, "移出队列 (2)")).toBeDefined();
  });
});
