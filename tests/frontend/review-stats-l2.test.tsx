/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * L1 速刷统计卡内的 L2 条件块（批次 2）。
 *
 * 背景：原「更多统计」整组 4 卡删除后，L2 三个数字并入本卡尾部条件块。
 * 锁住的规矩：
 *  - 未启用（无 prop / null / 四项全 0）→ 整块不渲染（不出现「L2 轨道」标题）；
 *  - 任一数字非 0 → 渲染三格（已晋升 / 待辨析 / 今日复习），数字直出。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

import { apiFetch } from "@/frontend/api/client";
import { ReviewStatsPanel } from "@/frontend/components/review/ReviewStatsPanel";

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

const STATS = {
  todayCount: 1,
  totalCount: 10,
  ratingDist: { again: 1, hard: 0, good: 8, easy: 1 },
};

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(element);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.startsWith("/review/stats")) return Promise.resolve(STATS);
    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
});

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

describe("ReviewStatsPanel · L2 条件块", () => {
  it("无 prop（默认参数）→ 渲染基础卡且不出现 L2 块", async () => {
    await mount(createElement(ReviewStatsPanel));
    await waitFor(() => expect(screen.getByText("L1 累计复习")).toBeTruthy());
    expect(screen.queryByText("L2 轨道")).toBeNull();
    expect(document.querySelector('[data-testid="l2-track-group"]')).toBeNull();
  });

  it("四项全 0（L2 轨未启用）→ 整块不渲染", async () => {
    await mount(createElement(ReviewStatsPanel, {
      l2: { promoted: 0, dueNow: 0, weakSignal: 0, reviewedToday: 0 },
    }));
    await waitFor(() => expect(screen.getByText("L1 累计复习")).toBeTruthy());
    expect(document.querySelector('[data-testid="l2-track-group"]')).toBeNull();
  });

  it("任一数字非 0 → 渲染三格与数字", async () => {
    await mount(createElement(ReviewStatsPanel, {
      l2: { promoted: 3, dueNow: 1, weakSignal: 0, reviewedToday: 2 },
    }));
    await waitFor(() => expect(screen.getByTestId("l2-track-group")).toBeTruthy());
    expect(screen.getByText("L2 轨道")).toBeTruthy();
    expect(screen.getByText("已晋升")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("待辨析")).toBeTruthy();
    expect(screen.getByText("今日复习")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});
