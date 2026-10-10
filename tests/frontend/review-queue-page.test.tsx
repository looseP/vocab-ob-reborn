/// <reference lib="dom" />
// @vitest-environment jsdom

// 复习队列全景页（P1，2026-10-10）测试。
// 仓库无 @testing-library/react ⇒ 按 review-calendar.test.tsx 惯例用 createRoot + act。
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

import { apiFetch } from "@/frontend/api/client";
import {
  ReviewQueuePage,
  bucketTabCount,
  emptyHint,
  formatDueLabel,
} from "@/frontend/pages/ReviewQueuePage";

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

const COUNTS = { due: 2, learning: 1, review: 5, new: 8, suspended: 3, dueNow: 3, total: 16 };

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    wordId: "w-1",
    slug: "abandon",
    title: "abandon",
    lemma: "abandon",
    shortDefinition: "放弃",
    pos: "v",
    cefr: "B2",
    state: "review" as const,
    dueAt: "2020-01-01T00:00:00.000Z",
    reviewCount: 4,
    lapseCount: 1,
    stability: 12.5,
    intervalDays: 9,
    lastReviewedAt: "2026-09-30T08:00:00.000Z",
    lastRating: "good" as const,
    needsRecheck: false,
    ...overrides,
  };
}

const LIST = {
  counts: COUNTS,
  items: [makeItem(), makeItem({ wordId: "w-2", slug: "suspend-me", lemma: "suspend-me", state: "suspended", dueAt: null })],
  total: 16,
  limit: 50,
  offset: 0,
  hasMore: false,
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

function renderPage(): Promise<void> {
  return mount(createElement(MemoryRouter, null, createElement(ReviewQueuePage)));
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

describe("formatDueLabel（距到期，而非距上次复习）", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");

  it("未安排 / 已到期", () => {
    expect(formatDueLabel(null, now)).toBe("未安排");
    expect(formatDueLabel("2020-01-01T00:00:00.000Z", now)).toBe("已到期");
  });

  it("分钟 / 小时 / 天 / 远期日期", () => {
    expect(formatDueLabel("2026-10-10T12:30:00.000Z", now)).toBe("30 分钟后");
    expect(formatDueLabel("2026-10-10T18:00:00.000Z", now)).toBe("6 小时后");
    expect(formatDueLabel("2026-10-13T12:00:00.000Z", now)).toBe("3 天后");
    expect(formatDueLabel("2027-03-01T12:00:00.000Z", now)).toBe(
      new Date("2027-03-01T12:00:00.000Z").toLocaleDateString("zh-CN"),
    );
  });
});

describe("bucketTabCount / emptyHint", () => {
  it("每个桶取各自的计数，all 取总数", () => {
    expect(bucketTabCount("due", COUNTS)).toBe(2);
    expect(bucketTabCount("learning", COUNTS)).toBe(1);
    expect(bucketTabCount("new", COUNTS)).toBe(8);
    expect(bucketTabCount("suspended", COUNTS)).toBe(3);
    expect(bucketTabCount("all", COUNTS)).toBe(16);
    expect(bucketTabCount("due", null)).toBe(0);
  });

  it("搜索无结果与桶为空给不同出路", () => {
    expect(emptyHint("due", true)).toContain("关键词");
    expect(emptyHint("due", false)).toContain("没有已到期");
    expect(emptyHint("new", false)).toContain("新卡");
  });
});

describe("ReviewQueuePage（组件）", () => {
  it("渲染总量卡、桶徽标与清单行；挂起行不给「提前到期」", async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(LIST));
    await renderPage();

    // 总量卡：现在就该复习 / 待学新卡 / 已挂起
    expect(screen.getByText("现在就该复习")).toBeTruthy();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0); // dueNow=3 与挂起桶 3
    expect(screen.getAllByText("8").length).toBeGreaterThan(0); // 待学新卡（卡片 + tab 徽标）
    // 清单：两个词条都在
    expect(screen.getByText("abandon")).toBeTruthy();
    expect(screen.getByText("suspend-me")).toBeTruthy();
    // 「提前到期」只给非挂起行 ⇒ 全页仅 1 个
    expect(screen.getAllByText("提前到期")).toHaveLength(1);
    // 排队请求落在 due 桶默认页
    expect(String(apiFetchMock.mock.calls[0][0])).toContain("/api/review/queue/list?bucket=due");
  });

  it("切桶后用新 bucket 重新拉取", async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(LIST));
    await renderPage();

    await act(async () => {
      // 用 role 定位 tab（按钮名含计数，如「已挂起3」）；行内状态徽标文字相同但不可点
      fireEvent.click(screen.getByRole("button", { name: /^已挂起/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("bucket=suspended"))).toBe(true);
    });
  });

  it("搜索输入防抖后才带 q 请求（输入过程不打后端）", async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(LIST));
    await renderPage();
    const callsBefore = apiFetchMock.mock.calls.length;

    const input = screen.getByLabelText("搜索队列中的词条");
    await act(async () => {
      fireEvent.change(input, { target: { value: "ab" } });
      await Promise.resolve();
    });
    // 防抖窗口内：没有新请求
    expect(apiFetchMock.mock.calls.length).toBe(callsBefore);

    await waitFor(
      () => {
        expect(
          apiFetchMock.mock.calls.some(([url]) => String(url).includes("q=ab")),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("「提前到期」→ POST 该词并回源刷新桶计数", async () => {
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/cards/expire")) return Promise.resolve({ ok: true, count: 1, wordIds: ["w-1"] });
      return Promise.resolve(LIST);
    });
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByText("提前到期"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const expireCall = apiFetchMock.mock.calls.find(([url]) => String(url).includes("/cards/expire"));
    expect(expireCall).toBeTruthy();
    expect(JSON.parse(expireCall![1].body)).toEqual({ wordIds: ["w-1"] });
    // 操作后必须回源计数（tab 徽标唯一来源）
    await waitFor(() => {
      const listCalls = apiFetchMock.mock.calls.filter(([url]) => String(url).includes("/queue/list"));
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("「移出」先弹确认框，确认后才发请求", async () => {
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/cards/remove")) return Promise.resolve({ ok: true, count: 1, wordIds: ["w-1"] });
      return Promise.resolve(LIST);
    });
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getAllByText("移出")[0]);
      await Promise.resolve();
    });
    // 弹窗出现，但尚未发请求
    expect(screen.getByText("移出复习队列")).toBeTruthy();
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("/cards/remove"))).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByText("确认移出"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const removeCall = apiFetchMock.mock.calls.find(([url]) => String(url).includes("/cards/remove"));
    expect(removeCall).toBeTruthy();
    expect(JSON.parse(removeCall![1].body)).toEqual({ wordIds: ["w-1"] });
  });
});
