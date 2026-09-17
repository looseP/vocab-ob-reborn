/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 仓库无 @testing-library/react，按 tests/frontend/l3-reading-view.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { OneClickForgettingCard } from "@/frontend/components/forgetting/OneClickForgettingCard";
import { DashboardPage } from "@/frontend/pages/DashboardPage";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

const BOOK = { id: "11111111-1111-4111-8111-111111111111", name: "默认词书", description: null, isDefault: true };
const ANCHOR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANCHOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREVIEW = { anchors: [ANCHOR_A, ANCHOR_B], suspendCount: 12 };
const APPLY = { batchId: "batch-1", suspendedCount: 12, pausedCount: 3, anchors: [ANCHOR_A, ANCHOR_B] };
const RESTORE = { restoredCount: 12, unpausedCount: 3 };
const DASHBOARD_STATS = {
  totalWords: 10,
  trackedWords: 8,
  dueToday: 2,
  reviewedToday: 1,
  reviewed7d: 5,
  reviewed30d: 9,
  streakDays: 3,
  notesCount: 0,
  forecast: { dueNow: 1, due7d: 4, due14d: 6 },
  l2: { promoted: 2, dueNow: 1, weakSignal: 0, reviewedToday: 1 },
};

function wordsPage(offset = 0) {
  const items = [
    { id: ANCHOR_A, lemma: "alpha", title: "alpha" },
    { id: ANCHOR_B, lemma: "beta", title: "beta" },
  ];
  return { items, total: 2, limit: 100, offset, hasMore: false };
}

/** 把「值」归一为 promise：Error 实例 → 拒绝（模拟失败），否则解析。 */
function settled(value: unknown): Promise<unknown> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

/** 组件级用例的默认 mock：按 URL 路由；未知 URL 直接拒绝（暴露越界调用）。 */
function wireApi(overrides: { defaultBook?: unknown; preview?: unknown; apply?: unknown; restore?: unknown } = {}): void {
  apiFetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes("/wordbooks/default")) return settled(overrides.defaultBook ?? BOOK);
    if (u.includes("/forgetting/preview")) return settled(overrides.preview ?? PREVIEW);
    if (u === "/forgetting/apply") return settled(overrides.apply ?? APPLY);
    if (u === "/forgetting/restore") return settled(overrides.restore ?? RESTORE);
    if (u.startsWith("/words?wordbookId=")) return settled(wordsPage());
    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
}

function callsTo(matcher: string): Array<[string, RequestInit | undefined]> {
  return apiFetchMock.mock.calls
    .filter(([url]) => String(url) === matcher || String(url).startsWith(matcher))
    .map(([url, init]) => [String(url), init as RequestInit | undefined]);
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

async function mountCard(): Promise<void> {
  await mount(createElement(OneClickForgettingCard));
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const entryButton = () => screen.getByRole("button", { name: "一键遗忘" });
const confirmButton = () => screen.getByRole("button", { name: "确认应用" });
const restoreButton = () => screen.getByRole("button", { name: "撤销本次遗忘" });
const modalHeading = () => screen.getByRole("heading", { name: "一键遗忘（重置本书进度）" });

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

describe("OneClickForgettingCard · 确认流", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("previews, shows anchors/count/placeholder/book, and applies the full default selection", async () => {
    wireApi();
    await mountCard();
    await click(entryButton());

    await waitFor(() => expect(modalHeading()).toBeTruthy());
    // 默认词书只取一次（挂载预取），preview 以 bookId 为 query
    expect(callsTo("/wordbooks/default")).toHaveLength(1);
    expect(callsTo("/forgetting/preview")[0]?.[0]).toBe(`/forgetting/preview?bookId=${BOOK.id}`);
    // 破坏性计数醒目 + 目标词书 + 锚点词面 + agent 叙事占位槽（静态，不承诺）
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("目标词书：《默认词书》")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("（预留：将在此展示 agent 叙事解读）")).toBeTruthy();

    await click(confirmButton());
    await waitFor(() => expect(restoreButton()).toBeTruthy());
    // 默认全选 → 提交清单 = 当次 preview 的完整锚点集
    const applyCall = callsTo("/forgetting/apply")[0];
    expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual({
      bookId: BOOK.id,
      confirmedAnchorIds: [ANCHOR_A, ANCHOR_B],
    });
    // apply 成功后弹窗关闭，展示执行结果
    expect(screen.queryByRole("heading", { name: "一键遗忘（重置本书进度）" })).toBeNull();
    expect(screen.getByText("已应用一键遗忘", { exact: false })).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("unchecking an anchor raises the impact count and submits only the confirmed subset", async () => {
    wireApi();
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());

    // 取消勾选 beta → 该词回到挂起集，计数 12 → 13；再勾选回来可复原
    await click(screen.getByRole("checkbox", { name: "beta" }));
    expect(screen.getByText("13")).toBeTruthy();
    expect(screen.queryByText("12")).toBeNull();
    await click(screen.getByRole("checkbox", { name: "beta" }));
    expect(screen.getByText("12")).toBeTruthy();
    await click(screen.getByRole("checkbox", { name: "beta" }));

    await click(confirmButton());
    await waitFor(() => expect(callsTo("/forgetting/apply")).toHaveLength(1));
    expect(JSON.parse(String(callsTo("/forgetting/apply")[0]?.[1]?.body))).toEqual({
      bookId: BOOK.id,
      confirmedAnchorIds: [ANCHOR_A],
    });
    // 提交发生在 preview 之后，且全程只提交一次
    const urls = apiFetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.findIndex((u) => u.startsWith("/forgetting/preview"))).toBeLessThan(urls.indexOf("/forgetting/apply"));
  });

  it("offers no apply path when the preview fails", async () => {
    wireApi({ preview: new Error("preview down") });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(screen.getByText("无法加载一键遗忘预览，请重试")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "确认应用" })).toBeNull();
    expect(callsTo("/forgetting/apply")).toHaveLength(0);
  });

  it("keeps no restore entry before a batch exists and runs a one-shot restore after apply", async () => {
    wireApi();
    await mountCard();
    expect(screen.queryByRole("button", { name: "撤销本次遗忘" })).toBeNull();

    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());
    expect(screen.queryByRole("button", { name: "撤销本次遗忘" })).toBeNull();

    await click(confirmButton());
    await waitFor(() => expect(restoreButton()).toBeTruthy());
    await click(restoreButton());
    await waitFor(() => expect(screen.queryByRole("button", { name: "撤销本次遗忘" })).toBeNull());

    const restoreCall = callsTo("/forgetting/restore")[0];
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toEqual({ bookId: BOOK.id, batchId: "batch-1" });
    expect(screen.getByText("已撤销本次遗忘", { exact: false })).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("retries the default-book fetch after a failure and never previews without a book", async () => {
    wireApi({ defaultBook: new Error("book down") });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(screen.getByText("无法加载一键遗忘预览，请重试")).toBeTruthy());
    expect(callsTo("/forgetting/preview")).toHaveLength(0);

    // 失败不缓存：再次点按重试；这次默认词书可用 → 进入确认流
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
      if (u.includes("/forgetting/preview")) return Promise.resolve(PREVIEW);
      if (u.startsWith("/words?wordbookId=")) return Promise.resolve(wordsPage());
      return Promise.reject(new Error(`unexpected url: ${u}`));
    });
    await click(entryButton());
    await waitFor(() => expect(modalHeading()).toBeTruthy());
    expect(callsTo("/forgetting/preview")).toHaveLength(1);
  });

  it("re-previews in place when apply reports a stale preview (422)", async () => {
    wireApi({ apply: new BrowserApiError(422, { message: "preview 已过期，请重新 preview" }) });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());

    await click(confirmButton());
    await waitFor(() => expect(screen.getByText("预览已过期，锚点清单可能已变化。请重新预览后再确认。")).toBeTruthy());
    expect(confirmButton()).toBeTruthy(); // 弹窗保持打开，不静默吞错

    await click(screen.getByRole("button", { name: "重新预览" }));
    await waitFor(() => expect(callsTo("/forgetting/preview")).toHaveLength(2));
    expect(screen.queryByText("预览已过期，锚点清单可能已变化。请重新预览后再确认。")).toBeNull();
    expect(screen.getByText("12")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "beta" }) as HTMLInputElement).checked).toBe(true);
  });

  it("falls back to id shorthand when anchor labels cannot be resolved", async () => {
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
      if (u.includes("/forgetting/preview")) return Promise.resolve(PREVIEW);
      if (u.startsWith("/words?wordbookId=")) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0, hasMore: false });
      return Promise.reject(new Error(`unexpected url: ${u}`));
    });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(modalHeading()).toBeTruthy());
    await waitFor(() => expect(screen.getByText("#aaaaaaaa")).toBeTruthy());
    expect(screen.getByText("#bbbbbbbb")).toBeTruthy();
    expect(screen.getByText("部分锚点词面暂不可用（显示为编号缩写，不影响操作）。")).toBeTruthy();
    // 词面解析按书限定分页
    const wordsCall = callsTo("/words?wordbookId=")[0];
    expect(wordsCall?.[0]).toContain(`wordbookId=${BOOK.id}`);
    expect(wordsCall?.[0]).toContain("review=tracked");
    expect(wordsCall?.[0]).toContain("limit=100");
  });

  it("walks result pages of the words lookup until the anchors are resolved", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: `filler-${String(i).padStart(3, "0")}`,
      lemma: `filler${i}`,
      title: `filler${i}`,
    }));
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
      if (u.includes("/forgetting/preview")) return Promise.resolve(PREVIEW);
      if (u.includes("offset=100")) {
        return Promise.resolve({
          items: [
            { id: ANCHOR_A, lemma: "alpha", title: "alpha" },
            { id: ANCHOR_B, lemma: "beta", title: "beta" },
          ],
          total: 102,
          limit: 100,
          offset: 100,
          hasMore: false,
        });
      }
      if (u.startsWith("/words?wordbookId=")) return Promise.resolve({ items: filler, total: 102, limit: 100, offset: 0, hasMore: true });
      return Promise.reject(new Error(`unexpected url: ${u}`));
    });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(screen.getByText("beta")).toBeTruthy();
    expect(callsTo("/words?wordbookId=")).toHaveLength(2);
    expect(callsTo("/words?wordbookId=")[1]?.[0]).toContain("offset=100");
  });

  it("fetches the default wordbook once and re-previews on every confirmation entry", async () => {
    wireApi();
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());
    await click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("button", { name: "确认应用" })).toBeNull();

    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());
    expect(callsTo("/wordbooks/default")).toHaveLength(1);
    expect(callsTo("/forgetting/preview")).toHaveLength(2);
  });

  it("keeps the modal open with an error when apply fails for a non-stale reason", async () => {
    wireApi({ apply: new Error("network down") });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());
    await click(confirmButton());
    await waitFor(() => expect(screen.getByText("应用失败，请重试")).toBeTruthy());
    expect(confirmButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新预览" })).toBeNull();
    expect(screen.queryByRole("button", { name: "撤销本次遗忘" })).toBeNull();
  });

  it("surfaces the entry on the dashboard and opens the confirm flow from there", async () => {
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
      if (u.includes("/forgetting/preview")) return Promise.resolve(PREVIEW);
      if (u.startsWith("/words?wordbookId=")) return Promise.resolve(wordsPage());
      if (u.startsWith("/review/queue")) return Promise.resolve({ stats: { total: 0, remaining: 0 }, session: { cardsSeen: 0 } });
      if (u.startsWith("/words?limit=1")) return Promise.resolve({ total: 0 });
      if (u.startsWith("/review/stats/dashboard")) return Promise.resolve(DASHBOARD_STATS);
      if (u.startsWith("/review/stats")) return Promise.resolve({ todayCount: 0, totalCount: 0, ratingDist: { again: 0, hard: 0, good: 0, easy: 0 } });
      if (u.startsWith("/review/leeches")) return Promise.resolve({ items: [] });
      if (u.startsWith("/review/timeline")) return Promise.resolve({ items: [] });
      if (u.startsWith("/review/heatmap")) return Promise.resolve({ items: [] });
      return Promise.reject(new Error(`unexpected url: ${u}`));
    });
    await mount(createElement(MemoryRouter, null, createElement(DashboardPage)));
    await waitFor(() => expect(screen.getByRole("button", { name: "一键遗忘" })).toBeTruthy());
    await click(screen.getByRole("button", { name: "一键遗忘" }));
    await waitFor(() => expect(modalHeading()).toBeTruthy());
  });

  it("surfaces the server message when the preview request fails", async () => {
    wireApi({ preview: new BrowserApiError(500, { message: "服务暂时不可用" }) });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(screen.getByText("服务暂时不可用")).toBeTruthy());
    expect(callsTo("/forgetting/apply")).toHaveLength(0);
  });

  it("shows an in-modal error and keeps retrying when the re-preview fails", async () => {
    let previewCalls = 0;
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
      if (u.includes("/forgetting/preview")) {
        previewCalls += 1;
        return previewCalls === 1 ? Promise.resolve(PREVIEW) : Promise.reject(new Error("preview reload down"));
      }
      if (u === "/forgetting/apply") return Promise.reject(new BrowserApiError(422, { message: "stale" }));
      if (u.startsWith("/words?wordbookId=")) return Promise.resolve(wordsPage());
      return Promise.reject(new Error(`unexpected url: ${u}`));
    });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());
    await click(confirmButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "重新预览" })).toBeTruthy());

    await click(screen.getByRole("button", { name: "重新预览" }));
    await waitFor(() => expect(screen.getByText("预览加载失败，请重试")).toBeTruthy());
    expect(screen.getByRole("button", { name: "重新预览" })).toBeTruthy(); // 仍可再次尝试
  });

  it("keeps the restore entry with an error when the restore request fails", async () => {
    wireApi({ restore: new Error("restore down") });
    await mountCard();
    await click(entryButton());
    await waitFor(() => expect(confirmButton()).toBeTruthy());
    await click(confirmButton());
    await waitFor(() => expect(restoreButton()).toBeTruthy());

    await click(restoreButton());
    await waitFor(() => expect(screen.getByText("撤销失败，请重试")).toBeTruthy());
    expect(restoreButton()).toBeTruthy(); // batchId 未消费，可重试
  });

  it("shows the dashboard error state and recovers via retry", async () => {
    let queueCalls = 0;
    apiFetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.startsWith("/review/queue")) {
        queueCalls += 1;
        return Promise.reject(new Error("down"));
      }
      if (u.startsWith("/words?limit=1")) return Promise.reject(new Error("down"));
      if (u.startsWith("/review/stats/dashboard")) return Promise.reject(new Error("down"));
      if (u.includes("/wordbooks/default")) return Promise.resolve(BOOK);
      if (u.startsWith("/review/leeches")) return Promise.resolve({ items: [] });
      if (u.startsWith("/review/timeline")) return Promise.resolve({ items: [] });
      if (u.startsWith("/review/heatmap")) return Promise.resolve({ items: [] });
      if (u.startsWith("/review/stats")) return Promise.resolve({ todayCount: 0, totalCount: 0, ratingDist: { again: 0, hard: 0, good: 0, easy: 0 } });
      return Promise.reject(new Error(`unexpected url: ${u}`));
    });
    await mount(createElement(MemoryRouter, null, createElement(DashboardPage)));
    await waitFor(() => expect(screen.getByText("无法加载统计")).toBeTruthy());
    await click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(queueCalls).toBeGreaterThanOrEqual(2));
  });
});
