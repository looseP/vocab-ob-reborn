/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 阶梯会话的双通道接线（2026-10-10，ADR-0036 §4 再次修订）。
 *
 * 背景：阶梯自 2026-10-10 起由「显式模式」改回「双通道开关」——到期复习/学新词
 * 两个大卡片各带一个 toggle（ladderSettings），开关开启时对应入口进
 * `LadderReviewSession` 的对应通道。`channel` prop 随之引入，本文件锁住它的
 * 通道语义，防止「学新词走了阶梯却还在复习通道里」这类串台回归：
 *
 *  1. `channel="learn"` ⇒ startReview("learn") ⇒ /review/queue 带 `channel=new`；
 *  2. `/review/answer` 提交 `mode: "learn"`（服务端按 mode 分桶计数）；
 *  3. 每日计数入账 **learn 桶**（`vocab-daily-reviewed:*:learn`）——新词额度
 *     不被架空；review 桶不得出现；
 *  4. 整场缓存写 `vocab:review:ladder:learn`，与 review 通道的 `:review` 键隔离；
 *  5. 默认 channel（review）行为不回退：mode/cacheKey/计数桶全是 review 口径；
 *  6. learn 通道空态文案是「没有待学的新词」，不是复习口径。
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
import type { LadderChannel } from "@/frontend/utils/ladderSettings";

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

/** 学新词通道的卡：state="new" ⇒ rung=1 起步档含 card-encode（「我认识…」首学认知，无评分按钮）。 */
function makeNewCard(progressId: string, lemma: string): ReviewCard {
  return {
    progressId,
    word: {
      id: `w-${progressId}`, slug: lemma, title: lemma, lemma,
      short_definition: `${lemma} 的释义`, ipa: null, pos: null, cefr: null,
    },
    state: "new", dueAt: null, lastRating: null, reviewCount: 0,
    ladderRung: 1, note_entries: [],
  } as unknown as ReviewCard;
}

/** 复习通道的卡：state="review" ⇒ rung=1 起步档是标准评分卡（重来/困难/良好/轻松）。 */
function makeReviewCard(progressId: string, lemma: string): ReviewCard {
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

function installApi(cards: ReviewCard[]) {
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
      return { ok: true, reviewLogId: "log-ladder-1" } as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });
}

function mountLadder(channel: LadderChannel) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(LadderReviewSession, { channel, onBack: vi.fn() })));
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

/** card-encode 首学认知按钮（新词 rung=1 起步档的第一站，无评分按钮）。 */
async function ackEncode(label: "我认识" | "有印象" | "初见（难）"): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  expect(button, `未找到首学认知按钮「${label}」`).toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await flush();
}

const FOLLOW_INPUT = '[data-testid="follow-copy-input"]';
const DICT_INPUT = '[data-testid="typing-dictation-input"]';

function answerBodies(): Array<{ progressId: string; mode?: string }> {
  return apiFetchMock.mock.calls
    .filter(([path]) => path === "/review/answer")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as { progressId: string; mode?: string });
}

/** 每日计数桶的实际落键（不猜时区实现，直接从存储键反查）。 */
function dailyCountKeys(): string[] {
  return Object.keys(window.localStorage).filter((k) => k.startsWith("vocab-daily-reviewed:"));
}

/**
 * 走完单词语会话（复习通道卡）：card(评分) → follow(跟写) → dictation(默写=最终提交)。
 * 新词卡的第一站是 card-encode（ackEncode），复习卡的第一站是评分卡（rateCard）。
 */
async function playSingleWordThrough(lemma: string): Promise<void> {
  await rateCard("良好");
  typeInto(FOLLOW_INPUT, lemma);
  await flush();
  typeInto(DICT_INPUT, lemma);
  await flush();
  await flush();
}

describe("阶梯会话 learn 通道（学新词的阶梯开关接线）", () => {
  it("拉队列走 new 通道，answer 提交 mode=learn，计数与缓存全部落 learn 桶", async () => {
    installApi([makeNewCard("p-alpha", "alpha")]);
    mountLadder("learn");
    await flush();

    // 1. startReview("learn") ⇒ /review/queue 带 channel=new
    const queueCall = apiFetchMock.mock.calls.find(([p]) => p.startsWith("/review/queue"));
    expect(queueCall, "未发起队列请求").toBeTruthy();
    expect(String(queueCall![0])).toContain("channel=new");

    // 2. 新词第一站是 card-encode 首学认知（无评分按钮）——确认 learn 队列出的新词
    //    走「我认识 → 跟写 → 默写」的 R1 编码档，ack 后（会话进行中）缓存落在
    //    learn 通道键，不碰 review 键
    await ackEncode("我认识");
    expect(document.querySelector(FOLLOW_INPUT), "未进入巩固轮跟写").toBeTruthy();
    expect(window.localStorage.getItem("vocab:review:ladder:learn")).toBeTruthy();
    expect(window.localStorage.getItem("vocab:review:ladder:review")).toBeNull();

    // 3. 走完会话：answer mode=learn（首评随产出轮一并提交）
    typeInto(FOLLOW_INPUT, "alpha");
    await flush();
    typeInto(DICT_INPUT, "alpha");
    await flush();
    await flush();
    const answers = answerBodies();
    expect(answers).toHaveLength(1);
    expect(answers[0].mode).toBe("learn");

    // 4. 每日计数入账 learn 桶且仅 learn 桶（新词额度不被架空）
    const keys = dailyCountKeys();
    expect(keys, "每日计数应恰好一个桶").toHaveLength(1);
    expect(keys[0]).toMatch(/:learn$/);
    expect(window.localStorage.getItem(keys[0])).toBe("1");

    // 5. 结算出现（学新词口径标题）
    expect(document.body.textContent).toContain("学新词 · 阶梯会话结算");
  });

  it("learn 徽标按新词口径显示今日计数", async () => {
    installApi([makeNewCard("p-alpha", "alpha")]);
    mountLadder("learn");
    await flush();
    // 默认新词上限 20（SettingsPage 同口径），徽标带 /上限
    expect(document.body.textContent).toContain("今日新词 0/20");
    // 首学认知（card-encode）不计数 —— 首评随产出轮提交时才入账（每词恰一次）
    await ackEncode("我认识");
    expect(document.body.textContent).toContain("今日新词 0/20");
    typeInto(FOLLOW_INPUT, "alpha");
    await flush();
    typeInto(DICT_INPUT, "alpha");
    await flush();
    await flush();
    expect(document.body.textContent).toContain("今日新词 1/20");
    // review 通道口径的徽标不得出现
    expect(document.body.textContent).not.toContain("今日复习");
  });

  it("learn 通道空队列时给学新词口径的空态文案", async () => {
    installApi([]);
    mountLadder("learn");
    await flush();
    expect(document.body.textContent).toContain("没有待学的新词");
  });
});

describe("阶梯会话 review 通道（默认，防回归）", () => {
  it("channel 缺省即 review：队列走 review 通道、answer mode=review、计数与缓存落 review 桶", async () => {
    installApi([makeReviewCard("p-alpha", "alpha")]);
    // 不传 channel —— 兼容既有调用方（显式入口/旧缓存恢复路径）
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(LadderReviewSession, { onBack: vi.fn() })));
    });
    mountedRoots.push({ root, container });
    await flush();

    const queueCall = apiFetchMock.mock.calls.find(([p]) => p.startsWith("/review/queue"));
    expect(String(queueCall![0])).toContain("channel=review");
    expect(String(queueCall![0])).not.toContain("channel=new");

    await playSingleWordThrough("alpha");

    const answers = answerBodies();
    expect(answers).toHaveLength(1);
    expect(answers[0].mode).toBe("review");

    const keys = dailyCountKeys();
    expect(keys, "每日计数应恰好一个桶").toHaveLength(1);
    expect(keys[0]).toMatch(/:review$/);
  });
});
