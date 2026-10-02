/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 阶梯会话容错：原地重测（Esc）与游标步退（Ctrl+Z）（2026-10-02）。
 *
 * 缺陷背景：阶梯会话此前**完全没有撤销/重来手段** —— 跟写打错一个键只能一路
 * 打到底（wrongTimes 只增不减直接压低最终评分），产出轮默写崩了也没有第二次
 * 机会，用户唯一的出路是退出会话重来（丢掉整轮进度）。
 *
 * 本文件锁住：
 * - `retryCurrentWord`：清掉本词 scratch + 递增 retryNonce → 子视图**干净重挂载**
 *   （输入框回来、错键计数归零），且不产生任何网络请求（纯内存重置）；
 * - `stepBack`：pos > 0 时回退一格并清目标词暂存，让上一词进入重做流程；
 *   pos === 0 时是无副作用的空操作；
 * - 快捷键挂载：Esc → 重测本词，Ctrl/Cmd+Z → 步退；
 * - **防双写**：重做已提交过的词复用原幂等键，服务端幂等命中时不追加结算行
 *   （否则同一会话内同一词会被 FSRS 调度两次）。
 *
 * 会话访问顺序（sessionScheduler.buildLadderSession，两词 rung=1，轮内交替）：
 *   alpha:card → bravo:card → bravo:follow → alpha:follow → bravo:dictation → alpha:dictation
 * 注意同词各 pass 并不相邻（拍板⑥ no-back-to-back-same-word），断言必须按此顺序。
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));
vi.mock("@/frontend/hooks/useWordDetail", () => ({
  useWordDetail: () => ({ word: null, loading: false, error: null }),
}));

import { apiFetch } from "@/frontend/api/client";
import { LadderReviewSession } from "@/frontend/components/review/LadderReviewSession";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const apiFetchMock = vi.mocked(apiFetch);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  apiFetchMock.mockReset();
  addToastMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function makeCard(progressId: string, lemma: string): ReviewCard {
  return {
    progressId,
    word: {
      id: `w-${progressId}`, slug: lemma, title: lemma, lemma,
      short_definition: `${lemma} 的释义`, ipa: null, pos: null, cefr: null,
    },
    state: "review", dueAt: null, lastRating: "good", reviewCount: 3,
    ladderRung: 1, note_entries: [],
  } as unknown as ReviewCard;
}

function installApi(cards: ReviewCard[], opts: { answerIdempotent?: boolean } = {}) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/review/queue")) {
      return {
        items: cards,
        session: { id: "sess-ladder", mode: "review", cardsSeen: 0 },
        stats: { total: cards.length, remaining: cards.length },
        hasMore: false,
      } as never;
    }
    if (path === "/review/answer") {
      return {
        ok: true,
        reviewLogId: "log-ladder-1",
        ...(opts.answerIdempotent ? { idempotent: true } : {}),
      } as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });
}

function mountLadder() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    // ReviewCardView 内部用 <Link>，需 Router 上下文
    root.render(createElement(MemoryRouter, null, createElement(LadderReviewSession, { onBack: vi.fn() })));
  });
  mountedRoots.push({ root, container });
  return container;
}

/** 冲刷挂载后的队列拉取、visits 构建与异步评分回调。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 输入框内逐字键入（与真实用户键入路径一致）。 */
function typeInto(selector: string, text: string): void {
  const el = document.querySelector<HTMLInputElement>(selector);
  expect(el, `未找到输入框 ${selector}`).toBeTruthy();
  for (const ch of Array.from(text)) {
    act(() => {
      el!.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    });
  }
}

function pressWindowKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * 评分按钮文本是「标签 + 快捷键数字」（例如「良好3」「重来1」），
 * 故用前缀匹配而非全等，避免把热键数字当成评分名的一部分。
 *
 * 必须 await：卡面评分先 `await commitQuickNote()` 再回调，需冲刷微任务队列
 * 才能观察到下一 stage 的 DOM。
 */
async function rateCard(rating: "重来" | "困难" | "良好" | "轻松"): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent ?? "").trim().startsWith(rating),
  );
  expect(button, `未找到评分按钮「${rating}」`).toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await flush();
}

const FOLLOW_INPUT = '[data-testid="follow-copy-input"]';
const DICT_INPUT = '[data-testid="typing-dictation-input"]';

/** 当前 stage：follow / dictation / meaning / card。 */
function currentStage(): "follow" | "dictation" | "meaning" | "card" {
  if (document.querySelector('[data-testid="follow-copy-view"]')) return "follow";
  if (document.querySelector('[data-testid="typing-dictation-view"]')) return "dictation";
  if (document.querySelector('[data-testid="meaning-review"]')) return "meaning";
  return "card";
}

/** 当前卡面的词（两词用例下按文本区分足够）。 */
function currentLemma(): "alpha" | "bravo" {
  return (document.body.textContent ?? "").includes("alpha") ? "alpha" : "bravo";
}

/** 进度徽标（「n / m」）。 */
function progressBadge(): string {
  const texts = Array.from(document.querySelectorAll("span")).map((s) => s.textContent?.trim() ?? "");
  return texts.find((t) => /^\d+\s*\/\s*\d+$/.test(t)) ?? "";
}

/** 跟写视图当前错键数（从提示文案里取）。 */
function wrongKeyText(): string {
  return (document.body.textContent ?? "").match(/错键 \d+/)?.[0] ?? "";
}

function answerBodies(): Array<{ progressId: string; idempotencyKey: string }> {
  return apiFetchMock.mock.calls
    .filter(([path]) => path === "/review/answer")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as { progressId: string; idempotencyKey: string });
}

function answerCalls(): number {
  return apiFetchMock.mock.calls.filter(([path]) => path === "/review/answer").length;
}

describe("阶梯会话容错：原地重测（Esc）", () => {
  it("巩固轮跟写中按 Esc：清空已键入进度与错键、视图重挂载、不发任何请求", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();

    // alpha 单词语会话：card → follow → dictation
    await rateCard("良好");
    expect(currentStage(), "未进入巩固轮跟写视图").toBe("follow");

    typeInto(FOLLOW_INPUT, "zz");
    typeInto(FOLLOW_INPUT, "a");
    expect(wrongKeyText()).toBe("错键 2");

    const callsBefore = apiFetchMock.mock.calls.length;

    pressWindowKey("Escape");

    // 重挂载：错键归零、输入框回来且可用、进度未推进
    expect(wrongKeyText()).toBe("错键 0");
    const freshInput = document.querySelector<HTMLInputElement>(FOLLOW_INPUT);
    expect(freshInput, "重测后输入框消失（组件未重挂载）").toBeTruthy();
    expect(freshInput!.disabled).toBe(false);
    // 纯前端重置：不发任何网络请求（尤其不能 POST /review/answer）
    expect(apiFetchMock.mock.calls.length).toBe(callsBefore);
    expect(answerCalls()).toBe(0);
    expect(addToastMock).toHaveBeenCalledWith("info", "已重置本词，请重新作答");
  });

  it("重测后可以正常重新作答并推进（不是死锁）", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();
    await rateCard("良好");

    pressWindowKey("Escape");
    typeInto(FOLLOW_INPUT, "zz");
    pressWindowKey("Escape");
    expect(wrongKeyText()).toBe("错键 0");

    // 重置后完整键入 → 正常进入产出轮默写
    typeInto(FOLLOW_INPUT, "alpha");
    expect(currentStage(), "重测后无法推进到产出轮").toBe("dictation");
  });

  it("按钮入口与 Esc 等价（顶栏「重测本词」）", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();
    await rateCard("良好");

    typeInto(FOLLOW_INPUT, "zz");
    expect(wrongKeyText()).toBe("错键 2");

    const retryButton = document.querySelector<HTMLButtonElement>('[data-testid="ladder-retry-word"]');
    expect(retryButton, "顶栏缺少重测本词按钮").toBeTruthy();
    act(() => retryButton!.click());

    expect(wrongKeyText()).toBe("错键 0");
  });
});

describe("阶梯会话容错：游标步退（Ctrl+Z）", () => {
  it("pos > 0 时步退：游标回退一格、回到上一词并进入重做流程", async () => {
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")]);
    mountLadder();
    await flush();

    // 访问顺序：alpha:card → bravo:card → ...
    expect(progressBadge()).toBe("1 / 6");
    expect(currentLemma()).toBe("alpha");

    await rateCard("良好");
    expect(progressBadge()).toBe("2 / 6");
    expect(currentLemma()).toBe("bravo");

    // Ctrl+Z 步退：回到上一词（alpha 卡面 = 重新作答起点）
    pressWindowKey("z", { ctrlKey: true });
    expect(progressBadge()).toBe("1 / 6");
    expect(currentLemma()).toBe("alpha");
    expect(currentStage()).toBe("card");
    expect(addToastMock).toHaveBeenCalledWith("info", expect.stringContaining("已退回"));

    // 重做链路可用：再次评分能正常前进
    await rateCard("良好");
    expect(progressBadge()).toBe("2 / 6");
  });

  it("Cmd+Z 与 Ctrl+Z 等价", async () => {
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")]);
    mountLadder();
    await flush();
    await rateCard("良好");
    expect(progressBadge()).toBe("2 / 6");

    pressWindowKey("z", { metaKey: true });
    expect(progressBadge()).toBe("1 / 6");
  });

  it("pos === 0 时步退是无副作用空操作（不越界、不弹提示）", async () => {
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")]);
    mountLadder();
    await flush();

    expect(progressBadge()).toBe("1 / 6");
    addToastMock.mockClear();

    pressWindowKey("z", { ctrlKey: true });

    expect(progressBadge()).toBe("1 / 6");
    expect(addToastMock).not.toHaveBeenCalledWith("info", expect.stringContaining("已退回"));
  });

  it("顶栏「上一词」按钮在首词禁用，前进后可用且点击生效", async () => {
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")]);
    mountLadder();
    await flush();

    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="ladder-step-back"]')!.disabled,
      "首词时上一词按钮应禁用",
    ).toBe(true);

    await rateCard("良好");

    // 重新取节点：换卡后 React 可能已替换该 DOM 实例
    const back = document.querySelector<HTMLButtonElement>('[data-testid="ladder-step-back"]');
    expect(back!.disabled, "前进后上一词按钮应可用").toBe(false);

    act(() => back!.click());
    expect(progressBadge()).toBe("1 / 6");
  });
});

describe("阶梯会话容错：重做已提交的词不重复调度", () => {
  /**
   * 关键数据安全断言：步退/重测会让**已提交**的词再走一遍产出轮。
   * 若重做时换新幂等键，服务端会当成第二次真实作答 → 同一会话内同一词被
   * FSRS 调度两次（review_count 双计）。复用原 key 让服务端幂等拦截。
   */
  it("产出轮提交后步退重做：复用同一幂等键，且提示仅作练习", async () => {
    // 两词会话：bravo 的产出轮落在第 5/6 个访问位（会话未结束），步退才可触发。
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")], { answerIdempotent: true });
    mountLadder();
    await flush();

    // 访问顺序：alpha:card → bravo:card → bravo:follow → alpha:follow → bravo:dictation → alpha:dictation
    await rateCard("良好"); // alpha:card
    await rateCard("良好"); // bravo:card
    typeInto(FOLLOW_INPUT, "bravo"); // bravo:follow
    typeInto(FOLLOW_INPUT, "alpha"); // alpha:follow
    expect(currentStage()).toBe("dictation");
    expect(currentLemma()).toBe("bravo");

    typeInto(DICT_INPUT, "bravo"); // bravo:dictation → 提交
    await flush();

    expect(answerBodies()).toHaveLength(1);
    const first = answerBodies()[0];

    // 步退回 bravo 的产出轮（pos-1）
    pressWindowKey("z", { ctrlKey: true });
    expect(currentStage(), "步退未回到产出轮重做").toBe("dictation");
    expect(currentLemma()).toBe("bravo");

    typeInto(DICT_INPUT, "bravo");
    await flush();

    expect(answerBodies()).toHaveLength(2);
    const second = answerBodies()[1];

    // 同一词重做复用同一幂等键 → 服务端识别为重复请求，不二次调度
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.progressId).toBe(first.progressId);
    expect(addToastMock).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("已提交过，本次重做仅作练习"),
    );
  });

  it("首次提交（非幂等）时正常计入结算、不出现「仅作练习」提示", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();

    await rateCard("良好");
    typeInto(FOLLOW_INPUT, "alpha");
    typeInto(DICT_INPUT, "alpha");
    await flush();

    expect(answerBodies()).toHaveLength(1);
    expect(addToastMock).not.toHaveBeenCalledWith(
      "info",
      expect.stringContaining("本次重做仅作练习"),
    );
  });

  /**
   * 幂等键必须落 localStorage：刷新后若重建为空 Map，重做同一词会换新 key，
   * 服务端认不出重复 → 二次调度（正是本组断言要防的洞）。
   */
  it("提交幂等键随会话缓存落盘，刷新恢复后重做仍复用同一 key", async () => {
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")], { answerIdempotent: true });
    mountLadder();
    await flush();

    await rateCard("良好");
    await rateCard("良好");
    typeInto(FOLLOW_INPUT, "bravo");
    typeInto(FOLLOW_INPUT, "alpha");
    typeInto(DICT_INPUT, "bravo");
    await flush();

    expect(answerBodies()).toHaveLength(1);
    const submittedKey = answerBodies()[0].idempotencyKey;

    // 缓存必须写在 localStorage，且带上 submitKeys
    const raw = window.localStorage.getItem("vocab:review:ladder:review");
    expect(raw, "阶梯会话缓存未落 localStorage").toBeTruthy();
    const parsed = JSON.parse(raw!) as { submitKeys?: Array<[string, string]> };
    expect(parsed.submitKeys).toEqual([["p-bravo", submittedKey]]);
    expect(window.sessionStorage.getItem("vocab:review:ladder:review")).toBeNull();

    // 重开浏览器：新挂载从缓存恢复（含 submitKeys）。
    // 提交 bravo 后游标已推进到 alpha:dictation，故先步退回 bravo 的产出轮。
    act(() => {
      for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
    });
    document.body.innerHTML = "";
    mountLadder();
    await flush();

    expect(currentStage()).toBe("dictation");
    expect(currentLemma()).toBe("alpha");

    pressWindowKey("z", { ctrlKey: true });
    expect(currentLemma(), "步退未回到已提交的 bravo").toBe("bravo");

    typeInto(DICT_INPUT, "bravo");
    await flush();

    expect(answerBodies()).toHaveLength(2);
    expect(answerBodies()[1].idempotencyKey).toBe(submittedKey);
  });
});
