/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 仓库无 @testing-library/react，按 one-click-forgetting.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

import { apiFetch } from "@/frontend/api/client";
import {
  CALENDAR_SPAN,
  ReviewCalendar,
  buildSeries,
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
    { date: shiftDate(TODAY, 5), due: 7 },
  ],
};

const DAY = {
  date: TOMORROW,
  scope: "due" as const,
  total: 2,
  items: [
    { id: "w1", slug: "abide", title: "abide", lemma: "abide", shortDefinition: "遵守" },
    { id: "w2", slug: "ample", title: "ample", lemma: "ample", shortDefinition: null },
  ],
};

/** 把「值」归一为 promise：Error 实例 → 拒绝，否则解析。 */
function settled(value: unknown): Promise<unknown> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

function wireApi(overrides: { calendar?: unknown; day?: unknown } = {}): void {
  apiFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.startsWith("/review/stats/calendar")) return settled(overrides.calendar ?? CALENDAR);
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
});

describe("shiftDate（按 UTC 算术，不受本地时区影响）", () => {
  it("普通加减", () => {
    expect(shiftDate("2026-10-08", 1)).toBe("2026-10-09");
    expect(shiftDate("2026-10-08", -1)).toBe("2026-10-07");
  });

  it("跨月 / 跨年 / 闰年二月", () => {
    expect(shiftDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29"); // 闰年
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("buildSeries（补零成连续日序列）", () => {
  const values = new Map([["2026-10-06", 4], ["2026-10-08", 2]]);

  it("过去窗口：从 today-(span-1) 到 today，缺桶补 0", () => {
    const series = buildSeries("2026-10-08", 3, (i) => i - 2, values);
    expect(series).toEqual([
      { date: "2026-10-06", value: 4 },
      { date: "2026-10-07", value: 0 }, // 该日无活动 → 0，而不是"这天不存在"
      { date: "2026-10-08", value: 2 },
    ]);
  });

  it("未来窗口：从明天起 span 天（今天已在过去窗口/徽标里，不重复画）", () => {
    const series = buildSeries("2026-10-08", 3, (i) => i + 1, values);
    expect(series.map((d) => d.date)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(series.every((d) => d.value === 0)).toBe(true);
  });

  it("长度恒等于 span（画出来的柱子数不随数据量变化）", () => {
    expect(buildSeries("2026-10-08", CALENDAR_SPAN, (i) => i - (CALENDAR_SPAN - 1), values)).toHaveLength(CALENDAR_SPAN);
    expect(buildSeries("2026-10-08", CALENDAR_SPAN, (i) => i + 1, new Map())).toHaveLength(CALENDAR_SPAN);
  });
});

describe("ReviewCalendar（组件）", () => {
  it("渲染两条 30 天条带（缺桶补零）与今天双值徽标", async () => {
    wireApi();
    await mount(createElement(ReviewCalendar));

    await waitFor(() => expect(screen.getByText(/今天待做\s*14/)).toBeTruthy());
    expect(screen.getByText(/今天已复习\s*2/)).toBeTruthy();

    const pastCells = document.querySelectorAll('[data-testid="calendar-strip-past"] [data-date]');
    const futureCells = document.querySelectorAll('[data-testid="calendar-strip-future"] [data-date]');
    expect(pastCells).toHaveLength(CALENDAR_SPAN);
    expect(futureCells).toHaveLength(CALENDAR_SPAN);
    // 补零：未来侧只有 2 天有桶，其余 28 天必须是 0（空白日不消失）
    const zeroCells = Array.from(futureCells).filter((cell) => cell.getAttribute("data-value") === "0");
    expect(zeroCells).toHaveLength(CALENDAR_SPAN - 2);
    // 今天那格必须有桶（积压并入今天）
    expect(
      Array.from(pastCells).some((cell) => cell.getAttribute("data-date") === TODAY && cell.getAttribute("data-value") === "2"),
    ).toBe(true);
  });

  it("点未来条带 → 取单日词表（scope=due、date=明天）并列出词条", async () => {
    wireApi();
    await mount(createElement(ReviewCalendar));
    await waitFor(() => expect(screen.getByText(/今天待做\s*14/)).toBeTruthy());

    const futureStrip = document.querySelector('[data-testid="calendar-strip-future"]');
    expect(futureStrip).toBeTruthy();
    await click(futureStrip as Element);

    await waitFor(() => expect(screen.getByText("abide")).toBeTruthy());
    expect(screen.getByText(/共 2 张/)).toBeTruthy();
    const calls = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.startsWith(`/review/day?date=${TOMORROW}&scope=due`))).toBe(true);
  });

  it("载荷不合契约形状 → fail-closed 显示失败态，绝不白屏", async () => {
    // 模拟"未知端点被测试桩回了个残缺对象"：today 缺失
    wireApi({ calendar: { past: [], future: [] } });
    await mount(createElement(ReviewCalendar));

    await waitFor(() => expect(screen.getByText("日历加载失败，稍后重试。")).toBeTruthy());
    expect(document.querySelector('[data-testid="calendar-strip-past"]')).toBeNull();
  });

  it("请求失败 → 同样进失败态（不抛出、不白屏）", async () => {
    wireApi({ calendar: new Error("network down") });
    await mount(createElement(ReviewCalendar));

    await waitFor(() => expect(screen.getByText("日历加载失败，稍后重试。")).toBeTruthy());
  });
});
