/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 葫芦冲刺：轮收尾恢复路径（P2-0 必修补丁）。
 *
 * 背景（主控复核发现的边界死锁）：**本轮页已全部结算但轮未收尾**时，
 * 重进会让页游标落在 `pages` 上 —— `GET /pages/pages` 返回 404，旧实现
 * 直接报错、清缓存回 setup，用户既收不了尾也回不去。两个触发面：
 *  ① 末页**整页删空** + 刷新（`loadPage` 自动结算过，游标 = pages）；
 *  ② 末页结算与 `finish` 之间中断（`pages_passed` = pages，轮仍 `ended_at IS NULL`）。
 *
 * 三条补丁一起验证（缺任一条都会把「刷新才卡」变成「当场就卡」）：
 *  1. `goNext` 的 settled 分支：末页 → `finishRound`（幂等）；
 *  2. `loadPage` / `enterPlan`：`startIndex >= pages` 或页载荷 404 → 视为
 *     「本轮页已全部结算」→ 直接收尾，不报错、不清缓存；
 *  3. `loadPage` 自动结算后把返回行写回 `round` —— 否则 `settled` 判据滞后，
 *     末页「完成本轮」按钮当场点不动。
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/frontend/api/wordbooks", () => ({
  getDefaultWordbook: vi.fn(async () => ({ id: "wb-1", name: "默认词书" })),
}));

import { apiFetch } from "@/frontend/api/client";
import { HuluSprintSession } from "@/frontend/components/review/HuluSprintSession";

const apiFetchMock = vi.mocked(apiFetch);

const PLAN_ID = "22222222-2222-4222-8222-222222222222";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
});

function makeItems(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w-${offset + i}`,
    slug: `word-${offset + i}`,
    title: `word-${offset + i}`,
    lemma: `word-${offset + i}`,
    ipa: `/w${offset + i}/`,
    pos: "n.",
    short_definition: `释义 ${offset + i}`,
    mnemonic_text: `助记 ${offset + i}`,
  }));
}

/**
 * 装一套受控 apiFetch。
 *
 * `aliveByPage` 逐页给存活词数（缺省 = pageSize）——「末页整页删空」靠它表达。
 * `pagesPassed` 是服务端轮次的页游标初值（模拟「结算完但没来得及收尾」）。
 */
function installApi(options: {
  pages: number;
  pageSize: number;
  aliveByPage?: number[];
  pagesPassed?: number;
  targetRounds?: number;
}) {
  const calls: string[] = [];
  let pagesPassed = options.pagesPassed ?? 0;
  const targetRounds = options.targetRounds ?? 4;
  const planPayload = {
    id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null,
    exam_date: "2026-12-20", target_rounds: targetRounds,
    page_size: options.pageSize, gate_ratio: 0.8,
    word_count: options.pages * options.pageSize,
    status: "active", suspend_review: false, suspended_count: 0,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
  };

  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/hulu/plans" && init?.method === "POST") return planPayload as never;
    if (path === `/hulu/plans/${PLAN_ID}`) return { plan: planPayload, rounds: [] } as never;
    if (path === `/hulu/plans/${PLAN_ID}/rounds` && init?.method === "POST") {
      return {
        id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
        started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
        pages_passed: pagesPassed, words_passed: 0, words_total: options.pages * options.pageSize,
      } as never;
    }
    const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
    if (pageMatch) {
      const index = Number(pageMatch[1]);
      const alive = options.aliveByPage?.[index] ?? options.pageSize;
      return {
        pageIndex: index, pages: options.pages, total: options.pageSize,
        alive, items: makeItems(alive, index * options.pageSize),
      } as never;
    }
    const settleMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/pages$/);
    if (settleMatch && init?.method === "POST") {
      pagesPassed += 1;
      return {
        id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
        started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
        pages_passed: pagesPassed, words_passed: 0, words_total: options.pages * options.pageSize,
      } as never;
    }
    const finishMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/finish$/);
    if (finishMatch && init?.method === "POST") {
      return {
        id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
        started_at: "2026-10-06T00:00:00Z", ended_at: "2026-10-06T01:00:00Z",
        elapsed_seconds: 3600, pages_passed: pagesPassed, words_passed: 0,
        words_total: options.pages * options.pageSize,
      } as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });

  return {
    calls,
    finishCalls: () => calls.filter((call) => call.endsWith("/finish")),
  };
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(HuluSprintSession, { onBack: vi.fn() }));
  });
  mountedRoots.push({ root, container });
  return container;
}

async function flush(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

/** 预置一条「刷新续上」的缓存。 */
function seedCache(pageIndex: number, roundNo = 1): void {
  window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
    planId: PLAN_ID, roundNo, pageIndex, flipped: [], verdict: {}, savedAt: Date.now(),
  }));
}

const bodyText = (container: HTMLElement) => container.textContent?.replace(/\s+/g, " ") ?? "";

describe("P2-0：末页整页删空后的收尾（刷新续上）", () => {
  it("末页删空 + 刷新：游标已落在 pages 上 → 自动收尾（finish 被调用、进入 finished）", async () => {
    // 服务端：唯一的页已被 loadPage 自动结算（pages_passed = 1 = pages），轮未收尾。
    // 缓存说用户停在那一页 —— 旧实现会 404 → 报错清缓存，收不了尾。
    seedCache(0);
    const { finishCalls } = installApi({
      pages: 1, pageSize: 5, aliveByPage: [0], pagesPassed: 1,
    });

    const container = mount();
    await flush();

    expect(finishCalls(), "应调用一次 finish 收尾").toHaveLength(1);
    expect(container.querySelector('[data-testid="hulu-finished"]'), "应进入 finished 态").toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-error"]')).toBeNull();
    // 缓存已清（收尾后不再有可续的会话）
    expect(window.localStorage.getItem(`vocab:hulu:sprint:${PLAN_ID}`)).toBeNull();
    expect(bodyText(container)).toContain("本轮耗时");
  });

  it("末页删空 + 当场点「完成本轮」：自动结算写回游标 → 按钮可用 → finish", async () => {
    // 第 1 页有词、第 2 页整页删空。第 2 页被 loadPage 自动结算后，
    // 若没把返回行写回 round，settled 判据滞后、末页按钮会当场点不动。
    const { finishCalls, calls } = installApi({
      pages: 2, pageSize: 5, aliveByPage: [5, 0],
    });
    const container = mount();
    await flush();

    // 从 setup 进入冲刺
    const start = container.querySelector('[data-testid="hulu-start"]') as HTMLButtonElement;
    await act(async () => { start.click(); });
    await flush();

    // 第 1 页全通过 → 结算 → 落到删空的第 2 页
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        (container.querySelector(`[data-testid="hulu-flip-${i}"]`) as HTMLButtonElement | null)?.click();
      });
      act(() => {
        (container.querySelector(`[data-testid="hulu-pass-${i}"]`) as HTMLButtonElement | null)?.click();
      });
    }
    const next = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
    await act(async () => { next.click(); });
    await flush();

    // 已落到末页（删空页）：只读 + 「完成本轮」
    expect(bodyText(container)).toContain("第 2 / 2 页");
    expect(bodyText(container)).toContain("此页已结算（只读）");

    const finishButton = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
    expect(finishButton.disabled, "末页「完成本轮」不应被禁用").toBe(false);
    await act(async () => { finishButton.click(); });
    await flush();

    expect(finishCalls(), "点「完成本轮」应发 finish").toHaveLength(1);
    expect(container.querySelector('[data-testid="hulu-finished"]')).toBeTruthy();
    // 两页各结算一次（第 2 页是自动结算），finish 一次
    expect(calls.filter((call) => call.startsWith("POST") && call.endsWith("/pages"))).toHaveLength(2);
  });
});

describe("P2-0：结算后中断（pages_passed = pages，轮未收尾）", () => {
  it("重进时页游标已到 pages → 不请求越界页，直接收尾", async () => {
    // 2 页都已结算、finish 未发出（模拟末页结算与收尾之间中断）。
    seedCache(1);
    const { finishCalls, calls } = installApi({
      pages: 2, pageSize: 5, aliveByPage: [5, 5], pagesPassed: 2,
    });

    const container = mount();
    await flush();

    expect(finishCalls(), "重进应自动收尾").toHaveLength(1);
    expect(container.querySelector('[data-testid="hulu-finished"]')).toBeTruthy();
    // 关键：不去取越界页（pages/2 会 404）
    expect(calls.some((call) => call.includes(`/pages/2`)), "不应请求越界页").toBe(false);
  });

  it("页载荷 404（越界）也被当作「本轮已可收尾」→ finish，而不是报错回 setup", async () => {
    // 缓存把用户指到第 2 页（index 1），但服务端只认 1 页 —— 服务端 pages_passed 为 0
    // 时 startIndex 仍是 1，取页 404。旧实现直接进 error/setup。
    seedCache(1);
    const calls: string[] = [];
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === `/hulu/plans/${PLAN_ID}`) {
        return {
          plan: {
            id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null,
            exam_date: "2026-12-20", target_rounds: 4, page_size: 5, gate_ratio: 0.8,
            word_count: 10, status: "active", suspend_review: false, suspended_count: 0,
            started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
          },
          rounds: [],
        } as never;
      }
      if (path === `/hulu/plans/${PLAN_ID}/rounds` && init?.method === "POST") {
        return {
          id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
          started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
          pages_passed: 0, words_passed: 0, words_total: 10,
        } as never;
      }
      const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
      if (pageMatch) {
        const index = Number(pageMatch[1]);
        if (index > 0) {
          // 越界页：服务端 404（BrowserApiError 形状）
          throw Object.assign(new Error("HuluPlanPage not found"), { status: 404 });
        }
        return { pageIndex: 0, pages: 1, total: 5, alive: 5, items: makeItems(5) } as never;
      }
      const finishMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/finish$/);
      if (finishMatch && init?.method === "POST") {
        return {
          id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
          started_at: "2026-10-06T00:00:00Z", ended_at: "2026-10-06T01:00:00Z",
          elapsed_seconds: 3600, pages_passed: 1, words_passed: 0, words_total: 10,
        } as never;
      }
      throw new Error(`未预期的请求：${path}`);
    });

    const container = mount();
    await flush();

    expect(calls.some((call) => call.endsWith("/finish")), "404 应触发收尾").toBe(true);
    expect(container.querySelector('[data-testid="hulu-finished"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="hulu-setup"]')).toBeNull();
  });
});
