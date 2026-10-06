/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 葫芦冲刺：多轮流转 + 计划页（P2 T1 / §八）。
 *
 * 覆盖四条 P2 验收条款：
 *  1. **多轮流转**：末轮 finish → 展示本轮耗时 →「进入第 n+1 轮」→ `POST /rounds`
 *     → 从新轮的 pages_passed 页开始，曲线更新；
 *  2. **曲线更新**：收尾页/计划页展示的柱子来自 `GET /plans/:id` 的 rounds；
 *  3. **挂起状态展示**：计划页显示当前挂起状态（开关开/关两种文案）；
 *  4. **考试日已过的 active 计划**：显示提示横幅（不自动放弃）。
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

const PLAN_ID = "33333333-3333-4333-8333-333333333333";

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

/** 造一行 hulu_rounds。 */
function roundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
    pages_passed: 0, words_passed: 0, words_total: 5,
    ...overrides,
  };
}

/**
 * 受控 apiFetch：一轮 1 页 5 词；`rounds` 数组在收尾/开轮时更新，供曲线断言。
 */
function installApi(options: {
  targetRounds?: number;
  examDate?: string;
  suspendReview?: boolean;
  suspendedCount?: number;
  planStatus?: "active" | "completed" | "abandoned";
  finishedRounds?: Array<Record<string, unknown>>;
} = {}) {
  const calls: string[] = [];
  const targetRounds = options.targetRounds ?? 4;
  let planStatus = options.planStatus ?? "active";
  let currentRoundNo = (options.finishedRounds?.length ?? 0) + 1;
  let pagesPassed = 0;
  const rounds: Array<Record<string, unknown>> = [...(options.finishedRounds ?? [])];

  const planPayload = () => ({
    id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null,
    exam_date: options.examDate ?? "2026-12-20", target_rounds: targetRounds,
    page_size: 5, gate_ratio: 0.8, word_count: 5,
    status: planStatus,
    suspend_review: options.suspendReview ?? false,
    suspended_count: options.suspendedCount ?? 0,
    started_at: "2026-10-06T00:00:00Z",
    ended_at: planStatus === "active" ? null : "2026-10-06T02:00:00Z",
    created_at: "2026-10-06T00:00:00Z",
  });

  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/wordbooks") {
      return { items: [{ id: "wb-1", name: "默认词书", isDefault: true }], total: 1 } as never;
    }
    if (path === "/hulu/plans" && init?.method === "POST") return planPayload() as never;
    if (path === `/hulu/plans/${PLAN_ID}`) {
      return { plan: planPayload(), rounds: [...rounds] } as never;
    }
    if (path === `/hulu/plans/${PLAN_ID}/rounds` && init?.method === "POST") {
      pagesPassed = 0;
      return roundRow({ round_no: currentRoundNo, pages_passed: 0 }) as never;
    }
    const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
    if (pageMatch) {
      const index = Number(pageMatch[1]);
      return { pageIndex: index, pages: 1, total: 5, alive: 5, items: makeItems(5) } as never;
    }
    const settleMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/(\d+)\/pages$/);
    if (settleMatch && init?.method === "POST") {
      pagesPassed += 1;
      return roundRow({ round_no: Number(settleMatch[1]), pages_passed: pagesPassed }) as never;
    }
    const finishMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/(\d+)\/finish$/);
    if (finishMatch && init?.method === "POST") {
      const roundNo = Number(finishMatch[1]);
      // 收尾：该轮进入 rounds 列表（曲线数据源）；末轮 → 计划 completed
      rounds.push(roundRow({
        id: `round-id-${roundNo}`, round_no: roundNo,
        ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 3600 * roundNo,
      }));
      if (roundNo >= targetRounds) planStatus = "completed";
      currentRoundNo = roundNo + 1;
      return roundRow({
        id: `round-id-${roundNo}`, round_no: roundNo,
        ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 3600 * roundNo,
      }) as never;
    }
    const abandonMatch = path.match(/^\/hulu\/plans\/[^/]+\/abandon$/);
    if (abandonMatch && init?.method === "POST") {
      planStatus = "abandoned";
      return planPayload() as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });

  return { calls, rounds };
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

async function startSprint(container: HTMLElement) {
  const start = container.querySelector('[data-testid="hulu-start"]') as HTMLButtonElement;
  expect(start, "开始按钮应存在").toBeTruthy();
  await act(async () => { start.click(); });
  await flush();
}

/** 把当前页 5 张卡全部自认通过，并点「完成本轮」。 */
async function clearRound(container: HTMLElement) {
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
}

const bodyText = (container: HTMLElement) => container.textContent?.replace(/\s+/g, " ") ?? "";

describe("T1 多轮流转：末轮 finish → 进入下一轮", () => {
  it("非末轮收尾：展示耗时 + 「进入第 2 轮」按钮 → POST /rounds → 回到冲刺态第 2 轮", async () => {
    const { calls } = installApi({ targetRounds: 4 });
    const container = mount();
    await flush();
    await startSprint(container);

    await clearRound(container);

    // 收尾页：本轮耗时 + 下一轮入口
    expect(container.querySelector('[data-testid="hulu-finished"]')).toBeTruthy();
    expect(bodyText(container)).toContain("1 时 00 分");
    const nextRound = container.querySelector('[data-testid="hulu-next-round"]') as HTMLButtonElement;
    expect(nextRound, "非末轮应有进入下一轮按钮").toBeTruthy();
    expect(nextRound.textContent).toContain("进入第 2 轮");

    const roundsBefore = calls.filter((call) => call === `POST /hulu/plans/${PLAN_ID}/rounds`).length;
    await act(async () => { nextRound.click(); });
    await flush();

    // 发了一次 POST /rounds，并回到冲刺态、轮号前进
    const roundsAfter = calls.filter((call) => call === `POST /hulu/plans/${PLAN_ID}/rounds`).length;
    expect(roundsAfter).toBe(roundsBefore + 1);
    expect(container.querySelector('[data-testid="hulu-sprint"]')).toBeTruthy();
    expect(bodyText(container)).toContain("第 2 / 4 轮");
  });

  it("末轮收尾：不提供「进入下一轮」，明示计划完成（服务端已 completed）", async () => {
    installApi({ targetRounds: 2, finishedRounds: [roundRow({ id: "round-id-1", round_no: 1, ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 3600 })] });
    const container = mount();
    await flush();

    // 缓存续上（第 2 轮的第 1 页）
    window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
      planId: PLAN_ID, roundNo: 2, pageIndex: 0, flipped: [], verdict: {}, savedAt: Date.now(),
    }));
    const container2 = mount();
    await flush();

    await clearRound(container2);

    expect(container2.querySelector('[data-testid="hulu-finished"]')).toBeTruthy();
    expect(container2.querySelector('[data-testid="hulu-next-round"]'), "末轮不应有下一轮按钮").toBeNull();
    expect(container2.querySelector('[data-testid="hulu-plan-complete"]')).toBeTruthy();
    void container;
  });

  it("收尾页展示曲线，且曲线柱子来自服务端 rounds（不是前端推算）", async () => {
    installApi({
      targetRounds: 4,
      finishedRounds: [roundRow({ id: "round-id-1", round_no: 1, ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 7200 })],
    });
    const container = mount();
    await flush();
    await startSprint(container);

    await clearRound(container);

    const bars = Array.from(container.querySelectorAll("[data-round-id]"));
    // 首轮（服务端已有）+ 刚收尾的第 2 轮 = 两根柱子，且 id/耗时逐一对上
    expect(bars.map((bar) => bar.getAttribute("data-round-id"))).toEqual(["round-id-1", "round-id-2"]);
    expect(bars.map((bar) => bar.getAttribute("data-elapsed-seconds"))).toEqual(["7200", "7200"]);
  });
});

describe("T3 前端：挂起开关（创建表单 + 计划页状态）", () => {
  it("创建表单默认关，带明示文案，并在提交时把开关原样带给服务端", async () => {
    const { calls } = installApi();
    const container = mount();
    await flush();

    const toggle = container.querySelector('[data-testid="hulu-suspend-toggle"]') as HTMLInputElement;
    expect(toggle, "开关应存在").toBeTruthy();
    expect(toggle.checked, "默认必须是关").toBe(false);
    expect(bodyText(container)).toContain("这批词会暂时退出到期队列，计划结束或放弃时自动回来");
    expect(bodyText(container)).toContain("只能在创建时设定");

    await startSprint(container);
    expect(calls).toContain("POST /hulu/plans");
  });

  it("勾选后创建：请求体带 suspendReview: true", async () => {
    const bodies: Array<{ path: string; body: string }> = [];
    installApi();
    const original = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push({ path, body: init.body });
      return original(path, init);
    });

    const container = mount();
    await flush();

    const toggle = container.querySelector('[data-testid="hulu-suspend-toggle"]') as HTMLInputElement;
    act(() => { toggle.click(); });
    await startSprint(container);

    const create = bodies.find((entry) => entry.path === "/hulu/plans");
    expect(create, "应有创建请求").toBeTruthy();
    expect(JSON.parse(create!.body)).toMatchObject({ suspendReview: true });
  });

  it("计划页显示挂起状态（开关开：挂起中 N 词；关：未启用挂起）", async () => {
    installApi({ planStatus: "completed", suspendReview: true, suspendedCount: 0 });
    // 计划页的入口是「有缓存但服务端计划已结束」——刷新后重进的那条路径。
    window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
      planId: PLAN_ID, roundNo: 1, pageIndex: 0, flipped: [], verdict: {}, savedAt: Date.now(),
    }));
    const container = mount();
    await flush();

    expect(container.querySelector('[data-testid="hulu-plan"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-suspend-state"]')?.textContent).toContain("挂起中");
  });

  it("未开开关的计划：计划页显示「未启用挂起」", async () => {
    installApi({ planStatus: "abandoned", suspendReview: false });
    window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
      planId: PLAN_ID, roundNo: 1, pageIndex: 0, flipped: [], verdict: {}, savedAt: Date.now(),
    }));
    const container = mount();
    await flush();

    expect(container.querySelector('[data-testid="hulu-plan"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-suspend-state"]')?.textContent).toContain("未启用挂起");
  });
});

describe("§八 计划页：放弃按钮与考试日已过横幅", () => {
  it("active 计划的收尾页有「放弃计划」按钮 → POST /abandon → 计划页显示已放弃", async () => {
    const { calls } = installApi({ targetRounds: 4 });
    const container = mount();
    await flush();
    await startSprint(container);
    await clearRound(container);

    const abandon = container.querySelector('[data-testid="hulu-abandon"]') as HTMLButtonElement;
    expect(abandon, "active 计划应有放弃按钮").toBeTruthy();
    await act(async () => { abandon.click(); });
    await flush();

    expect(calls).toContain(`POST /hulu/plans/${PLAN_ID}/abandon`);
    expect(container.querySelector('[data-testid="hulu-plan"]')).toBeTruthy();
    expect(bodyText(container)).toContain("该冲刺计划已放弃");
  });

  it("exam_date 已过的 active 计划 → 提示横幅（建议放弃，不自动放弃）", async () => {
    installApi({ examDate: "2020-01-01" });
    const container = mount();
    await flush();
    await startSprint(container);
    await clearRound(container);

    const banner = container.querySelector('[data-testid="hulu-exam-passed"]');
    expect(banner, "考试日已过应有横幅").toBeTruthy();
    expect(banner!.textContent).toContain("考试日已过");
    expect(banner!.textContent).toContain("建议放弃");
    // 不自动放弃：计划仍是 active（放弃按钮还在）
    expect(container.querySelector('[data-testid="hulu-abandon"]')).toBeTruthy();
  });

  it("exam_date 未过 → 无横幅", async () => {
    installApi({ examDate: "2099-12-31" });
    const container = mount();
    await flush();
    await startSprint(container);
    await clearRound(container);

    expect(container.querySelector('[data-testid="hulu-exam-passed"]')).toBeNull();
  });
});
