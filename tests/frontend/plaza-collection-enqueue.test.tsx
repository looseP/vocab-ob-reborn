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
  updatedAt: "2026-10-09T00:00:00.000Z",
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

describe("PlazaCollectionPage 整组加入复习计划", () => {
  it("整组入队：cards/batch 提交集合全量词 id，成功后按钮进入已入队态并刷新 E1 统计", async () => {
    apiFetchMock
      .mockResolvedValueOnce(mockDetail) // 1 集合详情
      .mockResolvedValueOnce({ tracked: 0, due: 0, mastered: 0, learning: 0 }) // 2 初始复习统计
      .mockResolvedValueOnce({ ok: true, added: 2, skipped: 0, progressIds: ["p1", "p2"] }) // 3 批量入队
      .mockResolvedValueOnce({ tracked: 2, due: 0, mastered: 1, learning: 1 }); // 4 入队后刷新统计

    const container = renderCollection();
    await act(async () => { /* flush 详情与统计的微任务 */ });

    const addBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("加入复习计划 (2)"),
    );
    expect(addBtn).toBeDefined();

    await act(async () => {
      addBtn?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/review/cards/batch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ wordIds: ["w1", "w2"] }),
      }),
    );
    expect(addToastMock).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("成功加入 2 词到复习队列"),
    );

    const doneBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("已在复习队列"),
    );
    expect(doneBtn).toBeDefined();
    expect(doneBtn?.disabled).toBe(true);

    // P1-B：入队后掌握条随刷新统计即时更新（total 2：已掌握 1 · 学习中 1 · 未学 0）
    expect(container.textContent).toContain("已掌握 1 · 学习中 1 · 未学 0");

    // 入队成功后刷新集合内复习统计（第 4 次 apiFetch 调用）
    expect(apiFetchMock).toHaveBeenNthCalledWith(4, "/plaza/review-stats/root-par");
  });

  it("重复词计入 skipped：toast 说明跳过数量，按钮仍进入已入队态", async () => {
    apiFetchMock
      .mockResolvedValueOnce(mockDetail)
      .mockResolvedValueOnce({ tracked: 0, due: 0, mastered: 0, learning: 0 })
      .mockResolvedValueOnce({ ok: true, added: 0, skipped: 2, progressIds: [] })
      .mockResolvedValueOnce({ tracked: 2, due: 0, mastered: 1, learning: 1 });

    const container = renderCollection();
    await act(async () => { /* flush */ });

    const addBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("加入复习计划 (2)"),
    );
    await act(async () => {
      addBtn?.click();
    });

    expect(addToastMock).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("已在队列 2 词"),
    );
  });
});
