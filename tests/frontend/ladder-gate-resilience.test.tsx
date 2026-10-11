/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 收尾轮补的会话层防线（2026-10-11 审查 P0-1 / P1-1 / P1-2 / P1-3）。
 *
 * 此前测试的 `beforeEach` 都 `localStorage.clear()`，导致额度计数恒为 0、闸门
 * 永不触发 —— 四条本该被锁住的路径全是测试盲区：
 *  - P0-1 冲刺按钮是死按钮（挂载 effect 依赖数组为空）
 *  - P1-1 闸门硬拦进行中的会话（整页替换做题界面）
 *  - P1-2 幂等重试后 submitError 残留 → 再点跳站
 *  - P1-3 Esc 重测 / Ctrl+Z 步退后重试条残留 → 丢词评分
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
vi.mock("@/frontend/hooks/useWordDetail", () => ({ useWordDetail: () => ({ word: null, loading: false, error: null }) }));

import { apiFetch } from "@/frontend/api/client";
import { LadderReviewSession } from "@/frontend/components/review/LadderReviewSession";
import { addDailyReviewedCount, writeDailyReviewLimit } from "@/frontend/utils/dailyReviewLimit";
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
    for (const m of mountedRoots.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function makeCard(progressId: string, lemma: string): ReviewCard {
  return {
    progressId,
    word: { id: `w-${progressId}`, slug: lemma, title: lemma, lemma, short_definition: `${lemma} 的释义`, ipa: null, pos: null, cefr: null },
    state: "review", dueAt: null, lastRating: "good", reviewCount: 3, ladderRung: 1, note_entries: [],
  } as unknown as ReviewCard;
}

function installApi(cards: ReviewCard[], opts: { failAnswer?: boolean; idempotent?: boolean } = {}) {
  let attempts = 0;
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/review/queue")) {
      return { items: cards, session: { id: "sess", mode: "review", cardsSeen: 0 }, stats: { total: cards.length, remaining: cards.length }, hasMore: false } as never;
    }
    if (path === "/review/answer") {
      attempts += 1;
      if (opts.failAnswer && attempts === 1) throw new Error("网络错误");
      return { ok: true, reviewLogId: `log-${attempts}`, ...(opts.idempotent ? { idempotent: true } : {}) } as never;
    }
    throw new Error("unexpected " + path);
  });
}

function mountLadder() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(LadderReviewSession, { onBack: vi.fn() }))); });
  mountedRoots.push({ root, container });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function typeInto(sel: string, text: string): void {
  const el = document.querySelector<HTMLInputElement>(sel);
  expect(el, `未找到输入框 ${sel}`).toBeTruthy();
  for (const ch of Array.from(text)) act(() => { el!.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })); });
}

async function rateCard(): Promise<void> {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((x) => (x.textContent ?? "").trim().startsWith("良好"));
  expect(b).toBeTruthy();
  await act(async () => { b!.click(); });
  await flush();
}

async function playR1ThroughDictation(lemma: string): Promise<void> {
  await rateCard();
  typeInto('[data-testid="follow-copy-input"]', lemma);
  await flush();
  typeInto('[data-testid="typing-dictation-input"]', lemma);
  await flush();
  await flush();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => (b.textContent ?? "").includes(label));
}

function dailyCountValue(): number {
  const k = Object.keys(window.localStorage).find((x) => x.startsWith("vocab-daily-reviewed:") && x.endsWith(":review"));
  return k ? Number(window.localStorage.getItem(k) ?? "0") : 0;
}

describe("P0-1：额度达标时冲刺按钮真的能拉起队列（不是死按钮）", () => {
  it("额度已满 → 拦截条 → 点冲刺 → 队列拉起、进入做题", async () => {
    // 复习上限设 2，并把今日复习计数顶到 2（达标）—— 挂载闸门命中
    writeDailyReviewLimit(2);
    addDailyReviewedCount(2, new Date(), "review");

    installApi([makeCard("p-a", "alpha"), makeCard("p-b", "bravo")]);
    mountLadder();
    await flush();

    // 挂载即命中闸门：渲染拦截条（不是假空态"没有待复习的单词"）
    expect(document.body.textContent).toContain("达到每日上限");
    expect(document.body.textContent).not.toContain("没有待复习的单词");

    // 点「冲刺」—— P0-1：依赖数组修复后 effect 重跑、队列真的拉起来
    const sprint = findButton("继续复习（冲刺）");
    expect(sprint, "冲刺按钮必须存在").toBeTruthy();
    await act(async () => { sprint!.click(); });
    await flush();
    await flush();

    // 进入做题界面（不再停在拦截条 / 假空态）
    expect(document.body.textContent).not.toContain("达到每日上限");
    expect(document.body.textContent).toMatch(/阶梯会话/);
  });
});

describe("P1-1：进行中达标不打断做题（软上限语义）", () => {
  it("本会话提交使计数达到上限 → 不整页替换为拦截条，徽标提示即可", async () => {
    // 上限设为 1，挂载时计数 0（不拦），第一词提交后计数 1 = 达标
    window.localStorage.setItem("vocab-daily-review-limit", "1");
    installApi([makeCard("p-a", "alpha")]);
    mountLadder();
    await flush();
    expect(document.body.textContent).toMatch(/阶梯会话/);

    await playR1ThroughDictation("alpha");
    // 提交成功后计数=1=达标。旧实现会整页换成拦截条（做题界面消失）；
    // 修复后只走结算页（completed）—— 关键是不出现"达到每日上限"整页拦截
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain("继续复习（冲刺）");
  });
});

describe("P1-2/P1-3：submitError 在步退/重测/幂等重试后必须清除", () => {
  it("提交失败后 Esc 重测：重试条消失（否则再点会走防御分支跳词、丢评分）", async () => {
    installApi([makeCard("p-a", "alpha")], { failAnswer: true });
    mountLadder();
    await flush();
    await playR1ThroughDictation("alpha");
    expect(findButton("重试提交")).toBeTruthy();

    // Esc 重测当前词（产出轮失败后 current 仍指向该词）
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush();

    // 重测后重试条必须消失（否则指向已清空 scratch 的词，再点会跳词）
    expect(findButton("重试提交"), "Esc 重测后重试条必须消失").toBeFalsy();
  });

  it("幂等重试成功后重试条清除（幂等分支 setSubmitError(null)）", async () => {
    // 单卡会话：提交失败 → 重试命中幂等 → completed → 结算页。
    // 关键断言：重试条消失（幂等分支必须 setSubmitError(null)，且渲染守卫
    // `submitError.visit === current` 在结算页 current=null 时也不成立）。
    let attempts = 0;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/review/queue")) {
        return { items: [makeCard("p-a", "alpha")], session: { id: "s", mode: "review", cardsSeen: 0 }, stats: { total: 1, remaining: 1 }, hasMore: false } as never;
      }
      if (path === "/review/answer") {
        attempts += 1;
        if (attempts === 1) throw new Error("超时");
        return { ok: true, reviewLogId: "log", idempotent: true } as never;
      }
      throw new Error("unexpected");
    });
    mountLadder();
    await flush();
    await playR1ThroughDictation("alpha");

    const retry = findButton("重试提交");
    expect(retry).toBeTruthy();
    await act(async () => { retry!.click(); });
    await flush();
    await flush();

    // 幂等命中后进入结算页，重试条必须消失
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeTruthy();
    expect(findButton("重试提交"), "幂等重试后重试条必须清除").toBeFalsy();
  });
});
