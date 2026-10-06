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
/**
 * Markdown 懒加载 marked + dompurify（动态 import），在 jsdom 里要多等一轮真实
 * 宏任务才渲染 —— 本文件只关心「降级路径走到了 Markdown」，不关心 markdown 的
 * 解析结果（那是 Markdown 自己的测试）。照 review-card-sense-list 等先例打桩。
 */
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", { "data-testid": "markdown" }, props.content),
}));

import { apiFetch } from "@/frontend/api/client";
import { HuluSprintSession } from "@/frontend/components/review/HuluSprintSession";
import { ToastProvider } from "@/frontend/components/ui/Toast";

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

/**
 * 造页载荷词卡（R10：卡面五层要的字段都在）。
 * `makeItems` 给的是「有义项 + 助记 + 例句 + 语义链」的完整卡；
 * 单独用例可按需覆盖字段测降级路径。
 */
function makeItems(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w-${offset + i}`,
    slug: `word-${offset + i}`,
    title: `word-${offset + i}`,
    lemma: `word-${offset + i}`,
    ipa: `/w${offset + i}/`,
    pos: "n.",
    cefr: null,
    short_definition: `释义 ${offset + i}`,
    core_definitions: [
      { sense: `义项A ${offset + i}`, en: `senseA ${offset + i}`, priority: 1, tags: ["core"] },
      { sense: `义项B ${offset + i}`, en: `senseB ${offset + i}`, priority: 2, tags: [] },
    ],
    definition_md: `1. 义项A ${offset + i}`,
    examples: [{ text: `例句 ${offset + i}`, translation: `译 ${offset + i}`, source: "测试语料" }],
    prototype_text: null,
    mnemonic_text: `助记 ${offset + i}`,
    mnemonic_type: "词根",
    semantic_chain: `链 ${offset + i}`,
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

/**
 * T2 / M2 —— 卡面精致化（R10 / D-B）：五层披露。
 *
 * 全部数据来自**页载荷**（`installApi` 的 items），所以这些用例同时是
 * 「单卡零请求」的证据：卡面再丰富，也不新增任何请求。
 */
describe("葫芦冲刺：卡面五层披露（R10 / D-B）", () => {
  it("义项按 priority 序渲染（用 SenseList，序号即重要程度）", async () => {
    installApi({ pages: 1, pageSize: 3, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    act(() => {
      (container.querySelector('[data-testid="hulu-flip-0"]') as HTMLButtonElement).click();
    });

    const senses = container.querySelector('[data-testid="hulu-senses-0"]');
    expect(senses, "有 core_definitions 时应渲染义项层").toBeTruthy();
    // 义项按载荷给的顺序（服务端按 priority 排好）呈现
    expect(senses!.textContent).toContain("义项A 0");
    expect(senses!.textContent).toContain("义项B 0");
    const text = senses!.textContent ?? "";
    expect(text.indexOf("义项A 0")).toBeLessThan(text.indexOf("义项B 0"));
    // 走的是 SenseList（其 ol 带 data-testid="sense-list"）
    expect(senses!.querySelector('[data-testid="sense-list"]')).toBeTruthy();
    // 有义项时**不**再渲染 definition_md 降级块
    expect(container.querySelector('[data-testid="hulu-definition-0"]')).toBeNull();
  });

  it("无 core_definitions 时降级走 definition_md（与 L1 卡背同一判据）", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/hulu/plans" && init?.method === "POST") {
        return {
          id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
          target_rounds: 4, page_size: 2, gate_ratio: 0.8, word_count: 2, status: "active",
          suspend_review: false, suspended_count: 0, started_at: "2026-10-06T00:00:00Z",
          ended_at: null, created_at: "2026-10-06T00:00:00Z",
        } as never;
      }
      if (path === `/hulu/plans/${PLAN_ID}`) {
        return {
          plan: {
            id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
            target_rounds: 4, page_size: 2, gate_ratio: 0.8, word_count: 2, status: "active",
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
          pages_passed: 0, words_passed: 0, words_total: 2,
        } as never;
      }
      const pageMatch = path.match(/\/pages\/(\d+)$/);
      if (pageMatch) {
        return {
          pageIndex: 0, pages: 1, total: 2, alive: 2,
          items: [
            { // 无义项 → 走 markdown 降级
              id: "w-0", slug: "word-0", title: "word-0", lemma: "word-0", ipa: null, pos: null,
              cefr: null, short_definition: "只有短释", core_definitions: [],
              definition_md: "1. 降级义项一\n2. 降级义项二", examples: [], prototype_text: null,
              mnemonic_text: null, mnemonic_type: null, semantic_chain: null,
            },
            { // 短释也缺 → 显示占位，不崩
              id: "w-1", slug: "word-1", title: "word-1", lemma: "word-1", ipa: null, pos: null,
              cefr: null, short_definition: null, core_definitions: [], definition_md: "",
              examples: [], prototype_text: null, mnemonic_text: null, mnemonic_type: null,
              semantic_chain: null,
            },
          ],
        } as never;
      }
      throw new Error(`未预期的请求：${path}`);
    });

    const container = mount();
    await flush();
    await startSprint(container);

    act(() => {
      (container.querySelector('[data-testid="hulu-flip-0"]') as HTMLButtonElement).click();
    });

    // Markdown 组件懒加载 marked + dompurify（动态 import）→ 多冲刷几轮等它渲染出来
    await flush(20);

    // 无义项 → definition_md 降级块出现（且不渲染 SenseList）
    const fallback = container.querySelector('[data-testid="hulu-definition-0"]');
    expect(fallback, "无 core_definitions 应降级 definition_md").toBeTruthy();
    expect(fallback!.textContent).toContain("降级义项一");
    expect(container.querySelector('[data-testid="hulu-senses-0"]')).toBeNull();

    // 短释缺失也不崩，显示占位
    act(() => {
      (container.querySelector('[data-testid="hulu-flip-1"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="hulu-answer-1"]')).toBeTruthy();
    expect(bodyText(container)).toContain("暂无释义");
  });

  it("助记锚显著呈现（mnemonic_text + mnemonic_type 徽标）", async () => {
    installApi({ pages: 1, pageSize: 3, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    act(() => {
      (container.querySelector('[data-testid="hulu-flip-0"]') as HTMLButtonElement).click();
    });

    const mnemonic = container.querySelector('[data-testid="hulu-mnemonic-0"]');
    expect(mnemonic, "助记应上卡面").toBeTruthy();
    expect(mnemonic!.textContent).toContain("助记 0");
    // 类型徽标
    const badge = container.querySelector('[data-testid="hulu-mnemonic-type-0"]');
    expect(badge, "助记类型徽标应存在").toBeTruthy();
    expect(badge!.textContent).toContain("词根");
  });

  it("例句呈现前 1–2 条（text + 译文 + 来源）", async () => {
    installApi({ pages: 1, pageSize: 3, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    act(() => {
      (container.querySelector('[data-testid="hulu-flip-0"]') as HTMLButtonElement).click();
    });

    const examples = container.querySelector('[data-testid="hulu-examples-0"]');
    expect(examples, "例句层应存在").toBeTruthy();
    expect(examples!.textContent).toContain("例句 0");
    expect(examples!.textContent).toContain("译 0");
    expect(examples!.textContent).toContain("测试语料");
  });

  it("语义链默认折叠、可点展开（Tier2）", async () => {
    installApi({ pages: 1, pageSize: 3, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    act(() => {
      (container.querySelector('[data-testid="hulu-flip-0"]') as HTMLButtonElement).click();
    });

    // 折叠态：只有开关，没有内容
    expect(container.querySelector('[data-testid="hulu-tier2-toggle-0"]'), "折叠开关应存在").toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-tier2-body-0"]'), "默认应折叠").toBeNull();

    // 点开
    act(() => {
      (container.querySelector('[data-testid="hulu-tier2-toggle-0"]') as HTMLButtonElement).click();
    });
    const body = container.querySelector('[data-testid="hulu-tier2-body-0"]');
    expect(body, "点开后应展开").toBeTruthy();
    expect(body!.textContent).toContain("链 0");
  });

  it("单卡零请求：翻开 + 展开语义链期间 apiFetch 调用次数不增长（卡面数据全随页载荷带下）", async () => {
    const { calls } = installApi({ pages: 2, pageSize: 5, gateRatio: 0.8 });
    const container = mount();
    await flush();
    await startSprint(container);

    const before = calls.length;

    for (let i = 0; i < 5; i += 1) {
      act(() => {
        (container.querySelector(`[data-testid="hulu-flip-${i}"]`) as HTMLButtonElement).click();
      });
      // 每张卡都点开语义链（Tier2 展开也是纯本地）
      act(() => {
        (container.querySelector(`[data-testid="hulu-tier2-toggle-${i}"]`) as HTMLButtonElement).click();
      });
    }

    expect(calls.length, "卡面渲染与折叠展开都不得产生请求").toBe(before);
  });

  it("卡面数据不来自逐词详情接口（源码层面不出现 useWordDetail / ReviewCardView）", async () => {
    const { readFileSync } = await import("node:fs");
    // 相对仓库根读取（照 hulu-speed-curve.test.tsx 先例；jsdom 下 import.meta.url 不是 file:）
    const source = readFileSync("src/frontend/components/review/HuluSprintSession.tsx", "utf8");
    // 注释里可以提这两个名字（说明为什么不用），但 import 不得出现
    expect(source).not.toMatch(/^import .*useWordDetail/m);
    expect(source).not.toMatch(/^import .*ReviewCardView/m);
    expect(source).toContain('from "@/frontend/components/words/SenseList"');
  });
});

/**
 * T3 / M3 —— D1 修复（R11）：页内词集漂移 → 自动重取本页，不落错误页。
 *
 * 场景：用户进页时页内有 N 词；结算前这些词被上架/下架，服务端复算的 alive
 * 与前端手里的 total 不符 → 422 `HULU_PAGE_ALIVE_MISMATCH`。旧行为是整页卡死
 * 在错误页；新行为是重取本页 + 轻提示。
 */
describe("葫芦冲刺：D1 页内词集漂移（R11）", () => {
  /** 受控 apiFetch：第一次结算返回 D1 机器码，重取页载荷返回**缩小后**的页。 */
  function installDriftingApi(options: { pageSize: number; aliveAfter: number }) {
    const calls: string[] = [];
    let settleAttempts = 0;
    let reloaded = false;

    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);

      if (path === "/hulu/plans" && init?.method === "POST") {
        return {
          id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
          target_rounds: 4, page_size: options.pageSize, gate_ratio: 0.8, word_count: options.pageSize,
          status: "active", suspend_review: false, suspended_count: 0,
          started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
        } as never;
      }
      if (path === `/hulu/plans/${PLAN_ID}`) {
        return {
          plan: {
            id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
            target_rounds: 4, page_size: options.pageSize, gate_ratio: 0.8, word_count: options.pageSize,
            status: "active", suspend_review: false, suspended_count: 0,
            started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
          },
          rounds: [],
        } as never;
      }
      if (path === `/hulu/plans/${PLAN_ID}/rounds` && init?.method === "POST") {
        return {
          id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
          started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
          pages_passed: 0, words_passed: 0, words_total: options.pageSize,
        } as never;
      }
      const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
      if (pageMatch) {
        // 重取时页内词已缩小（模拟"上架/下架"后的真实词集）
        const alive = reloaded ? options.aliveAfter : options.pageSize;
        return {
          pageIndex: 0, pages: 1, total: options.pageSize, alive,
          items: makeItems(alive, 0),
        } as never;
      }
      const settleMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/pages$/);
      if (settleMatch && init?.method === "POST") {
        settleAttempts += 1;
        if (settleAttempts === 1) {
          // 第一次结算：服务端复算的 alive 与前端 total 不符 → D1 机器码
          reloaded = true;
          throw Object.assign(new Error("total 与本页存活词数不符"), {
            status: 422,
            code: "HULU_PAGE_ALIVE_MISMATCH",
          });
        }
        return {
          id: "round-1", plan_id: PLAN_ID, user_id: "u-1", round_no: 1,
          started_at: "2026-10-06T00:00:00Z", ended_at: null, elapsed_seconds: null,
          pages_passed: 1, words_passed: 0, words_total: options.pageSize,
        } as never;
      }
      throw new Error(`未预期的请求：${path}`);
    });

    return { calls, settleAttempts: () => settleAttempts };
  }

  it("结算遇该码 → 自动重取本页、不落错误页、无重复结算", async () => {
    const { calls, settleAttempts } = installDriftingApi({ pageSize: 5, aliveAfter: 4 });
    const container = mount();
    await flush();
    await startSprint(container);

    // 本页 5 词全通过 → 点下一页 → 结算遇 D1
    for (let i = 0; i < 5; i += 1) flipAndJudge(container, i, "pass");
    await clickNext(container);

    // ① 不落错误页（这是修复的核心：旧行为会卡死在这里）
    expect(container.querySelector('[data-testid="hulu-error"]'), "不应落错误页").toBeNull();
    expect(container.querySelector('[data-testid="hulu-sprint"]'), "应留在冲刺态").toBeTruthy();

    // ② 确实重取了本页（同一页号又发了一次 GET）
    const pageGets = calls.filter((call) => call === `GET /hulu/plans/${PLAN_ID}/pages/0`);
    expect(pageGets.length, "应重新取过本页").toBeGreaterThanOrEqual(2);

    // ③ 只结算了一次（重取后回到未自认态，没有自动重试结算）
    expect(settleAttempts(), "不得重复结算").toBe(1);

    // ④ 重取后渲染的是**缩小后**的词集（4 词）
    expect(container.querySelector('[data-testid="hulu-card-4"]'), "已消失的第 5 张卡不应还在").toBeNull();
    expect(container.querySelector('[data-testid="hulu-card-3"]')).toBeTruthy();

    // ⑤ 轻提示文案（无 ToastProvider 时安静缺席，故只断言不炸；有 Provider 时出现）
    expect(bodyText(container)).not.toContain("页结算失败");
  });

  it("轻提示：有 ToastProvider 时弹出「本页词集已变化，已重新加载」", async () => {
    const { settleAttempts } = installDriftingApi({ pageSize: 5, aliveAfter: 4 });

    // 这次带真实 Provider 挂载（应用根部的真实拓扑）
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(ToastProvider, null, createElement(HuluSprintSession, { onBack: vi.fn() })),
      );
    });
    mountedRoots.push({ root, container });

    await flush();
    await startSprint(container);

    for (let i = 0; i < 5; i += 1) flipAndJudge(container, i, "pass");
    await clickNext(container);

    // 轻提示文案出现（Toast 渲染在 Provider 的 fixed 容器里）
    expect(document.body.textContent).toContain("本页词集已变化，已重新加载");
    expect(settleAttempts(), "仍只结算一次").toBe(1);
    expect(container.querySelector('[data-testid="hulu-error"]')).toBeNull();
  });

  it("其它错误码仍走错误页（只有该稳定码被特判）", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/hulu/plans" && init?.method === "POST") {
        return {
          id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
          target_rounds: 4, page_size: 5, gate_ratio: 0.8, word_count: 5, status: "active",
          suspend_review: false, suspended_count: 0, started_at: "2026-10-06T00:00:00Z",
          ended_at: null, created_at: "2026-10-06T00:00:00Z",
        } as never;
      }
      if (path === `/hulu/plans/${PLAN_ID}`) {
        return {
          plan: {
            id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null, exam_date: "2026-12-20",
            target_rounds: 4, page_size: 5, gate_ratio: 0.8, word_count: 5, status: "active",
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
          pages_passed: 0, words_passed: 0, words_total: 5,
        } as never;
      }
      const pageMatch = path.match(/\/pages\/(\d+)$/);
      if (pageMatch) {
        return { pageIndex: 0, pages: 1, total: 5, alive: 5, items: makeItems(5, 0) } as never;
      }
      const settleMatch = path.match(/\/rounds\/\d+\/pages$/);
      if (settleMatch && init?.method === "POST") {
        // 另一种 422：跳页（不是词集漂移）→ 不应被特判
        throw Object.assign(new Error("页结算被拒绝：提交了未来的页"), {
          status: 409,
          code: "CONFLICT",
        });
      }
      throw new Error(`未预期的请求：${path}`);
    });

    const container = mount();
    await flush();
    await startSprint(container);

    for (let i = 0; i < 5; i += 1) flipAndJudge(container, i, "pass");
    await clickNext(container);

    expect(container.querySelector('[data-testid="hulu-error"]'), "非该码应仍走错误页").toBeTruthy();
  });
});
