/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * EncodeCardView 新词编码卡组件测试（ADR-0036 LW-2）：
 * - 自动逐级展开全部可用提示（缺失级自动跳过）；
 * - isSpoiler 剧透级不出现；
 * - 「我认识」→ easy / 翻卡后自评回调。
 */

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));
vi.mock("@/frontend/hooks/useWordDetail", () => ({
  useWordDetail: () => ({ word: null, loading: false, error: null }),
}));

import { EncodeCardView } from "@/frontend/components/review/EncodeCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
});

function makeCard(word: Partial<ReviewCard["word"]> = {}): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "w1", slug: "slug", title: "Abound", lemma: "abound",
      short_definition: "大量存在", ipa: null, pos: null, cefr: null,
      ...word,
    },
    state: "new",
    dueAt: null,
    lastRating: null,
    reviewCount: 0,
    note_entries: [],
  };
}

function mount(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, ui));
  });
  mountedRoots.push({ root, container });
}

describe("EncodeCardView（新词 T3 初见编码卡）", () => {
  it("自动逐级展开全部提示（例句 + 助记锚），缺失级不出现", () => {
    mount(createElement(EncodeCardView, {
      card: makeCard({
        examples: [{ text: "Fish abound in the lake.", translation: "湖里鱼很多" }],
        mnemonic_text: "a+bound 多到冲破边界",
      }),
      onRate: vi.fn(),
    }));
    expect(screen.getByText("H1 例句")).toBeTruthy();
    expect(screen.getByText("H3 助记锚")).toBeTruthy();
    expect(screen.queryByText("H1′ 语义链")).toBeNull();
    expect(screen.queryByText("H2 原型")).toBeNull();
  });

  it("isSpoiler 级跳过：原型文本含释义中文串时不展示 H2", () => {
    mount(createElement(EncodeCardView, {
      card: makeCard({
        examples: [{ text: "Fish abound here." }],
        prototype_text: "数量**大量存在**的画面",
      }),
      onRate: vi.fn(),
    }));
    expect(screen.queryByText("H2 原型")).toBeNull();
  });

  it("「我认识」直接回调 easy（不看释义）", () => {
    const onRate = vi.fn();
    mount(createElement(EncodeCardView, { card: makeCard(), onRate }));
    act(() => {
      fireEvent.click(screen.getByText("我认识"));
    });
    expect(onRate).toHaveBeenCalledWith("easy");
  });

  it("「初见（难）」需先看释义（H4 翻卡解锁）", () => {
    const onRate = vi.fn();
    mount(createElement(EncodeCardView, { card: makeCard({ short_definition: "大量存在" }), onRate }));
    const hardBtn = screen.getByText("初见（难）").closest("button") as HTMLButtonElement;
    expect(hardBtn.disabled).toBe(true);
    act(() => {
      fireEvent.click(screen.getByText("看释义（H4）"));
    });
    expect(screen.getByText("大量存在")).toBeTruthy();
    expect((screen.getByText("初见（难）").closest("button") as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      fireEvent.click(screen.getByText("初见（难）"));
    });
    expect(onRate).toHaveBeenCalledWith("hard");
  });
});
