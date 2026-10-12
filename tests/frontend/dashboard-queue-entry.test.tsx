/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 仪表盘「今日待复习（到期）」统计卡的**入口**回归锁（2026-10-12）。
 *
 * 修的是「只有数字、没有去处」：卡上写着 2，但没人告诉你这 2 张是哪两个词
 * —— 队列全景页（/review-queue）早就有了，缺的是一条从数字到清单的路。
 * 锁住的规矩：
 *   1. 有去处的卡整卡可点，且用真链接（键盘可达 / 可中键新开 / 读屏能念）；
 *   2. 去处就是复习队列；
 *   3. **没有去处的卡不许变成链接**（今日已复习没有对应清单，别给假入口）；
 *   4. 两个数字口径不同（上海日历日 vs 此刻已到期），差异写在悬停提示里，
 *      点进去之前就知道数字可能变。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 仓库无 @testing-library/react，按 tests/frontend/one-click-forgetting.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/frontend/api/client";
import { DashboardPage } from "@/frontend/pages/DashboardPage";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

const DASHBOARD_STATS = {
  totalWords: 10,
  trackedWords: 8,
  masteredWords: 3,
  dueToday: 2,
  reviewedToday: 1,
  reviewed7d: 5,
  reviewed30d: 9,
  streakDays: 3,
  notesCount: 0,
  forecast: { dueNow: 1, due7d: 4, due14d: 6 },
  l2: { promoted: 2, dueNow: 1, weakSignal: 0, reviewedToday: 1 },
};

const BOOK = { id: "11111111-1111-4111-8111-111111111111", name: "默认词书", description: null, isDefault: true };

/** 仪表盘自身三个数据源 + 各子面板的最小成对载荷（只关心卡片，不关心面板细节）。 */
function wireDashboardApi(): void {
  apiFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.startsWith("/review/queue")) {
      return Promise.resolve({ stats: { total: 2, remaining: 2 }, session: { cardsSeen: 0 }, items: [] });
    }
    if (u.startsWith("/review/stats/dashboard")) return Promise.resolve(DASHBOARD_STATS);
    if (u.startsWith("/notes?limit=")) return Promise.resolve({ items: [], total: 0 });
    if (u.startsWith("/review/stats")) {
      return Promise.resolve({ todayCount: 0, totalCount: 0, ratingDist: { again: 0, hard: 0, good: 0, easy: 0 } });
    }
    if (u.startsWith("/review/leeches")) return Promise.resolve({ items: [] });
    if (u.startsWith("/review/timeline")) return Promise.resolve({ items: [] });
    if (u.startsWith("/review/heatmap")) return Promise.resolve({ items: [] });
    if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
}

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

async function mountDashboard(): Promise<void> {
  await mount(createElement(MemoryRouter, null, createElement(DashboardPage)));
  await waitFor(() => expect(screen.getByRole("link", { name: /今日待复习/ })).toBeTruthy());
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("仪表盘「今日待复习」卡：数字 → 清单的入口", () => {
  it("整卡是链接，指向复习队列（键盘可达、可中键新开）", async () => {
    wireDashboardApi();
    await mountDashboard();

    const entry = screen.getByRole("link", { name: /今日待复习/ });
    expect(entry.getAttribute("href")).toBe("/review-queue");
    // 数字仍要在卡上（入口是加成，不是替换）
    expect(screen.getByText("今日待复习（到期）")).toBeTruthy();
  });

  it("口径差异写在悬停提示里：点进去之前就知道数字可能变", async () => {
    wireDashboardApi();
    await mountDashboard();

    const hint = screen.getByRole("link", { name: /今日待复习/ }).getAttribute("title") ?? "";
    expect(hint).toContain("此刻已到期");
    expect(hint).toContain("具体是哪些词");
  });

  it("没有对应清单的卡不变成链接（今日已复习给假入口会骗人）", async () => {
    wireDashboardApi();
    await mountDashboard();

    expect(screen.getByText("今日已复习")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /今日已复习/ })).toBeNull();
  });
});
