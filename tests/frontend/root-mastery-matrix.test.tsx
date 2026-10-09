/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootMasteryMatrix } from "@/frontend/components/plaza/RootMasteryMatrix";

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));

vi.mock("@/frontend/api/client", () => ({
  apiFetch: apiFetchMock,
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

function renderMatrix(minCount = 3) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RootMasteryMatrix, { minCount }),
      ),
    );
  });
  return container;
}

const families = [
  { token: "port", slug: "root-port", total: 12, mastered: 2, learning: 1, meaning: "携带；搬运" },
  { token: "press", slug: "root-press", total: 5, mastered: 0, learning: 1, meaning: "压" },
  { token: "spect", slug: "root-spect", total: 9, mastered: 0, learning: 0, meaning: null },
];

describe("RootMasteryMatrix（P2-2 掌握矩阵）", () => {
  it("按 minCount 请求矩阵并按字母分组渲染状态格", async () => {
    apiFetchMock.mockResolvedValue({ available: true, total: 3, families });

    const container = renderMatrix(3);
    await act(async () => { /* flush 请求微任务 */ });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/plaza/roots/mastery-matrix?minCount=3",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const text = container.textContent ?? "";
    // 汇总：port 已掌握 / press 仅学习中 / spect 未开始
    expect(text).toContain("已掌握 1 族");
    expect(text).toContain("学习中 1 族");
    expect(text).toContain("未开始 1 族");

    // 字母分组
    const letters = Array.from(container.querySelectorAll("span"))
      .map((s) => s.textContent)
      .filter((t) => t === "P" || t === "S");
    expect(letters).toContain("P");
    expect(letters).toContain("S");

    // 三格链接与着色档位
    const links = Array.from(container.querySelectorAll("a")) as HTMLAnchorElement[];
    const portLink = links.find((a) => a.getAttribute("href") === "/plaza/root-port");
    const pressLink = links.find((a) => a.getAttribute("href") === "/plaza/root-press");
    const spectLink = links.find((a) => a.getAttribute("href") === "/plaza/root-spect");
    expect(portLink?.className).toContain("bg-[var(--color-accent-soft)]");
    expect(pressLink?.className).toContain("bg-[var(--color-rating-hard-bg)]");
    expect(spectLink?.className).toContain("bg-[var(--color-surface-glass)]");

    // tooltip 带分档数字与核心义（未命中不附加）
    expect(portLink?.getAttribute("title")).toContain("已掌握 2 · 学习中 1 · 未学 9");
    expect(portLink?.getAttribute("title")).toContain("携带；搬运");
    expect(spectLink?.getAttribute("title")).toContain("已掌握 0 · 学习中 0 · 未学 9");
    expect(spectLink?.getAttribute("title")).not.toContain("· 携带");
  });

  it("请求失败时渲染错误提示", async () => {
    apiFetchMock.mockRejectedValue(new Error("网络抖动"));

    const container = renderMatrix();
    await act(async () => { /* flush */ });

    expect(container.textContent).toContain("网络抖动");
  });

  it("minCount 变化触发重新请求", async () => {
    apiFetchMock.mockResolvedValue({ available: true, total: 0, families: [] });

    renderMatrix(3);
    await act(async () => { /* flush */ });
    const first = mounted[0];
    act(() => {
      first.root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(RootMasteryMatrix, { minCount: 10 }),
        ),
      );
    });
    await act(async () => { /* flush */ });

    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/plaza/roots/mastery-matrix?minCount=10",
      expect.anything(),
    );
  });
});
