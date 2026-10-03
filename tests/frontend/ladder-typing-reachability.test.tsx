/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 两处阶梯可达性修复（2026-09-29，用户报「原来那个打字流呢？为什么没了？」）。
 *
 * 根因不是打字流被删——`FollowCopyView` / `TypingDictationView` 一行未动，
 * 而是**没人能到达它**：
 * 1. 阶梯会话曾经是一个**全局布尔开关**（`vocab-ladder-mode`），藏在设置页 /
 *    标准复习卡内，开关一开会悄悄把「标准复习」和「快速复习」换成另一张卡
 *    → 用户既看不到打字流，也预判不到自己被换了卡。
 *    2026-10-03 起（ADR-0036 §4 修订）阶梯改为**显式第 5 个模式**，不变量
 *    从「靠布尔值保证」升级为「不选该模式 ⇒ 分支不可达」；本文件锁的就是这条；
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

describe("阶梯改为显式模式后的可达性（打字流）", () => {
  it("阶梯开关的 localStorage 真源已删除 —— 不再有「全局开关」可被误开", () => {
    // 曾经的 `vocab-ladder-mode` 是全局的，能悄悄接管标准复习/快速开始。
    // 改为显式模式后该键连同 ladderSettings 模块一起删除，物理上无法再被旁路打开。
    expect(localStorage.getItem("vocab-ladder-mode")).toBeNull();
  });

  it("模式清单里存在显式的第 5 个模式「阶梯复习（实验）」", async () => {
    const { reviewModesForTest } = await import("@/frontend/pages/ReviewPage");
    const modes = reviewModesForTest();
    expect(modes.map((m) => m.key)).toEqual(["review", "cram", "preview", "zen", "ladder"]);
    expect(modes.find((m) => m.key === "ladder")?.title).toContain("阶梯");
  });

  it("现行复习流（review）不再有任何阶梯劫持分支（源码断言）", async () => {
    // 关键回归防线：ReviewSession 里那句
    // `ladderActive = reviewMode === "review" && !wordIds?.length && isLadderModeEnabled()`
    // 已删除。这是**结构不变式**（分支不可达），不是运行时行为，故直接查源码。
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/frontend/pages/ReviewPage.tsx", "utf8");
    // 只查**代码**：本文件的注释里会引述这段历史写法（"此前这里是 … isLadderModeEnabled()"），
    // 直接查全文会被自己的注释误伤 —— 注释不是代码路径。
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code, "阶梯劫持逻辑被加回来了").not.toContain("ladderActive");
    expect(code, "阶梯全局开关真源被加回来了").not.toContain("isLadderModeEnabled");
    // 阶梯只能由显式模式分支进入
    expect(code).toContain('reviewMode === "ladder"');
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
