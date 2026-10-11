/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 阶梯会话的两处会话层健壮性（2026-10-11 审查 B2 / S2）。
 *
 * 两者都发生在**产出轮末**（唯一 POST 的时刻），此前都会把整场会话变成死局：
 *
 *  1. **B2 提交失败无出口**：`submitWordAnswer` catch 后只 toast 并停在原地，而
 *     `TypingDictationView` 此刻已 `finished=true` ⇒ 输入框卸载、档位按钮全禁，
 *     **没有任何按钮能再次触发提交**；用户丢失已完成的默写结果，只能整词重打
 *     （必然再次失败）。本文件锁住：失败后必须渲染「重试提交」出口，且重试
 *     **复用原幂等键**（首次若其实已落库，服务端命中幂等 ⇒ 不二次调度）。
 *  2. **S2 meaning 复核被静默丢弃**：`setVisits`（R3 词追加词义卡复核）与
 *     `advance()` 同批次时，旧 `advance` 闭包里的 `visits.length` 是追加前的值
 *     ⇒ `next >= 旧长度` 成立 ⇒ 提前 completed ⇒ 队尾的复核站永不出现。
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
});

function makeCard(progressId: string, lemma: string, rung: number): ReviewCard {
  return {
    progressId,
    word: {
      id: `w-${progressId}`, slug: lemma, title: lemma, lemma,
      short_definition: `${lemma} 的释义`, ipa: null, pos: null, cefr: null,
    },
    state: "review", dueAt: null, lastRating: "good", reviewCount: 3,
    ladderRung: rung, note_entries: [],
  } as unknown as ReviewCard;
}

function installApi(cards: ReviewCard[], opts: { failFirstAnswer?: boolean } = {}) {
  let answerAttempts = 0;
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
      answerAttempts += 1;
      if (opts.failFirstAnswer && answerAttempts === 1) {
        throw new Error("网络错误：请求超时");
      }
      return { ok: true, reviewLogId: `log-${answerAttempts}` } as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });
}

function mountLadder() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(LadderReviewSession, { onBack: vi.fn() })));
  });
  mountedRoots.push({ root, container });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function typeInto(selector: string, text: string): void {
  const el = document.querySelector<HTMLInputElement>(selector);
  expect(el, `未找到输入框 ${selector}`).toBeTruthy();
  for (const ch of Array.from(text)) {
    act(() => {
      el!.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    });
  }
}

async function rateCard(rating: "重来" | "困难" | "良好" | "轻松"): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent ?? "").trim().startsWith(rating),
  );
  expect(button, `未找到评分按钮「${rating}」`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
}

function answerBodies(): Array<{ idempotencyKey?: string }> {
  return apiFetchMock.mock.calls
    .filter(([path]) => path === "/review/answer")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as { idempotencyKey?: string });
}

/** R1 词走完整三轮（评分 → 跟写 → 默写），默写完成即触发 submitWordAnswer。 */
async function playThroughDictation(lemma: string): Promise<void> {
  await rateCard("良好");
  typeInto('[data-testid="follow-copy-input"]', lemma);
  await flush();
  typeInto('[data-testid="typing-dictation-input"]', lemma);
  await flush();
  await flush();
}

/** R3 词按调度只进产出轮，第一站就是默写视图（无卡面/巩固轮）。 */
async function playR3Dictation(lemma: string): Promise<void> {
  typeInto('[data-testid="typing-dictation-input"]', lemma);
  await flush();
  await flush();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  );
}

describe("B2：提交失败后必须有可重试出口", () => {
  it("首提失败 → 渲染重试按钮 → 重试复用同一幂等键并成功推进", async () => {
    installApi([makeCard("p-alpha", "alpha", 1)], { failFirstAnswer: true });
    mountLadder();
    await flush();

    await playThroughDictation("alpha");

    // 失败后：会话停在当前词（未推进到结算），且出现重试出口
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeNull();
    const retry = findButton("重试提交");
    expect(retry, "提交失败后必须提供重试出口，否则产出轮无任何可点控件（死锁）").toBeTruthy();
    expect(document.body.textContent).toContain("评分提交失败");

    const firstKey = answerBodies()[0]?.idempotencyKey;
    expect(firstKey, "首次提交应带幂等键").toBeTruthy();

    await act(async () => { retry!.click(); });
    await flush();
    await flush();

    // 重试复用同一幂等键（首次若其实已落库 → 服务端命中幂等不二次调度）
    const bodies = answerBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].idempotencyKey).toBe(firstKey);

    // 成功后错误出口消失、进入结算页
    expect(findButton("重试提交")).toBeFalsy();
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeTruthy();
  });
});

describe("S2：队尾 R3 词的词义卡复核不被静默丢弃", () => {
  it("R3 词产出轮提交后，meaning 复核站会真正出现（completed 不提前置真）", async () => {
    // R3 词按调度只进产出轮，因此它是队列的**最后一站** —— 旧实现在这里提前
    // setCompleted(true)，追加进 visits 的 meaning 站永不渲染。
    installApi([makeCard("p-r3", "zulu", 3)]);
    mountLadder();
    await flush();

    expect(document.body.textContent, "R3 词第一站应是产出轮").toContain("产出轮");

    await playR3Dictation("zulu");

    // 未完成：词义复核徽标可见（meaning stage 的专属徽标）
    expect(document.body.textContent).toContain("词义卡复核（无调度语义）");
    expect(document.querySelector('[data-testid="meaning-review"]')).toBeTruthy();
    // 且不误跳结算页
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeNull();

    // 复核站无调度语义：点「下一个」式的评分不产生第二次 answer
    const answersBefore = answerBodies().length;
    const good = findButton("良好");
    await act(async () => { good!.click(); });
    await flush();
    expect(answerBodies().length, "词义复核不得再次提交 answer").toBe(answersBefore);
    // 复核完才进结算
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeTruthy();
  });
});
