/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 仪表盘行动区「现在待复习」卡的**入口 + 口径**回归锁（2026-10-12）。
 *
 * 修的两件事：
 *   ① 只有数字、没有去处 —— 卡上写着 1，但没人告诉你这 1 张是哪个词；
 *   ② 大数字用错了口径 —— 实测：卡上「今日待复习 1」而队列「到期 0」、「开始复习
 *      暂无待复习卡片」，同一块屏幕上两个数互相打脸，用户第一反应是「调度坏了」。
 *      查库确认调度没问题：那张卡 `state='review'`、`due_at` 就是今天 15:43（上海），
 *      是**此刻还没到点**，不是排错了。
 *      `dashboard-queue-headline.test.tsx` 早就锁死同一条规矩：**卡上的数必须是
 *      点进去看到的那个数**。故大数字改为队列 `stats.total`（此刻就会发出的卡数），
 *      日历日口径退为副标题，且只在与大数字不一致时出现。
 *
 * 锁住的规矩：
 *   1. 整卡可点，且用真链接（键盘可达 / 可中键新开 / 读屏能念）；
 *   2. 去处就是复习队列，大数字 = 队列口径（此刻到期 + 配额内新卡）；
 *   3. 两个口径不一致时，副标题把日历日那个数说在明处（不藏着）；
 *   4. 两个口径一致时不出副标题（一致还并列是噪音）；
 *   5. 没有对应清单的卡不许变成链接（今日已复习）；
 *   6. 今天有到期卡 ⇒ 落到「今日到期」facet 视图（副标题那个数的**清单**，L2 补）；
 *      今天一张都没有 ⇒ 落默认队列视图，否则点进去是一片空。
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
  dueToday: 1,
  reviewedToday: 1,
  reviewed7d: 5,
  reviewed30d: 9,
  streakDays: 3,
  notesCount: 0,
  forecast: { dueNow: 1, due7d: 4, due14d: 6 },
  l2: { promoted: 2, dueNow: 1, weakSignal: 0, reviewedToday: 1 },
};

const BOOK = { id: "11111111-1111-4111-8111-111111111111", name: "默认词书", description: null, isDefault: true };

/** 仪表盘自身数据源 + 各子面板的最小成对载荷（只关心行动区那张卡）。 */
function wireDashboardApi(options: { queueTotal: number; dueToday: number }): void {
  apiFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.startsWith("/review/queue")) {
      // 会话队列口径：此刻就会发出的卡数（到期 + 配额内的新卡）
      return Promise.resolve({
        stats: { total: options.queueTotal, remaining: options.queueTotal },
        session: { cardsSeen: 0 },
        items: [],
      });
    }
    if (u.startsWith("/review/stats/dashboard")) {
      return Promise.resolve({ ...DASHBOARD_STATS, dueToday: options.dueToday });
    }
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

async function mountDashboard(options: { queueTotal: number; dueToday: number }): Promise<void> {
  wireDashboardApi(options);
  await mount(createElement(MemoryRouter, null, createElement(DashboardPage)));
  await waitFor(() => expect(screen.getByRole("link", { name: /现在待复习/ })).toBeTruthy());
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

describe("仪表盘「现在待复习」卡：数字 → 清单的入口", () => {
  it("整卡是链接，今天有到期卡时落到「今日到期」视图（副标题那个数的清单）", async () => {
    await mountDashboard({ queueTotal: 0, dueToday: 1 });

    const entry = screen.getByRole("link", { name: /现在待复习/ });
    // L2（2026-10-12）：副标题「今日共 N 张到期」从此有清单 —— 深链到 facet 视图。
    // 此前那个数点进去只能看到「到期 0」，用户以为调度坏了。
    expect(entry.getAttribute("href")).toBe("/review-queue?dueWindow=today");
    // 数字仍要在卡上（入口是加成，不是替换）
    expect(screen.getByText("现在待复习")).toBeTruthy();
  });

  it("今天一张到期卡都没有时落默认队列视图（否则点进去是一片空）", async () => {
    await mountDashboard({ queueTotal: 0, dueToday: 0 });

    expect(screen.getByRole("link", { name: /现在待复习/ }).getAttribute("href")).toBe("/review-queue");
    // 没有到期卡 ⇒ 不出副标题（一致还并列是噪音）
    expect(screen.queryByText(/今日共/)).toBeNull();
  });

  it("大数字是「点进去看到的那个数」：队列口径，不是日历日口径", async () => {
    // 复现实测场景：日历日到期 1 张（今天 15:43 才到点），此刻可复习 0 张
    await mountDashboard({ queueTotal: 0, dueToday: 1 });

    const entry = screen.getByRole("link", { name: /现在待复习/ });
    expect(entry.querySelector("p.text-2xl")?.textContent).toBe("0");
    // 日历日那个数以副标题存在，不抢大数字的位置
    expect(screen.getByText("今日共 1 张到期")).toBeTruthy();
    // 「开始复习」卡与它同数（队列文案走同一个 stats.total）
    expect(screen.getByText("暂无待复习卡片")).toBeTruthy();
  });

  it("口径不一致时副标题把日历日那个数说在明处", async () => {
    await mountDashboard({ queueTotal: 0, dueToday: 1 });

    expect(screen.getByText("今日共 1 张到期")).toBeTruthy();
  });

  it("口径一致时不出副标题（一致还并列是噪音）", async () => {
    await mountDashboard({ queueTotal: 1, dueToday: 1 });

    expect(screen.queryByText(/今日共/)).toBeNull();
  });

  it("口径差异写在悬停提示里：两个口径是什么、点开落在哪", async () => {
    await mountDashboard({ queueTotal: 0, dueToday: 1 });

    const hint = screen.getByRole("link", { name: /现在待复习/ }).getAttribute("title") ?? "";
    expect(hint).toContain("此刻已到期");
    expect(hint).toContain("日历日");
    // 落点说清楚：副标题那个数的清单 = 「今日到期」视图，且含此刻还没到点的卡
    expect(hint).toContain("今日到期");
    expect(hint).toContain("此刻还没到点");
    expect(hint).toContain("点开看具体是哪些词");
  });

  it("没有对应清单的卡不变成链接（今日已复习给假入口会骗人）", async () => {
    await mountDashboard({ queueTotal: 0, dueToday: 1 });

    expect(screen.getByText("今日已复习")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /今日已复习/ })).toBeNull();
  });
});
