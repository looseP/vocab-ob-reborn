/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 复习活动卡（批次 2 三合一）的组件行为锁。
 *
 * 锁住三件事：
 *   A. 过去侧视图切换：默认条带；切到「12 周」后是格网（84 个有效日格）；
 *   B. 最近会话：按日聚合、最多 5 行；点一行 = 看那天复习了哪些词（scope=reviewed）；
 *   C. 摘要数据失败不拖垮日历本体（只收起摘要块）。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 仓库无 @testing-library/react，按 review-calendar.test.tsx 惯例手动挂载。
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

import { apiFetch } from "@/frontend/api/client";
import {
  CALENDAR_PAST_GRID_SPAN,
  ReviewCalendar,
  SESSION_DIGEST_LIMIT,
  shiftDate,
} from "@/frontend/components/review/ReviewCalendar";

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

const TODAY = "2026-10-08";
const YESTERDAY = shiftDate(TODAY, -1);
const TOMORROW = shiftDate(TODAY, 1);

const CALENDAR = {
  past: [
    { date: YESTERDAY, reviewed: 4 },
    { date: TODAY, reviewed: 2 },
  ],
  today: { date: TODAY, dueNow: 14, reviewedToday: 2 },
  future: [
    { date: TODAY, due: 14 },
    { date: TOMORROW, due: 3 },
  ],
};

function timelineEntry(index: number, rating: string, dayOffset: number) {
  return {
    id: `rl-${index}`,
    rating,
    created_at: `${shiftDate(TODAY, dayOffset)}T01:00:00Z`, // 上海时间 09:00，日键 = 该天
    word_slug: `w${index}`,
    word_lemma: `w${index}`,
  };
}

const TIMELINE = {
  items: [
    timelineEntry(0, "good", 0),
    timelineEntry(1, "again", 0),
    timelineEntry(2, "hard", -1),
    timelineEntry(3, "easy", -2),
  ],
};

const DAY = {
  date: YESTERDAY,
  scope: "reviewed" as const,
  total: 1,
  items: [{ id: "w2", slug: "w2", title: "w2", lemma: "abide", shortDefinition: "遵守" }],
};

function settled(value: unknown): Promise<unknown> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

function wireApi(overrides: { calendar?: unknown; timeline?: unknown; day?: unknown } = {}): void {
  apiFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.startsWith("/review/stats/calendar")) return settled(overrides.calendar ?? CALENDAR);
    if (u.startsWith("/review/timeline")) return settled(overrides.timeline ?? TIMELINE);
    if (u.startsWith("/review/day")) return settled(overrides.day ?? DAY);
    return settled(new Error(`unexpected url: ${u}`));
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

async function click(target: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
    await Promise.resolve();
    await Promise.resolve();
  });
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
});

describe("复习活动 · 过去侧视图切换", () => {
  it("默认条带；切到 12 周格网后有效日格恰为 84", async () => {
    wireApi();
    await mount(createElement(ReviewCalendar));
    await waitFor(() => expect(screen.getByText(/今天待做\s*14/)).toBeTruthy());

    // 默认条带
    expect(document.querySelector('[data-testid="calendar-strip-past"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="calendar-past-grid"]')).toBeNull();

    await click(screen.getByRole("button", { name: /12 周/ }));
    const grid = document.querySelector('[data-testid="calendar-past-grid"]');
    expect(grid).toBeTruthy();
    expect(document.querySelector('[data-testid="calendar-strip-past"]')).toBeNull();
    expect(grid!.querySelectorAll("[data-date]")).toHaveLength(CALENDAR_PAST_GRID_SPAN);
    // 批次 3 视觉规范：月份标签（84 天窗口跨 7/8/9/10 月，末月必现）
    expect(screen.getByText("10月")).toBeTruthy();

    // 切回条带
    await click(screen.getByRole("button", { name: /30 天/ }));
    expect(document.querySelector('[data-testid="calendar-strip-past"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="calendar-past-grid"]')).toBeNull();
  });
});

describe("复习活动 · 最近会话", () => {
  it("按日聚合渲染（今天/昨天/前天），今天行标签为「今天」", async () => {
    wireApi();
    await mount(createElement(ReviewCalendar));
    await waitFor(() => expect(screen.getByTestId(`session-row-${TODAY}`)).toBeTruthy());

    expect(screen.getByTestId(`session-row-${YESTERDAY}`)).toBeTruthy();
    expect(screen.getByTestId(`session-row-${shiftDate(TODAY, -2)}`)).toBeTruthy();
    // 「今天」在条带刻度上也出现 → 在会话行内断言标签，避免歧义
    const todayRow = screen.getByTestId(`session-row-${TODAY}`);
    expect(todayRow.textContent).toContain("今天");
    expect(screen.getByTestId(`session-row-${YESTERDAY}`).textContent).toContain("昨天");
    // 今天 2 张（good + again 各 1）
    expect(todayRow.textContent).toContain("2 张");
    expect(todayRow.textContent).toContain("良好 1");
    expect(todayRow.textContent).toContain("重来 1");
  });

  it("点会话行 = 看那天复习了哪些词（scope=reviewed）", async () => {
    wireApi();
    await mount(createElement(ReviewCalendar));
    await waitFor(() => expect(screen.getByTestId(`session-row-${YESTERDAY}`)).toBeTruthy());

    await click(screen.getByTestId(`session-row-${YESTERDAY}`));
    await waitFor(() => expect(screen.getByText("abide")).toBeTruthy());

    const calls = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.startsWith(`/review/day?date=${YESTERDAY}&scope=reviewed`))).toBe(true);
  });

  it(`更早的日子被截断：最多 ${SESSION_DIGEST_LIMIT} 行（不随复习天数堆积）`, async () => {
    wireApi({
      timeline: {
        items: Array.from({ length: SESSION_DIGEST_LIMIT + 3 }, (_, index) =>
          timelineEntry(index, "good", -index)),
      },
    });
    await mount(createElement(ReviewCalendar));
    await waitFor(() => expect(screen.getByTestId(`session-row-${TODAY}`)).toBeTruthy());

    const rows = document.querySelectorAll('[data-testid^="session-row-"]');
    expect(rows).toHaveLength(SESSION_DIGEST_LIMIT);
  });

  it("摘要数据失败只收起摘要块，日历本体照常渲染", async () => {
    wireApi({ timeline: new Error("timeline down") });
    await mount(createElement(ReviewCalendar));
    await waitFor(() => expect(screen.getByText(/今天待做\s*14/)).toBeTruthy());

    expect(document.querySelector('[data-testid="calendar-strip-past"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-testid^="session-row-"]')).toHaveLength(0);
  });
});
