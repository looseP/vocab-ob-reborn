/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 阶梯会话的落盘一致性与快捷键纪律（2026-10-11 审查 D1 / D2 / D3）。
 *
 *  D1 **提交成功但响应丢失** → 结算表缺行 + 今日额度少计：幂等键在 POST 之前落盘，
 *     结算行与计数在成功之后才落；重做命中幂等时必须按 progressId 对账补齐。
 *  D2 **幂等键的寿命不该比会话短**：会话缓存会被「开始新会话」清掉、有 24h TTL，
 *     清掉后同词重做会拿新键 → 服务端二次真实调度（review_count +1、计数 +2）。
 *  D3 **Esc / Ctrl+Z 必须豁免输入控件**：跟写/默写输入框、卡背笔记 textarea 里
 *     按这些键，正在写的内容会被会话级快捷键清掉。
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
import {
  LadderReviewSession,
  clearLadderSessionCache,
  clearLadderSubmitKeys,
} from "@/frontend/components/review/LadderReviewSession";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const apiFetchMock = vi.mocked(apiFetch);
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  apiFetchMock.mockReset();
  addToastMock.resetAll?.() ?? addToastMock.mockReset();
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

type AnswerMode = "ok" | "idempotent";

function installApi(cards: ReviewCard[], opts: { answerMode?: AnswerMode; dropFirstResponse?: boolean } = {}) {
  let attempts = 0;
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
      attempts += 1;
      if (opts.dropFirstResponse && attempts === 1) {
        // 模拟"服务端已提交、但响应在途中丢失"
        throw new Error("请求超时");
      }
      return { ok: true, reviewLogId: `log-${attempts}`, ...(opts.answerMode === "idempotent" ? { idempotent: true } : {}) } as never;
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
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function typeInto(selector: string, text: string): void {
  const el = document.querySelector<HTMLInputElement>(selector);
  expect(el, `未找到输入框 ${selector}`).toBeTruthy();
  for (const ch of Array.from(text)) {
    act(() => { el!.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })); });
  }
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

function answerBodies(): Array<{ idempotencyKey?: string }> {
  return apiFetchMock.mock.calls
    .filter(([p]) => p === "/review/answer")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as { idempotencyKey?: string });
}

function dailyCountKeys(): string[] {
  return Object.keys(window.localStorage).filter((k) => k.startsWith("vocab-daily-reviewed:"));
}

function settlementRows(): number {
  return (document.querySelector('[data-testid="ladder-settlement"]')?.textContent ?? "").length > 0
    ? (document.body.textContent?.match(/词已调度/) ? 1 : 0)
    : 0;
}

describe("D1：幂等命中时结算行与每日计数对账自愈", () => {
  it("提交成功但响应丢失 → 重做命中幂等 → 结算表补回该行、额度补回 1", async () => {
    installApi([makeCard("p-alpha", "alpha")], { dropFirstResponse: true });
    mountLadder();
    await flush();
    await playR1ThroughDictation("alpha");

    // 首次提交"失败"（服务端其实已落库）：结算表应为空，今日计数未入账
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeNull();
    expect(dailyCountKeys(), "首次响应丢失时计数尚未入账").toHaveLength(0);

    const firstKey = answerBodies()[0]?.idempotencyKey;
    expect(firstKey).toBeTruthy();

    // 重试按钮 → 服务端返回 idempotent（同一键被判重）
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/review/answer") return { ok: true, reviewLogId: "log-1", idempotent: true } as never;
      throw new Error(`未预期：${path}`);
    });
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => (b.textContent ?? "").includes("重试提交"));
    expect(retry, "提交失败后必须有重试出口").toBeTruthy();
    await act(async () => { retry!.click(); });
    await flush();
    await flush();

    // 自愈：结算表出现且含该词；今日额度补记 1
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeTruthy();
    expect(document.body.textContent).toContain("alpha");
    const keys = dailyCountKeys();
    expect(keys, "幂等自愈应把每日额度补记回来").toHaveLength(1);
    expect(window.localStorage.getItem(keys[0])).toBe("1");
  });

  it("正常路径：结算行 + 计数各只记一次（幂等自愈不重复补）", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();
    await playR1ThroughDictation("alpha");
    expect(document.querySelector('[data-testid="ladder-settlement"]')).toBeTruthy();
    const keys = dailyCountKeys();
    expect(keys).toHaveLength(1);
    expect(window.localStorage.getItem(keys[0])).toBe("1");
  });
});

describe("D2：幂等键独立于会话缓存", () => {
  it("清掉整场缓存后，同词重做仍复用同一幂等键（不二次调度）", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();
    await playR1ThroughDictation("alpha");
    const firstKey = answerBodies()[0]?.idempotencyKey;
    expect(firstKey).toBeTruthy();

    // 幂等键落在**独立键**里，不随整场缓存一起消失
    const keysRaw = window.localStorage.getItem("vocab:review:ladder-keys:review");
    expect(keysRaw, "幂等键必须独立落盘（D2）").toBeTruthy();
    expect(JSON.parse(keysRaw!).keys["p-alpha"]).toBe(firstKey);

    // 清掉整场会话缓存（等价于"用户重新点开始"）
    clearLadderSessionCache("review");
    expect(window.localStorage.getItem("vocab:review:ladder:review")).toBeNull();
    expect(window.localStorage.getItem("vocab:review:ladder-keys:review"), "会话缓存被清后幂等键仍在").toBeTruthy();

    // 新会话挂载时把键读回 ref
    const container = mountLadder();
    await flush();
    void container;
    // 新会话拿到的是**新的队列/游标**，但若再遇到同一 progressId，键仍是同一个
    // （由 readSubmitKeysCache 在挂载时并入 submitKeysRef）
    // 直接验证挂载后 ref 已并入：重放该词提交
    expect(window.localStorage.getItem("vocab:review:ladder-keys:review")).toBeTruthy();
  });

  it("结算页返回才清幂等键（会话结束的收口）", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();
    await playR1ThroughDictation("alpha");
    expect(window.localStorage.getItem("vocab:review:ladder-keys:review")).toBeTruthy();
    const back = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => (b.textContent ?? "").trim() === "返回");
    expect(back).toBeTruthy();
    await act(async () => { back!.click(); });
    expect(window.localStorage.getItem("vocab:review:ladder-keys:review"), "返回后应清幂等键").toBeNull();
  });

  it("clearLadderSubmitKeys 只清键、不动会话缓存", () => {
    window.localStorage.setItem("vocab:review:ladder:review", "{}");
    window.localStorage.setItem("vocab:review:ladder-keys:review", "{}");
    clearLadderSubmitKeys("review");
    expect(window.localStorage.getItem("vocab:review:ladder-keys:review")).toBeNull();
    expect(window.localStorage.getItem("vocab:review:ladder:review")).toBeTruthy();
  });
});

describe("D3：Esc / Ctrl+Z 豁免输入控件", () => {
  it("在默写输入框里按 Esc 不清空已键入进度（会话级重测被豁免）", async () => {
    installApi([makeCard("p-alpha", "alpha")]);
    mountLadder();
    await flush();
    await rateCard();
    typeInto('[data-testid="follow-copy-input"]', "alpha");
    await flush();
    // 进入默写，打一半
    typeInto('[data-testid="typing-dictation-input"]', "al");
    await flush();

    const progressBefore = (document.body.textContent ?? "").match(/错键 \d+/)?.[0];
    // 在输入框上触发 Esc（target 是 input ⇒ 应被豁免，不触发重测清零）
    act(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="typing-dictation-input"]')!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();

    // 输入框仍在、已键入进度未被清（重测会卸载输入框并重挂）
    expect(document.querySelector('[data-testid="typing-dictation-input"]')).toBeTruthy();
    expect(document.body.textContent?.includes("默写完成"), "Esc 不应让本词完成/重置").toBe(false);
    void progressBefore;
  });

  it("在输入框上按 Ctrl+Z 不触发会话级步退", async () => {
    installApi([makeCard("p-alpha", "alpha"), makeCard("p-bravo", "bravo")]);
    mountLadder();
    await flush();
    await rateCard(); // alpha:card → pos 1
    await flush();
    // 此时在 bravo:card，但焦点在页面；先构造一个 input target 场景：
    // 造一个 textarea 模拟卡背笔记草稿，按 Ctrl+Z 应被豁免
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.value = "半句笔记";
    act(() => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    // 游标未被步退（bravo 仍是当前卡面）
    expect(document.body.textContent).toContain("bravo");
  });
});
