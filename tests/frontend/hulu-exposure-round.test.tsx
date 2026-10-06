/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 曝光轮前端交互测试（R12，2026-10-06）。
 *
 * 形状照 `hulu-session.test.tsx`：jsdom + `createRoot` + 受控 `apiFetch` mock
 * （按 path 分派），**不连库**。断言的五件事：
 *  1. 曝光轮**卡面直展**：无「翻开核对」按钮、无自认按钮（直展 = 无遮答无自认）；
 *  2. 顶栏标签「第 0 轮 · 首次曝光」，页脚「已曝光 n/n」（无通过率徽标）；
 *  3. 页结算提交 `{ pageIndex, passed: alive, total: alive }`（恒过闸，语义 = 已曝光）；
 *  4. **单卡路径零请求**：逐卡展示期间 apiFetch 调用次数不增长；
 *  5. 显式跳过：需一次确认（window.confirm），确认后 finish 第 0 轮 → 开第 1 轮。
 *
 * 另含创建表单的「包含还没复习过的词」开关（默认关、提交带 includeNewWords）
 * 与复习轮页首的「N 词在曝光轮未看过」提示。
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/frontend/api/wordbooks", () => ({
  getDefaultWordbook: vi.fn(async () => ({ id: "wb-1", name: "默认词书" })),
}));
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", { "data-testid": "markdown" }, props.content),
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
  vi.restoreAllMocks();
});

/** 造页载荷词卡（卡面字段给全，避免走降级路径的噪音）。 */
function makeItems(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w-${offset + i}`,
    slug: `word-${offset + i}`,
    title: `word-${offset + i}`,
    lemma: `word-${offset + i}`,
    ipa: null,
    pos: "n.",
    cefr: null,
    short_definition: `释义 ${offset + i}`,
    core_definitions: [],
    definition_md: `定义 ${offset + i}`,
    examples: [],
    prototype_text: null,
    mnemonic_text: null,
    mnemonic_type: null,
    semantic_chain: null,
  }));
}

interface RoundStub {
  id: string;
  round_no: number;
  kind: "exposure" | "recall" | "legacy";
  ended_at: string | null;
  elapsed_seconds: number | null;
  pages_passed: number;
  words_passed: number;
  words_total: number;
  word_set_fingerprint: string | null;
}

/**
 * 装一套受控的 apiFetch，模拟「含曝光轮的 v2 计划」。
 *
 * `wordsPassed` 模拟曝光轮已曝光词数（覆盖率缺口 = wordCount − wordsPassed）。
 */
function installApi(options: {
  pages: number;
  pageSize: number;
  /** 曝光轮是否已收尾（已收尾 → 下一次 startRound 回复习轮）。 */
  exposureFinished?: boolean;
  /** 曝光轮已曝光词数（默认 = 全部，即无缺口）。 */
  wordsPassed?: number;
  /** 曝光轮是否已存在（false → startRound 先开第 0 轮）。 */
  hasExposure?: boolean;
}) {
  const calls: string[] = [];
  const wordCount = options.pages * options.pageSize;
  const wordsPassed = options.wordsPassed ?? wordCount;
  // 可变：曝光轮「存在」是 startRound 的产物 —— 与真机一致（新建计划里没有轮）。
  let hasExposure = options.hasExposure ?? true;
  // 可变：finish(0) 之后曝光轮即收尾 —— 下一次 startRound 才会回复习轮
  // （服务端语义的桩：曝光轮是开复习轮 1 的前置）。
  let exposureFinished = options.exposureFinished ?? false;

  const exposureRound: RoundStub = {
    id: "round-0", round_no: 0, kind: "exposure",
    ended_at: exposureFinished ? "2026-10-06T00:30:00Z" : null,
    elapsed_seconds: exposureFinished ? 1800 : null,
    pages_passed: options.pages, words_passed: wordsPassed, words_total: wordCount,
    word_set_fingerprint: exposureFinished ? "fp-exposure" : null,
  };
  const recallRound: RoundStub = {
    id: "round-1", round_no: 1, kind: "recall",
    ended_at: null, elapsed_seconds: null,
    pages_passed: 0, words_passed: 0, words_total: wordCount,
    word_set_fingerprint: null,
  };

  let current: RoundStub | null = null;
  let pagesPassed = 0;
  const plan = {
    id: PLAN_ID, user_id: "u-1", wordbook_id: "wb-1", direction: null,
    exam_date: "2026-12-20", target_rounds: 4, page_size: options.pageSize,
    gate_ratio: 0.8, word_count: wordCount, status: "active",
    protocol_version: "v2", include_new_words: true,
    suspend_review: false, suspended_count: 0,
    started_at: "2026-10-06T00:00:00Z", ended_at: null, created_at: "2026-10-06T00:00:00Z",
  };

  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/hulu/plans" && init?.method === "POST") return plan as never;

    if (path === `/hulu/plans/${PLAN_ID}`) {
      // 已收尾的复习轮也要出现在 rounds 里（「每轮通过率」的数据源）——
      // current 反映本轮是否已 finish。
      const rounds: RoundStub[] = hasExposure ? [exposureRound] : [];
      if (current && current.kind === "recall") {
        rounds.push(current.ended_at !== null
          ? current
          : { ...current, pages_passed: pagesPassed });
      }
      return { plan, rounds } as never;
    }

    if (path === `/hulu/plans/${PLAN_ID}/rounds` && init?.method === "POST") {
      // 曝光轮未收尾 → 回曝光轮；已收尾 → 回复习轮（服务端语义的桩）
      if (hasExposure && !exposureFinished) {
        current = exposureRound;
        pagesPassed = 0;
      } else if (!hasExposure && !exposureFinished) {
        // 尚无曝光轮 → 先开第 0 轮（真机：v2 + includeNewWords 的前置）
        hasExposure = true;
        current = exposureRound;
        pagesPassed = 0;
      } else {
        current = { ...recallRound, pages_passed: pagesPassed };
      }
      return { ...current, pages_passed: pagesPassed } as never;
    }

    const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
    if (pageMatch) {
      const index = Number(pageMatch[1]);
      return {
        pageIndex: index, pages: options.pages,
        total: options.pageSize, alive: options.pageSize,
        items: makeItems(options.pageSize, index * options.pageSize),
      } as never;
    }

    const settleMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/\d+\/pages$/);
    if (settleMatch && init?.method === "POST") {
      pagesPassed += 1;
      // 曝光轮的 words_passed 由 wordsPassed 桩固定（缺口场景要它保持 0）；
      // 复习轮按页推进累加（每页全通过）。
      if (current && current.kind === "exposure") {
        return { ...current, pages_passed: pagesPassed } as never;
      }
      return { ...(current ?? recallRound), pages_passed: pagesPassed, words_passed: pagesPassed * options.pageSize } as never;
    }

    const finishMatch = path.match(/^\/hulu\/plans\/[^/]+\/rounds\/(\d+)\/finish$/);
    if (finishMatch && init?.method === "POST") {
      const roundNo = Number(finishMatch[1]);
      if (roundNo === 0) {
        hasExposure = true;
        exposureFinished = true;
        return { ...exposureRound, ended_at: "2026-10-06T00:30:00Z", elapsed_seconds: 1800 } as never;
      }
      // 复习轮收尾：current 落定收尾态（后续 GET /plans/:id 据此返回「每轮通过率」行）
      current = {
        ...recallRound, pages_passed: pagesPassed,
        ended_at: "2026-10-06T01:00:00Z", elapsed_seconds: 600,
        words_passed: pagesPassed,
      };
      return current as never;
    }

    throw new Error(`未预期的请求：${path}`);
  });

  return { calls, plan };
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

async function flush(times = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

/** 把本页所有卡翻开并自认「通过」（过闸所需；单卡路径零请求）。 */
function passAllCards(container: HTMLElement, count: number) {
  for (let index = 0; index < count; index += 1) {
    const flip = container.querySelector(`[data-testid="hulu-flip-${index}"]`) as HTMLButtonElement | null;
    if (flip) act(() => { flip.click(); });
    const pass = container.querySelector(`[data-testid="hulu-pass-${index}"]`) as HTMLButtonElement | null;
    expect(pass, `卡 ${index} 的通过按钮应存在`).toBeTruthy();
    act(() => { pass!.click(); });
  }
}

async function startSprint(container: HTMLElement) {
  const start = container.querySelector('[data-testid="hulu-start"]') as HTMLButtonElement;
  expect(start, "开始按钮应存在").toBeTruthy();
  await act(async () => { start.click(); });
  await flush();
}

describe("创建表单：包含还没复习过的词（R12）", () => {
  it("勾选框默认关，提交带 includeNewWords:false", async () => {
    installApi({ pages: 1, pageSize: 5 });
    const container = mount();
    await flush();

    const toggle = container.querySelector('[data-testid="hulu-include-new-toggle"]') as HTMLInputElement;
    expect(toggle, "「包含还没复习过的词」勾选框应存在").toBeTruthy();
    expect(toggle.checked).toBe(false);

    await startSprint(container);

    const createCall = apiFetchMock.mock.calls.find(([path, init]) =>
      path === "/hulu/plans" && (init as { method?: string } | undefined)?.method === "POST");
    expect(createCall, "应发创建请求").toBeTruthy();
    expect(JSON.parse((createCall![1] as { body: string }).body)).toMatchObject({
      includeNewWords: false,
    });
  });

  it("勾选后提交 includeNewWords:true", async () => {
    installApi({ pages: 1, pageSize: 5 });
    const container = mount();
    await flush();

    const toggle = container.querySelector('[data-testid="hulu-include-new-toggle"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(toggle.checked).toBe(true);

    await startSprint(container);

    const createCall = apiFetchMock.mock.calls.find(([path, init]) =>
      path === "/hulu/plans" && (init as { method?: string } | undefined)?.method === "POST");
    expect(JSON.parse((createCall![1] as { body: string }).body)).toMatchObject({
      includeNewWords: true,
    });
  });
});

describe("曝光轮：卡面直展（无遮答、无自认）", () => {
  it("无「翻开核对」按钮、无自认按钮，卡面内容直接可见", async () => {
    installApi({ pages: 1, pageSize: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    // 卡面直展：Tier0 短释直接渲染
    expect(container.querySelector('[data-testid="hulu-tier0-0"]')?.textContent).toContain("释义 0");
    // 无遮答按钮
    expect(container.querySelector('[data-testid="hulu-flip-0"]')).toBeNull();
    // 无自认按钮
    expect(container.querySelector('[data-testid="hulu-pass-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="hulu-miss-0"]')).toBeNull();
  });

  it("顶栏标「第 0 轮 · 首次曝光」，页脚「已曝光 n/n」，且不显示通过率/闸门徽标", async () => {
    installApi({ pages: 2, pageSize: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    expect(container.querySelector('[data-testid="hulu-progress"]')?.textContent).toContain("第 0 轮 · 首次曝光");
    expect(container.querySelector('[data-testid="hulu-exposure-rate"]')?.textContent).toContain("已曝光 5/5");
    // 曝光轮不发与闸门相关的 UI
    expect(container.querySelector('[data-testid="hulu-rate"]')).toBeNull();
    expect(container.textContent).not.toContain("闸门");
  });
});

describe("曝光轮：单卡路径零请求", () => {
  it("展示整页卡面期间 apiFetch 调用次数不增长", async () => {
    const { calls } = installApi({ pages: 1, pageSize: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    const before = calls.length;
    // 「逐卡展示」在曝光轮是纯渲染 —— 没有任何可点的卡级按钮，这里显式验证
    // 渲染稳定后不再发请求（页结算才发）。
    await flush(20);
    expect(calls.length).toBe(before);
  });

  it("页结算提交 { passed: alive, total: alive }（恒过闸，语义 = 已曝光）", async () => {
    const { calls } = installApi({ pages: 1, pageSize: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    // 末页 → 点「完成曝光」触发页结算
    const next = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
    expect(next.textContent).toContain("完成曝光");
    await act(async () => { next.click(); });
    await flush();

    const settle = apiFetchMock.mock.calls.find(([path, init]) =>
      String(path).endsWith("/pages") && (init as { method?: string } | undefined)?.method === "POST");
    expect(settle, "应发页结算请求").toBeTruthy();
    const body = JSON.parse((settle![1] as { body: string }).body);
    expect(body).toEqual({ pageIndex: 0, passed: 5, total: 5 });
    // 页结算确实发生了（calls 里有 POST …/pages）
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/pages"))).toBe(true);
  });
});

describe("曝光轮：显式跳过（需一次确认）", () => {
  it("取消确认 → 不发任何收尾/开轮请求", async () => {
    const { calls } = installApi({ pages: 2, pageSize: 5 });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const container = mount();
    await flush();
    await startSprint(container);

    const skip = container.querySelector('[data-testid="hulu-skip-exposure"]') as HTMLButtonElement;
    expect(skip, "「直接开始第 1 轮复习」按钮应存在").toBeTruthy();
    await act(async () => { skip.click(); });
    await flush();

    expect(confirmSpy).toHaveBeenCalled();
    expect(calls.some((call) => call.includes("/finish"))).toBe(false);
  });

  it("确认后 → finish 第 0 轮 → 开第 1 轮复习（进入复习轮 UI）", async () => {
    // 曝光轮未收尾：startRound 先回第 0 轮，跳过流程才走 finish(0) → startRound(1)
    installApi({ pages: 1, pageSize: 5 });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const container = mount();
    await flush();
    await startSprint(container);

    // 确认站在曝光轮上（有跳过按钮）
    const skip = container.querySelector('[data-testid="hulu-skip-exposure"]') as HTMLButtonElement;
    expect(skip, "「直接开始第 1 轮复习」按钮应存在").toBeTruthy();
    await act(async () => { skip.click(); });
    await flush();

    expect(confirmSpy).toHaveBeenCalled();
    const finishCall = apiFetchMock.mock.calls.find(([path, init]) =>
      String(path).endsWith("/rounds/0/finish") && (init as { method?: string } | undefined)?.method === "POST");
    expect(finishCall, "应对第 0 轮调 finish（不新增端点）").toBeTruthy();

    // 进入复习轮：出现遮答按钮与通过率徽标（曝光轮没有的东西）
    expect(container.querySelector('[data-testid="hulu-flip-0"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-rate"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hulu-progress"]')?.textContent).toContain("复习");
  });
});

describe("复习轮页首提示：N 词在曝光轮未看过（R12）", () => {
  it("曝光有缺口 → 显示提示，数字 = 定格词数 − 曝光轮已曝光数", async () => {
    // 2 页 × 5 词 = 10 词；曝光只过了 6 个 → 缺口 4
    installApi({ pages: 2, pageSize: 5, exposureFinished: true, wordsPassed: 6 });
    const container = mount();
    await flush();
    await startSprint(container);

    const hint = container.querySelector('[data-testid="hulu-unexposed-hint"]');
    expect(hint, "复习轮页首应有未曝光提示").toBeTruthy();
    expect(hint?.textContent).toContain("4");
    expect(hint?.textContent).toContain("未看过");
  });

  it("曝光无缺口（全部看过）→ 不显示提示", async () => {
    installApi({ pages: 1, pageSize: 5, exposureFinished: true, wordsPassed: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    expect(container.querySelector('[data-testid="hulu-unexposed-hint"]')).toBeNull();
  });

  it("真机回归：曝光轮**本轮才开出来**（进入前 rounds 为空）时，提示仍要出现", async () => {
    // 真机复测抓到的缺陷：enterPlan 拿到的 rounds 是「开轮之前」的快照 ——
    // 新建计划里根本没有曝光轮，不把刚开出的轮并进 state，缺口就恒为 0，
    // 提示永远不显示。这里让 GET /plans/:id 在开轮前回空 rounds。
    installApi({ pages: 2, pageSize: 5, hasExposure: false, wordsPassed: 0 });
    const container = mount();
    await flush();
    await startSprint(container);

    // 曝光轮当场开出（第 0 轮直展）——先跳过它
    expect(container.querySelector('[data-testid="hulu-exposure-rate"]'), "应先进曝光轮").toBeTruthy();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      (container.querySelector('[data-testid="hulu-skip-exposure"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(confirmSpy).toHaveBeenCalled();

    // 进入复习轮：曝光轮 words_passed=0 → 缺口 = 全部 10 词
    const hint = container.querySelector('[data-testid="hulu-unexposed-hint"]');
    expect(hint, "本轮才开出的曝光轮也必须计入缺口").toBeTruthy();
    expect(hint?.textContent).toContain("10");
  });
});

describe("计划页：曝光覆盖率与指标分档（R14）", () => {
  it("曝光覆盖率徽章 + 首次曝光耗时单行（注明不计入对比）+ FAQ", async () => {
    // 1 页 × 5 词 = 5 词；曝光过了 3 个 → 徽章「曝光 3/5」，缺口 2
    installApi({ pages: 1, pageSize: 5, exposureFinished: true, wordsPassed: 3 });
    const container = mount();
    await flush();
    await startSprint(container);

    // planOverview 在「收尾页 / 计划页」渲染 —— 先过闸（全卡自认通过），再走完本轮
    passAllCards(container, 5);
    const next = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
    await act(async () => { next.click(); });
    await flush();

    const coverage = container.querySelector('[data-testid="hulu-exposure-coverage"]');
    expect(coverage, "曝光覆盖率徽章应存在").toBeTruthy();
    expect(coverage?.textContent).toContain("曝光 3/5");

    const elapsed = container.querySelector('[data-testid="hulu-exposure-elapsed"]');
    expect(elapsed, "首次曝光耗时行应存在").toBeTruthy();
    expect(elapsed?.textContent).toContain("首次曝光耗时");
    // 必须注明不计入缩时对比
    expect(elapsed?.textContent).toContain("不计入缩时对比");

    // FAQ：首次回忆成功率为何不展示（R14）
    const faq = container.querySelector('[data-testid="hulu-metrics-faq"]');
    expect(faq, "指标 FAQ 应存在").toBeTruthy();
    expect(faq?.textContent).toContain("首次回忆成功率");
  });

  it("每轮通过率按「过闸页自认通过数 ÷ 定格词数」表述（R14 口径修正）", async () => {
    installApi({ pages: 1, pageSize: 5, exposureFinished: true, wordsPassed: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    passAllCards(container, 5);
    const next = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
    await act(async () => { next.click(); });
    await flush();

    const rates = container.querySelector('[data-testid="hulu-round-pass-rates"]');
    expect(rates, "每轮通过率区块应存在").toBeTruthy();
    expect(rates?.textContent).toContain("过闸页自认通过");
    expect(rates?.textContent).toContain("定格");
    // 口径说明：不是逐词掌握结果
    expect(rates?.textContent).toContain("不是逐词掌握结果");
  });

  it("曝光轮不进「每轮通过率」栏（它的语义是覆盖率，另有徽章）", async () => {
    installApi({ pages: 1, pageSize: 5, exposureFinished: true, wordsPassed: 5 });
    const container = mount();
    await flush();
    await startSprint(container);

    passAllCards(container, 5);
    const next = container.querySelector('[data-testid="hulu-next"]') as HTMLButtonElement;
    await act(async () => { next.click(); });
    await flush();

    expect(container.querySelector('[data-testid="hulu-round-rate-0"]')).toBeNull();
  });
});
