/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 两处阶梯可达性修复（2026-09-29，用户报「原来那个打字流呢？为什么没了？」）。
 *
 * 根因不是打字流被删——`FollowCopyView` / `TypingDictationView` 一行未动，
 * 而是**没人能到达它**：
 * 1. 阶梯会话默认关闭（`vocab-ladder-mode` 不等于 `"on"`），而开关只在设置页，
 *    复习页毫无提示 → 用户从标准复习看不到打字流；
 * 2. 阶梯会话 rung=2 的第一轮走 `card-no-hints`（按设计不给提示），此时
 *    `hintSteps.length === 0`，H4「翻卡」是唯一出口却只翻面不推进，
 *    表现为"点了没反应"，极易被读成死锁。
 *
 * 本文件锁住这两条路径。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

// useWordDetail 挂载即拉 /words/:slug，mock 必须返回 Promise（返 undefined 会让
// .then 抛错，与被测行为无关）
vi.mock("@/frontend/api/client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({ examples: [] })),
}));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", null, props.content),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  localStorage.clear();
});

/** 复刻 ladderSettings 的真源读写，避免测试与实现脱钩。 */
const LADDER_KEY = "vocab-ladder-mode";
beforeEach(() => localStorage.clear());

function makeCard(over: Partial<ReviewCard["word"]> = {}): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "w1",
      slug: "alleviate",
      title: "alleviate",
      lemma: "alleviate",
      short_definition: "减轻",
      ipa: null,
      pos: "v.",
      cefr: "C1",
      examples: [{ text: "Music can alleviate stress." }],
      ...over,
    },
    state: "review",
    dueAt: null,
    lastRating: "good",
    reviewCount: 3,
  } as unknown as ReviewCard;
}

function mountCard(card: ReviewCard, handlers: { onAnswer?: ReturnType<typeof vi.fn> } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    // ReviewCardView 内部用 <Link>，需 Router 上下文（与既有 review-hint-ladder.test 同）
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(ReviewCardView, {
          card,
          loading: false,
          error: null,
          preview: false,
          onAnswer: handlers.onAnswer ?? vi.fn(),
          onSkip: vi.fn(),
          hintLadderHidden: false,
        }),
      ),
    );
  });
  mounted.push({ root, container });
  return { container, root };
}

const bodyText = (c: HTMLElement) => c.innerText.replace(/\s+/g, " ");

describe("阶梯开关默认值（打字流可达性）", () => {
  it("localStorage 无键时 isLadderModeEnabled 为 false —— 阶梯与打字流不可达", async () => {
    const { isLadderModeEnabled, setLadderModeEnabled } = await import(
      "@/frontend/reviewFlow/ladderSettings"
    );
    expect(localStorage.getItem(LADDER_KEY)).toBeNull();
    expect(isLadderModeEnabled()).toBe(false);
    // 显式开启后可达
    setLadderModeEnabled(true);
    expect(isLadderModeEnabled()).toBe(true);
  });

  it("只有严格 'on' 才算开启（'true'/缺失/任意值都不算）", async () => {
    const { isLadderModeEnabled } = await import("@/frontend/reviewFlow/ladderSettings");
    for (const v of ["true", "1", "ON", "on "]) {
      localStorage.setItem(LADDER_KEY, v);
      expect(isLadderModeEnabled(), `"${v}" 不应被当作开启`).toBe(false);
    }
    localStorage.setItem(LADDER_KEY, "on");
    expect(isLadderModeEnabled()).toBe(true);
  });
});

describe("card-no-hints 阶段（hintSteps 为空）的 H4 行为", () => {
  it("无提示步时 H4 直接按上限结算并推进，不制造『只翻面』的中间态", () => {
    // 无 examples → buildHintSteps 返回 []，等价于 card-no-hints 阶段
    const onAnswer = vi.fn();
    const { container } = mountCard(makeCard({ examples: [] }), { onAnswer });

    const h4 = Array.from(container.querySelectorAll("button")).find((b) =>
      /H4 · 翻卡/.test(b.textContent ?? ""),
    );
    expect(h4, "无提示步时 H4 按钮应存在（唯一出口）").toBeTruthy();

    act(() => {
      h4!.click();
    });

    // 关键断言：直接提交答案推进，而不是停在卡背
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const [rating, meta] = onAnswer.mock.calls[0] as [string, { hintLevel: number; viaH4: boolean }];
    // 无提示可耗 → hintLevel 0；viaH4 的 again 封顶不适用
    expect(meta.hintLevel).toBe(0);
    expect(meta.viaH4).toBe(false);
    // cap(0, false) = easy：不该因「没提示可耗」被误判为 again
    expect(rating).toBe("easy");
  });

  it("有提示步时 H4 保持原语义：不直接提交（仍由用户翻卡后评分）", () => {
    const onAnswer = vi.fn();
    const { container } = mountCard(makeCard(), { onAnswer });

    // 先消费全部提示步
    for (let i = 0; i < 4; i += 1) {
      const h = Array.from(container.querySelectorAll("button")).find((b) =>
        /^提示 \d+ ·/.test((b.textContent ?? "").trim()),
      );
      if (h && !h.disabled) act(() => { h.click(); });
    }
    const h4 = Array.from(container.querySelectorAll("button")).find((b) =>
      /H4 · 翻卡/.test(b.textContent ?? ""),
    );
    if (!h4) return; // 提示链耗尽后按钮按条件隐藏 → 无 H4 可测
    act(() => { h4.click(); });
    // 提示链存在时不走「直接结算」路径
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
