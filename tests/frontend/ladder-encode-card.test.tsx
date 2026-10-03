/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * EncodeCardView 新词编码卡组件测试（ADR-0036 LW-2）：
 * - 自动逐级展开全部可用提示（缺失级自动跳过）；
 * - isSpoiler 剧透级不出现；
 * - 「我认识」→ easy / 翻卡后自评回调。
 *
 * 声学（Phase 1 补齐）：
 * - 挂载自动发音、声学胶囊（发音 + 口音）、H1 例句朗读、快捷键 R / Shift+R / E；
 * - 真实 `speech.ts` 不 mock —— 用 fake `window.speechSynthesis` 驱动，顺带把
 *   utterance 的 text / lang / rate 一起验了（只打桩 hook 只能验"函数被调用"，
 *   验不到"播放中再按 E 是否真打断"这类状态联动）。
 */

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
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

import { EncodeCardView } from "@/frontend/components/review/EncodeCardView";
import { SENTENCE_RATE } from "@/frontend/reviewFlow/speech";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const EXAMPLE_TEXT = "Fish abound in the lake behind the old mill.";
const EXAMPLE_TRANSLATION = "老磨坊后的湖里鱼很多。";

// ── fake Web Speech：真实 speech.ts 直接跑在它上面 ──────────────────────────
class FakeUtterance {
  lang = "";
  rate = 1;
  voice: unknown = null;
  constructor(public text: string) {}
}

interface FakeSynth {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getVoices: ReturnType<typeof vi.fn>;
}

let synth: FakeSynth;

function utterances(): FakeUtterance[] {
  return synth.speak.mock.calls.map((call) => call[0] as FakeUtterance);
}

function texts(): string[] {
  return utterances().map((u) => u.text);
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) };
  Reflect.set(window, "speechSynthesis", synth);
  Reflect.set(window, "SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "speechSynthesis");
  Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
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

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
  });
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
    expect(screen.getByText("H3 助记锚")).toBeTruthy();
    // H1 标签随 2026-09-29 的语义变更（wordcard-mock 移植）从「H1 例句」改为
    // 「H1 揭示词形」：首学编码卡复用同一条提示阶梯，标签随之更新。
    expect(screen.getByText("H1 揭示词形")).toBeTruthy();
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

describe("EncodeCardView 声学层（新词初见：自动发音 / 胶囊 / 例句 / 快捷键）", () => {
  it("挂载即自动朗读当前词一次（首发音印象），卸载时掐断", () => {
    mountedContainer();
    expect(texts()).toEqual(["abound"]);

    // 卸载必须停声：否则离开该卡后耳机里还在念（幽灵音轨）
    const cancelsBefore = synth.cancel.mock.calls.length;
    act(() => {
      mountedRoots.splice(0).forEach((m) => m.root.unmount());
    });
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
  });

  it("声学胶囊：发音按钮与口音徽标齐备，点击分别触发朗读与切口音", () => {
    const container = mountedContainer();
    const anchor = container.querySelector('[data-testid="acoustic-sticky-anchor"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toContain("abound");

    const playBtn = container.querySelector<HTMLButtonElement>('button[aria-label="朗读发音 (R)"]');
    const accentBtn = container.querySelector('[data-testid="accent-toggle"]');
    expect(playBtn).not.toBeNull();
    expect(accentBtn?.getAttribute("aria-label")).toBe("当前美音，切换到英音");

    const before = texts().length;
    act(() => playBtn?.click());
    expect(texts()).toHaveLength(before + 1);
    expect(texts().at(-1)).toBe("abound");

    act(() => (container.querySelector('[data-testid="accent-toggle"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="accent-toggle"]')?.getAttribute("aria-label")).toBe(
      "当前英音，切换到美音",
    );
  });

  it("H1 例句步渲染「听例句」按钮，点击朗读该长句（rate 走例句口径）", () => {
    const container = mountedContainer({ examples: [{ text: EXAMPLE_TEXT, translation: EXAMPLE_TRANSLATION }] });
    const button = container.querySelector<HTMLButtonElement>('[data-testid="encode-play-example"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("朗读例句 (E)");

    act(() => button?.click());

    expect(texts().at(-1)).toBe(EXAMPLE_TEXT);
    expect(utterances().at(-1)?.rate).toBe(SENTENCE_RATE);
    // 播放中按钮反馈
    expect(container.querySelector('[data-testid="encode-play-example"]')?.textContent).toContain("播放中");
  });

  it("无例句素材时不渲染「听例句」按钮（不留死按钮）", () => {
    const container = mountedContainer({ mnemonic_text: "a+bound 多到冲破边界" });
    expect(container.querySelector('[data-testid="encode-play-example"]')).toBeNull();
    // 无例句时胶囊提示不谎报 E 可用
    expect(container.querySelector('[data-testid="acoustic-sticky-anchor"]')?.textContent).toContain("R 拼读");
    expect(container.querySelector('[data-testid="acoustic-sticky-anchor"]')?.textContent).not.toContain("E 例句");
  });

  it("快捷键 R 朗读单词、Shift+R 切口音（口音开关在发音上也生效）", () => {
    const container = mountedContainer();

    pressKey("r");
    expect(texts()).toHaveLength(2);
    expect(texts().at(-1)).toBe("abound");
    expect(utterances().at(-1)?.lang).toBe("en-US");

    pressKey("r", { shiftKey: true });
    expect(container.querySelector('[data-testid="accent-toggle"]')?.getAttribute("aria-label")).toBe(
      "当前英音，切换到美音",
    );
    // Shift+R 只切口音，不该顺带发声
    expect(texts()).toHaveLength(2);

    pressKey("r");
    expect(utterances().at(-1)?.lang).toBe("en-GB");
  });

  it("快捷键 E 朗读 H1 例句；播放中再按 E = 打断（物理 cancel），不叠第二条", () => {
    const container = mountedContainer({ examples: [{ text: EXAMPLE_TEXT }] });

    pressKey("e");
    expect(texts()).toHaveLength(2);
    expect(texts().at(-1)).toBe(EXAMPLE_TEXT);
    expect(container.querySelector('[data-testid="encode-play-example"]')?.textContent).toContain("播放中");

    const cancelsBefore = synth.cancel.mock.calls.length;
    pressKey("e");

    // 断言必须落在底层：只验 UI 复位会漏掉"界面复位了、耳机还在念"的幽灵音轨
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(texts()).toHaveLength(2);
    expect(container.querySelector('[data-testid="encode-play-example"]')?.textContent).toContain("听例句");
  });

  it("无例句时按 E 不发声（不误触其它音轨）", () => {
    mountedContainer({ mnemonic_text: "a+bound 多到冲破边界" });
    const before = texts().length;
    pressKey("e");
    expect(texts()).toHaveLength(before);
  });

  it("空格展开释义（H4 由快捷键解锁）", () => {
    const container = mountedContainer({ short_definition: "大量存在" });

    expect(container.querySelector('[data-testid="encode-rating"]')).not.toBeNull();
    expect(screen.queryByText("大量存在")).toBeNull();

    pressKey(" ");
    expect(screen.getByText("大量存在")).toBeTruthy();
    expect(screen.queryByText("看释义（H4）")).toBeNull();
  });

  it("翻卡后 1 / 2 / 3 分别映射 easy / good / hard（与按钮同一条准入规则）", () => {
    const onRate = vi.fn();
    mount(createElement(EncodeCardView, { card: makeCard({ short_definition: "大量存在" }), onRate }));

    // 未翻卡：3（初见·难）被拦，2 不受限制（对应「有印象」按钮）
    pressKey("3");
    expect(onRate).not.toHaveBeenCalled();
    pressKey("2");
    expect(onRate).toHaveBeenLastCalledWith("good");

    pressKey(" ");
    pressKey("1");
    expect(onRate).toHaveBeenLastCalledWith("easy");
    pressKey("3");
    expect(onRate).toHaveBeenLastCalledWith("hard");
  });

  it("输入控件聚焦时快捷键豁免（不抢输入）", () => {
    mountedContainer();
    synth.speak.mockClear();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });
    expect(synth.speak).not.toHaveBeenCalled();

    pressKey("r");
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });
});

/** 挂载编码卡并返回容器（多数声学用例只关心卡面 DOM）。 */
function mountedContainer(word: Partial<ReviewCard["word"]> = {}): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(EncodeCardView, { card: makeCard(word), onRate: vi.fn() })));
  });
  mountedRoots.push({ root, container });
  return container;
}
