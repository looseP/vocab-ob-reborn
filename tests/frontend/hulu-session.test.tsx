/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 葫芦冲刺会话组件测试（ADR-0041，P1）。
 *
 * 形状照 `ladder-session-stepback.test.tsx`：jsdom + `createRoot` + 受控 `apiFetch`
 * mock（按 path 分派），**不连库**。断言的六件事都是 P1 验收条款：
 *  1. **单卡路径零请求**：逐词翻开 / 自认期间 `apiFetch` 调用次数不增长（mock 计数）；
 *  2. 60% 通过率被闸门拦下：整页清零、进学习态、**不跳页**、**不发结算请求**；
 *  3. 80% 放行：走 `plan.gate_ratio` 列值路径（不是写死的 0.8）；
 *  4. 回看已结算页：只读，不能改已结算页的自认；
 *  5. 刷新后续上：localStorage 缓存 + 从 `pages_passed` 页重来；
 *  6. 末页过闸 → POST finish → 展示本轮耗时。
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

const PLAN_ID = "11111111-1111-4111-8111-111111111111";

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
 * 装一套受控的 apiFetch。
 *
 * `pageSize` / `pages` 决定页载荷；`gateRatio` 写进计划行（闸门读列值）。
 * 返回请求日志，供断言"单卡路径零请求"。
 */
function installApi(options: {
  pages: number;
  pageSize: number;
  gateRatio?: number;
  alivePerPage?: number;
  pagesPassed?: number;
  targetRounds?: number;
  roundNo?: number;
  elapsedSeconds?: number;
}) {
  const calls: string[] = [];
  const gateRatio = options.gateRatio ?? 0.8;
  const roundNo = options.roundNo ?? 1;
  let pagesPassed = options.pagesPassed ?? 0;

  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/hulu/plans" && init?.method === "POST") {
      return {
        id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null,
        exam_date: "2026-12-20", target_rounds: options.targetRounds ?? 4,
        page_size: options.pageSize, gate_ratio: gateRatio, word_count: options.pages * options.pageSize,
        status: "active", suspend_review: false, suspended_count: 0,
        started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
      } as never;
    }
    if (path === `/hulu/plans/${PLAN_ID}`) {
      return {
        plan: {
          id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null,
          exam_date: "2026-12-20", target_rounds: options.targetRounds ?? 4,
          page_size: options.pageSize, gate_ratio: gateRatio, word_count: options.pages * options.pageSize,
          status: "active", suspend_review: false, suspended_count: 0,
          started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
        },
        rounds: [],
      } as never;
    }
    if (path === `/hulu/plans/${PLAN_ID}/rounds` && init?.method === "POST") {
      return {
        id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: roundNo,
        started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
        pages_passed: pagesPassed, words_passed: 0, words_total: options.pages * options.pageSize,
      } as never;
    }
    const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
    if (pageMatch) {
      const index = Number(pageMatch[1]);
      const alive = options.alivePerPage ?? options.pageSize;
      return {
        pageIndex: index,
        pages: options.pages,
        total: options.pageSize,
        alive,
        items: makeItems(alive, index * options.pageSize),
      } as never;
    }
    const settleMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/pages$/);
    if (settleMatch && init?.method === "POST") {
      pagesPassed += 1;
      return {
        id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: roundNo,
        started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
        pages_passed: pagesPassed, words_passed: 0, words_total: options.pages * options.pageSize,
      } as never;
    }
    const finishMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/finish$/);
    if (finishMatch && init?.method === "POST") {
      return {
        id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: roundNo,
        started_at: "2026-10-06T00:00:00Z", ended_at: "2026-10-06T01:00:00Z",
        elapsed_seconds: options.elapsedSeconds ?? 3600,
        pages_passed: pagesPassed, words_passed: 0, words_total: options.pages * options.pageSize,
      } as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });

  return { calls, settleCalls: () => calls.filter((call) => call.includes("/pages") && call.startsWith("POST")) };
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

/** 冲刷挂载后的缓存扫描与异步请求链。 */
async function flush(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

/** 点开「开始冲刺」并等进入冲刺态。 */
async function startSprint(container: HTMLElement) {
  const start = container.querySelector('[data-testid="hulu-start"]') as HTMLButtonElement;
  expect(start, "开始按钮应存在").toBeTruthy();
  await act(async () => { start.click(); });
  await flush();
}

/** 点某张卡的「翻开核对」并自认。 */
function flipAndJudge(container: HTMLElement, index: number, verdict: "pass" | "miss") {
  const flip = container.querySelector(`[data-testid="hulu-flip-${index}"]`) as HTMLButtonElement | null;
  if (flip) act(() => { flip.click(); });
  const judge = container.querySelector(`[data-testid="hulu-${verdict}-${index}"]`) as HTMLButtonElement | null;
  expect(judge, `卡 ${index} 的 ${verdict} 按钮应存在`).toBeTruthy();
  act(() => { judge!.click(); });
}

/** 点「下一页 / 完成本轮 / 重新自认」。 */
async function clickNext(container: HTMLElement) {
  const next = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
  expect(next, "推进按钮应存在").toBeTruthy();
  await act(async () => { next.click(); });
  await flush();
}

const bodyText = (container: HTMLElement) => container.textContent?.replace(/\s+/g, " ") ?? "";

describe("葫芦冲刺：页闸门（读计划行列值，不写死）", () => {
  it("60% 被拦：整页清零、进学习态、不跳页、不发结算请求", async () => {
    // 10 词 / 闸门 0.8 → 6 通过（60%）不过闸
    const { settleCalls } = installApi({ pages: 2, pageSize: 10, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    for (let i = 0; i < 10; i += 1) {
      flipAndJudge(container, i, i < 6 ? "pass" : "miss");
    }
    await clickNext(container);

    // 学习态横幅出现，仍停在第 1 页，且没有任何页结算请求
    expect(bodyText(container)).toContain("本页没到闸门");
    expect(bodyText(container)).toContain("第 1 / 2 页");
    expect(settleCalls()).toHaveLength(0);
  });

  it("80% 放行：走 plan.gate_ratio 列值路径（同一组件，0.8 列值下 8/10 通过）", async () => {
    const { settleCalls } = installApi({ pages: 2, pageSize: 10, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    for (let i = 0; i < 10; i += 1) {
      flipAndJudge(container, i, i < 8 ? "pass" : "miss");
    }
    await clickNext(container);

    // 过闸 → 发一次页结算，并前进到第 2 页
    expect(settleCalls()).toHaveLength(1);
    expect(bodyText(container)).toContain("第 2 / 2 页");
  });

  it("闸门读列值而非写死：同一 60% 通过率在 gate_ratio = 0.5 的计划下放行", async () => {
    // 这条与上一条成对：若实现写死 0.8，本用例会失败
    const { settleCalls } = installApi({ pages: 2, pageSize: 10, gateRatio: 0.5 });
    const container = mount();
    await flush();
    await startSprint(container);

    for (let i = 0; i < 10; i += 1) {
      flipAndJudge(container, i, i < 6 ? "pass" : "miss");
    }
    await clickNext(container);

    expect(settleCalls()).toHaveLength(1);
    expect(bodyText(container)).toContain("第 2 / 2 页");
  });
});

describe("葫芦冲刺：单卡路径零请求", () => {
  it("逐词翻开 / 自认期间 apiFetch 调用次数不增长", async () => {
    const { calls } = installApi({ pages: 2, pageSize: 10, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    // 进入冲刺后：取页载荷 1 次 + 轮次开始 1 次 + 计划读 1 次（+ 建计划 1 次）
    const before = calls.length;

    for (let i = 0; i < 10; i += 1) {
      flipAndJudge(container, i, "pass");
    }
    await flush(3);

    // 十张卡、二十次点击（翻开 + 自认）→ 零新增请求
    expect(calls.length).toBe(before);
  });

  it("学习态下「重新自认」也不发请求（整页清零是纯本地操作）", async () => {
    const { calls } = installApi({ pages: 2, pageSize: 10, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    for (let i = 0; i < 10; i += 1) flipAndJudge(container, i, "miss");
    await clickNext(container); // 被拦 → 学习态
    const before = calls.length;

    await clickNext(container); // 「重新自认」→ 退出学习态
    expect(calls.length).toBe(before);
    expect(bodyText(container)).not.toContain("本页没到闸门");
  });
});

describe("葫芦冲刺：已结算页只读回看", () => {
  it("回看已结算页：不显示自认按钮，自认不可改", async () => {
    const { settleCalls } = installApi({ pages: 3, pageSize: 5, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    // 第 1 页全通过 → 结算 → 进第 2 页
    for (let i = 0; i < 5; i += 1) flipAndJudge(container, i, "pass");
    await clickNext(container);
    expect(bodyText(container)).toContain("第 2 / 3 页");

    // 回看第 1 页
    const prev = Array.from(container.querySelectorAll("button")).find((button) =>
      /上一页/.test(button.textContent ?? ""),
    ) as HTMLButtonElement;
    await act(async () => { prev.click(); });
    await flush();

    expect(bodyText(container)).toContain("第 1 / 3 页");
    expect(bodyText(container)).toContain("此页已结算（只读）");
    // 已结算页不提供自认按钮（只读）
    expect(container.querySelector('[data-testid="hulu-pass-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="hulu-miss-0"]')).toBeNull();
    // 回看不产生新的结算请求
    expect(settleCalls()).toHaveLength(1);
  });
});

describe("葫芦冲刺：会话恢复（R3）", () => {
  it("刷新后续上：localStorage 命中同一 planId/roundNo → 从缓存页继续", async () => {
    // 缓存说停在第 2 页（index 1），且已结算 1 页 → 应直接落到第 2 页
    window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
      planId: PLAN_ID, roundNo: 1, pageIndex: 1,
      flipped: [], verdict: {}, savedAt: Date.now(),
    }));
    installApi({ pages: 3, pageSize: 5, gateRatio: 0.8, pagesPassed: 1 });

    const container = mount();
    await flush();

    // 直接进冲刺态（不经 setup），停在第 2 页
    expect(container.querySelector('[data-testid="hulu-setup"]')).toBeNull();
    expect(bodyText(container)).toContain("第 2 / 3 页");
  });

  it("缓存过期（> 24h）→ 丢弃并从 pages_passed 页重来", async () => {
    window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
      planId: PLAN_ID, roundNo: 1, pageIndex: 2,
      flipped: [], verdict: {}, savedAt: Date.now() - 25 * 60 * 60 * 1000,
    }));
    installApi({ pages: 3, pageSize: 5, gateRatio: 0.8, pagesPassed: 1 });

    const container = mount();
    await flush();

    // 过期缓存被丢弃 → 回 setup（不静默续上）
    expect(container.querySelector('[data-testid="hulu-setup"]')).toBeTruthy();
    // 且过期键已被清理
    expect(window.localStorage.getItem(`vocab:hulu:sprint:${PLAN_ID}`)).toBeNull();
  });

  it("缓存 roundNo 与服务端不一致 → 丢弃缓存，从 pages_passed 页重来", async () => {
    window.localStorage.setItem(`vocab:hulu:sprint:${PLAN_ID}`, JSON.stringify({
      planId: PLAN_ID, roundNo: 1, pageIndex: 2, // 缓存说第 1 轮
      flipped: [], verdict: {}, savedAt: Date.now(),
    }));
    // 服务端当前是第 2 轮，已结算 1 页
    installApi({ pages: 3, pageSize: 5, gateRatio: 0.8, pagesPassed: 1, roundNo: 2 });

    const container = mount();
    await flush();

    // 轮次不匹配 → 不采用缓存的 pageIndex 2，落到 pages_passed = 1（第 2 页）
    expect(bodyText(container)).toContain("第 2 / 3 页");
  });

  it("每次自认后写缓存（翻页/自认落盘，纯本地）", async () => {
    installApi({ pages: 2, pageSize: 5, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    flipAndJudge(container, 0, "pass");

    const raw = window.localStorage.getItem(`vocab:hulu:sprint:${PLAN_ID}`);
    expect(raw, "自认后应写缓存").toBeTruthy();
    const parsed = JSON.parse(raw!) as { planId: string; roundNo: number; pageIndex: number; verdict: Record<string, string> };
    expect(parsed.planId).toBe(PLAN_ID);
    expect(parsed.roundNo).toBe(1);
    expect(parsed.pageIndex).toBe(0);
    expect(parsed.verdict["0"]).toBe("pass");
  });
});

describe("葫芦冲刺：轮次收尾与整页删空", () => {
  it("末页过闸 → POST finish → 展示本轮耗时", async () => {
    const { calls } = installApi({ pages: 1, pageSize: 5, gateRatio: 0.8, elapsedSeconds: 3725 });
    const container = mount();
    await flush();
    await startSprint(container);

    for (let i = 0; i < 5; i += 1) flipAndJudge(container, i, "pass");
    await clickNext(container);

    expect(calls.some((call) => call.endsWith("/finish"))).toBe(true);
    expect(container.querySelector('[data-testid="hulu-finished"]')).toBeTruthy();
    // 3725 秒 → 62 分 05 秒
    expect(bodyText(container)).toContain("62 分 05 秒");
  });

  it("alive = 0 的页：不发渲染、直接结算 { passed: 0, total: 0 }", async () => {
    // 第 1 页整页删空（alive 0），第 2 页有词
    const calls: string[] = [];
    const bodies: Array<{ path: string; body: string }> = [];
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.body) bodies.push({ path, body: init.body });
      if (path === "/hulu/plans") {
        return {
          id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
          target_rounds: 4, page_size: 5, gate_ratio: 0.8, word_count: 10, status: "active",
          suspend_review: false, suspended_count: 0, started_at: "2026-10-06T00:00:00Z",
          ended_at: null, created_at: "2026-10-06T00:00:00Z",
        } as never;
      }
      if (path === `/hulu/plans/${PLAN_ID}`) {
        return {
          plan: {
            id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
            target_rounds: 4, page_size: 5, gate_ratio: 0.8, word_count: 10, status: "active",
            suspend_review: false, suspended_count: 0, started_at: "2026-10-06T00:00:00Z",
            ended_at: null, created_at: "2026-10-06T00:00:00Z",
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
      const pageMatch = path.match(/\/pages\/(\d+)$/);
      if (pageMatch && (init?.method ?? "GET") === "GET") {
        const index = Number(pageMatch[1]);
        return {
          pageIndex: index, pages: 2, total: 5,
          alive: index === 0 ? 0 : 5,
          items: index === 0 ? [] : makeItems(5, 5),
        } as never;
      }
      const settleMatch = path.match(/\/rounds\/\d+\/pages$/);
      if (settleMatch && init?.method === "POST") {
        return {
          id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
          started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
          pages_passed: 1, words_passed: 0, words_total: 10,
        } as never;
      }
      throw new Error(`未预期的请求：${path}`);
    });

    const container = mount();
    await flush();
    await startSprint(container);

    // 第 1 页自动结算（passed 0 / total 0），渲染落在第 2 页
    const emptySettle = bodies.find((entry) => entry.path.endsWith("/rounds/1/pages"));
    expect(emptySettle, "alive=0 的页应自动结算").toBeTruthy();
    expect(JSON.parse(emptySettle!.body)).toEqual({ pageIndex: 0, passed: 0, total: 0 });
    expect(bodyText(container)).toContain("第 2 / 2 页");
  });
});
