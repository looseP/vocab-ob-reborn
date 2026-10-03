/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 新词编码卡（`EncodeCardView`）的 exam 三层接入测试。
 *
 * 背景：阶梯会话的新词首学卡此前**只有裸例句 H1**，没有复习卡上的
 * 「例句线索（轨色切分 + 语法角色）」与「训练扩展（译点·骨架）」——
 * 同一个词走不同模式看到的内容不一致。
 *
 * 设计约束（**本文件最要紧的断言**）：例句已经在 H1 步里出现过，
 * 所以接入 exam 时**绝不能把例句渲染两遍**。做法是让 H1 步改由
 * `ClueZone` 的 `analysis` 口径渲染（不遮盖），而不是在阶梯下再插一个线索区。
 *
 * 无 exam 数据时必须退回旧的朴素例句块（v1 批次零行为变化）。
 */

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

/** 可变的详情 mock：按用例塞不同 examples，逐条控制 exam 有无。 */
const { detailRef } = vi.hoisted(() => ({ detailRef: { current: null as unknown } }));
vi.mock("@/frontend/hooks/useWordDetail", () => ({
  useWordDetail: () => ({ word: detailRef.current, loading: false, error: null }),
}));

import { EncodeCardView } from "@/frontend/components/review/EncodeCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const EXAMPLE_TEXT = "Fish abound in the lake behind the old mill.";
const EXAMPLE_TRANSLATION = "老磨坊后的湖里鱼很多。";

// React 19 的 act 需要显式声明测试环境（同仓库其余 jsdom 测试的约定），
// 否则每个用例都会打一条 "not configured to support act(...)" 噪音。
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 三层俱全的 exam：主句 + 修饰（故「读主干」按钮会出现）。 */
const EXAM = {
  reading: {
    split: [
      "Fish abound in the lake",
      "behind the old mill",
      "where the water is still clear.",
    ],
    structure: "主句 + 地点状语 + 定语从句。",
    split_roles: [
      ["主句 · 主谓宾", "main"],
      ["地点状语", "mod"],
      ["定语从句", "mod"],
    ],
  },
  translation: {
    model: "老磨坊后的湖里鱼很多，那里的水依旧清澈。",
    key_points: [
      { tag: "固定搭配", text: "abound in", translation: "大量存在于", note: null },
    ],
  },
  writing: { pattern: "[主语] abound in [地点]", function: "说明文", usage: "描写", imitating_example: "Trees abound in the forest." },
};

function makeCard(word: Partial<ReviewCard["word"]> = {}): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "w1", slug: "abound", title: "Abound", lemma: "abound",
      short_definition: "大量存在", ipa: null, pos: null, cefr: null,
      examples: [{ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION }],
      mnemonic_text: "a+bound 多到冲破边界",
      ...word,
    },
    state: "new",
    dueAt: null,
    lastRating: null,
    reviewCount: 0,
    note_entries: [],
  };
}

// ── fake Web Speech：编码卡挂载即自动发音，不给 fake 会走真实分支 ──────────
class FakeUtterance {
  lang = "";
  rate = 1;
  voice: unknown = null;
  constructor(public text: string) {}
}

let synth: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getVoices: ReturnType<typeof vi.fn> };

beforeEach(() => {
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) };
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = synth;
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
  detailRef.current = null;
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  detailRef.current = null;
});

function render(card: ReviewCard): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(EncodeCardView, { card, onRate: vi.fn() })));
  });
  mounted.push({ root, container });
  return container;
}

/** 详情 mock：有/无 exam。 */
function withDetail(example: Record<string, unknown> | null) {
  detailRef.current = example ? { examples: [example] } : null;
}

describe("新词编码卡 · exam 三层接入", () => {
  it("有 exam 切分 → H1 步改由 ClueZone(analysis) 渲染，头部措辞不是「已遮盖」", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: EXAM });
    const c = render(makeCard());

    const zone = c.querySelector('[data-testid="clue-zone"]');
    expect(zone).not.toBeNull();
    expect(zone?.textContent).toContain("例句分析");
    // 编码卡全展开，写「目标词已遮盖」是假的
    expect(zone?.textContent).not.toContain("已遮盖");
  });

  it("analysis 口径不遮盖目标词（没有 clue-mask 节点）", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: EXAM, anchor: "abound" });
    const c = render(makeCard());
    expect(c.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(0);
  });

  it("**例句只渲染一遍** —— 接入不得造成 H1 与线索区重复", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: EXAM });
    const c = render(makeCard());
    // 例句片段在 DOM 中出现的次数
    const hits = (c.textContent ?? "").split("Fish abound in the lake").length - 1;
    expect(hits).toBe(1);
  });

  it("轨色切分与语法角色都摊开（复习卡的分析能力这里也有）", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: EXAM });
    const c = render(makeCard());
    const zone = c.querySelector('[data-testid="clue-zone"]')!;
    expect(zone.querySelectorAll('[data-testid="clue-split"] > li')).toHaveLength(3);
    expect(zone.textContent).toContain("主句 · 主谓宾");
    expect(zone.textContent).toContain("地点状语");
  });

  it("「读主干」按钮同样可用（含 mod 行时才渲染）", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: EXAM });
    const c = render(makeCard());
    const btn = c.querySelector<HTMLButtonElement>('[data-testid="clue-trunk-toggle"]');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("读主干");

    act(() => btn?.click());
    const zone = c.querySelector('[data-testid="clue-zone"]')!;
    expect(zone.querySelectorAll('[data-testid="clue-split"] > li')).toHaveLength(1);
    expect(btn?.textContent).toBe("显示全句");
  });

  it("译点与骨架：训练扩展折叠一并接入", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: EXAM });
    const c = render(makeCard());
    const fold = c.querySelector('[data-testid="training-fold"]');
    expect(fold).not.toBeNull();
    expect(fold?.textContent).toContain("译点");
    expect(fold?.textContent).toContain("abound in");
  });

  it("**无 exam 数据 → 退回旧观感**：不渲染线索区与训练扩展（v1 批次零行为变化）", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION });
    const c = render(makeCard());
    expect(c.querySelector('[data-testid="clue-zone"]')).toBeNull();
    expect(c.querySelector('[data-testid="training-fold"]')).toBeNull();
    expect(c.textContent).toContain(EXAMPLE_TEXT);
  });

  it("详情未到达（loading）→ 同样安静缺席，不留空壳", () => {
    withDetail(null);
    const c = render(makeCard());
    expect(c.querySelector('[data-testid="clue-zone"]')).toBeNull();
    expect(c.querySelector('[data-testid="training-fold"]')).toBeNull();
    expect(c.textContent).toContain(EXAMPLE_TEXT);
  });

  it("exam 形状脏（exam 非对象）→ 不崩，退回朴素例句", () => {
    withDetail({ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION, exam: "not-an-object" });
    const c = render(makeCard());
    expect(c.querySelector('[data-testid="clue-zone"]')).toBeNull();
    expect(c.textContent).toContain(EXAMPLE_TEXT);
  });

  it("无例句素材时整卡不渲染线索区（连 H1 都没有）", () => {
    withDetail({ exam: EXAM });
    const c = render(makeCard({ examples: [] }));
    expect(c.querySelector('[data-testid="clue-zone"]')).toBeNull();
  });
});
