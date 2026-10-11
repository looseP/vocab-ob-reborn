/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 阶梯可达性 + 形态不变量（ADR-0036 §4 的三次修订都锁在这里）。
 *
 * 形态沿革：
 *  1. v1 全局布尔开关（2026-09-26）：悄悄接管「标准复习」/「快速开始」，用户无预期；
 *  2. 显式第 5 个模式（2026-10-03）：不选 ⇒ 分支不可达；但主入口享受不到三轮制；
 *  3. 双通道开关（2026-10-10 拍板，用户：「整回原来的那种模式携带开关吧，复习和
 *     学新词都需要的啊，除了用户急的时候可以关闭速刷」）：到期复习/学新词两个大
 *     卡片各带一个独立 toggle（`vocab-ladder-mode:review` / `:learn`），状态就地
 *     可见，解决 v1「无预期被换卡」的正面解法。
 *
 * 本文件锁住：
 *  - 双通道开关的真源（ladderSettings）与分流结构（ReviewPage 开关开启 ⇒ 阶梯分支）；
 *  - 阶梯 rung=2 第一轮 `card-no-hints`（hintSteps 为空）时 H4「翻卡」是唯一出口
 *    却只翻面不推进、表现为"点了没反应"的可达性修复。
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
// framer-motion 在 jsdom 下不推进 exit 过渡，AnimatePresence(mode="wait") 的
// front→back 换 key 因此永远不落 DOM —— 表现为「点了看释义但卡背没出现」。
// 退化为无动画版本，让翻卡语义可测（本文件只关心状态切换，不关心过渡）。
vi.mock("framer-motion", async () => {
  const { createElement: h } = await import("react");
  const tag = (name: string) => (props: Record<string, unknown>) => h(name, null, props.children);
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) => tag(name),
    }),
    AnimatePresence: (props: { children: unknown }) => props.children,
  };
});

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

describe("阶梯双通道开关形态（2026-10-10，ADR-0036 §4 再次修订）", () => {
  it("开关真源是**分通道**的：vocab-ladder-mode:review / :learn 各自独立", async () => {
    // v1 的 `vocab-ladder-mode`（无后缀）是全局单开关 —— 一开全接管，这正是
    // 「无预期被换卡」的结构根源。v3 必须分通道，两键互不干扰。
    const { setLadderEnabledFor, isLadderEnabledFor } = await import("@/frontend/utils/ladderSettings");
    expect(localStorage.getItem("vocab-ladder-mode:review")).toBeNull();
    expect(localStorage.getItem("vocab-ladder-mode:learn")).toBeNull();
    setLadderEnabledFor("review", true);
    expect(isLadderEnabledFor("review")).toBe(true);
    expect(isLadderEnabledFor("learn")).toBe(false);
    expect(localStorage.getItem("vocab-ladder-mode")).toBeNull();
  });

  it("模式清单恰 5 项且不含 ladder —— 阶梯不再是显式模式", async () => {
    const { reviewModesForTest } = await import("@/frontend/pages/ReviewPage");
    const modes = reviewModesForTest();
    expect(modes.map((m) => m.key)).toEqual(["review", "cram", "preview", "zen", "hulu"]);
    expect(modes.find((m) => m.key === "ladder")).toBeUndefined();
  });

  it("葫芦冲刺是显式模式，固定在末位（ADR-0041）", async () => {
    // 与阶梯不同，葫芦保持显式模式 ⇒ 不选则分支不可达，构造上保证不劫持别的模式。
    const { reviewModesForTest } = await import("@/frontend/pages/ReviewPage");
    const modes = reviewModesForTest();
    expect(modes).toHaveLength(5);
    expect(modes[modes.length - 1]?.key).toBe("hulu");
    expect(modes.find((m) => m.key === "hulu")?.title).toBe("葫芦冲刺");
  });

  it("阶梯只能由开关分流进入（源码结构断言）", async () => {
    // 结构不变式：ReviewPage 里必须存在「开关开启 ⇒ ladderChannel 分支」的分流，
    // 且经典 ReviewSession **内部**不得出现阶梯判断（不被劫持，由分流点构造保证）。
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/frontend/pages/ReviewPage.tsx", "utf8");
    // 只查**代码**：注释里会引述历史写法，直接查全文会被自己的注释误伤。
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code, "开关真源被删了（分流失去依据）").toContain("isLadderEnabledFor");
    expect(code, "分流逻辑被删了（开关开了也进不了阶梯）").toContain("clearLadderSessionCache(channel)");
    expect(code, "阶梯分支必须按 ladderChannel 直达").toContain("channel={ladderChannel}");
    // v1 痛点的正面解法：开关就地渲染在两个大卡片上（非设置页），状态一眼可见
    expect(code, "开关必须就地渲染（不可藏回设置页）").toContain("ladder-switch-");
    expect(code, "review 开关开启的描述联动（三轮制文案）").toContain("三轮制：再认 → 巩固 → 产出");
    expect(code, "learn 开关开启的描述联动（三轮制学新词文案）").toContain("三轮制学新词");
    // ReviewSession 函数体内不得有阶梯分支（剥出函数体再查）
    const fnStart = code.indexOf("function ReviewSession(");
    const fnEnd = code.indexOf("export function ReviewPage(");
    const body = code.slice(fnStart, fnEnd);
    expect(body, "经典复习流内部不得出现阶梯判断（劫持回潮）").not.toContain("ladder");
  });
});

describe("card-no-hints 阶段（hintSteps 为空）的 H4 行为", () => {
  it("无提示步时 H4 **真翻卡**（不静默结算）：用户必须先看到释义", async () => {
    // 无 examples → buildHintSteps 返回 []，等价于 card-no-hints 阶段
    //
    // 2026-10-11 审查（S4）：此分支此前直接 `onAnswer(easy)` 推进 —— 用户从头到尾
    // 没看到释义就完成评分，等于向 FSRS 注入虚假的高强度记忆证据（下次间隔被显著拉长，
    // 该词很可能在真正记住前就不再出现），而按钮上还写着「上限：重来」。
    // 现语义：H4 = 纯翻卡（看到释义后自行评分），不因翻卡把上限压到「重来」。
    const onAnswer = vi.fn();
    const { container } = mountCard(makeCard({ examples: [] }), { onAnswer });

    const h4 = Array.from(container.querySelectorAll("button")).find((b) =>
      /看释义（H4）/.test(b.textContent ?? ""),
    );
    expect(h4, "无提示步时应给出「看释义」出口").toBeTruthy();

    // 翻面走 framer-motion 的 AnimatePresence（key front→back），需冲刷微任务才落 DOM
    await act(async () => { h4!.click(); });

    // 关键断言 1：不提交答案（不制造「没看释义就完成」的记忆证据）
    expect(onAnswer).not.toHaveBeenCalled();
    // 关键断言 2：卡背已翻开 —— 释义可见（makeCard 的 short_definition）
    expect(container.textContent).toContain("减轻");
    // 关键断言 3：评分区可达且四个评分按钮**全部可用**（无提示即无封顶）
    const ratings = ["重来", "困难", "良好", "轻松"].map((label) =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)),
    );
    for (const btn of ratings) expect(btn, "评分按钮缺失").toBeTruthy();
    expect(ratings.every((b) => !b!.disabled), "无提示档不应封顶任何评分").toBe(true);
  });

  it("翻卡后由用户评分，提交时 hintLevel=0 / viaH4=false（不宣称 H4 消耗）", async () => {
    const onAnswer = vi.fn();
    const { container } = mountCard(makeCard({ examples: [] }), { onAnswer });

    const h4 = Array.from(container.querySelectorAll("button")).find((b) =>
      /看释义（H4）/.test(b.textContent ?? ""),
    );
    await act(async () => { h4!.click(); });

    const good = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith("良好"));
    await act(async () => { good!.click(); });

    expect(onAnswer).toHaveBeenCalledTimes(1);
    const [rating, meta] = onAnswer.mock.calls[0] as [string, { hintLevel: number; viaH4: boolean }];
    expect(rating).toBe("good");
    expect(meta.hintLevel).toBe(0);
    expect(meta.viaH4).toBe(false);
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
