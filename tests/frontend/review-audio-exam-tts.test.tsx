/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 声学底座 + Exam 例句原声朗读（Phase 1）验收。
 *
 * 覆盖四层：
 * 1. `playWordAudio` 双轨：真人音频正常收尾 / error 降级 / 1.5s 超时降级 / 环境无解码能力直降；
 * 2. `pickEnglishVoice` 自然语音优选与口音优先（纯函数）；
 * 3. `ClueZone` / `ExampleLayerBlock` 的例句朗读按钮渲染与回调；
 * 4. `ReviewCardView` 快捷键 R（拼读）、Shift+R（口音）、E（例句）与输入控件豁免。
 *
 * 真实 `speech.ts` 不 mock —— 用 fake `window.speechSynthesis` 驱动，
 * 顺带把 speak/speakSentence 的 utterance 参数（lang / rate / text）一起验了。
 */

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORD_AUDIO_TIMEOUT_MS,
  canPlayRealAudio,
  estimateSpeechMs,
  playWordAudio,
  wordAudioUrl,
  type AudioElementFactory,
  type WordAudioElement,
} from "@/frontend/reviewFlow/audioEngine";
import { pickEnglishVoice } from "@/frontend/reviewFlow/speech";
import { ClueZone, ExampleLayerBlock } from "@/frontend/components/review/WordCardExamLayers";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const { EXAMPLE_TEXT, EXAMPLE_TRANSLATION } = vi.hoisted(() => ({
  EXAMPLE_TEXT: "He lives above the shop on the corner of the street.",
  EXAMPLE_TRANSLATION: "他住在街角那家商店的楼上。",
}));

vi.mock("@/frontend/hooks/useWordDetail", () => ({
  useWordDetail: () => ({
    word: {
      id: "w1",
      slug: "above",
      title: "above",
      lemma: "above",
      pos: "prep",
      cefr: "A1",
      ipa: "/əˈbʌv/",
      short_definition: "在……之上",
      definition_md: "",
      body_md: "",
      aliases: [],
      metadata: null,
      examples: [
        {
          text: EXAMPLE_TEXT,
          translation: EXAMPLE_TRANSLATION,
          anchor: "above",
          source: "2021 考研英语一 Text 1",
          source_type: "考研真题",
          verified: { checked: ["a", "b"] },
        },
      ],
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/frontend/api/client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({ entry: {} })),
}));

vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", null, props.content),
}));

// ── fake Web Speech：真实 speech.ts 直接跑在它上面 ─────────────────────────
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

/** 可驱动的假音频元素：测试自己决定何时派发 ended / error。 */
class FakeAudio implements WordAudioElement {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  playCalls = 0;
  play = () => {
    this.playCalls += 1;
    return Promise.resolve();
  };
  pause = () => {
    this.paused = true;
  };
  constructor(readonly src: string) {}
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function render(node: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(node);
  });
  return container;
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
  });
}

beforeEach(() => {
  synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) };
  Reflect.set(window, "speechSynthesis", synth);
  Reflect.set(window, "SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "speechSynthesis");
  Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
});

// ────────────────────────────────────────────────────────────────────────────
describe("playWordAudio：真人音频主轨 + 本地 TTS 备用轨", () => {
  it("URL 按口音取 type=1（英音）/ type=2（美音）", () => {
    expect(wordAudioUrl("above", "uk")).toBe(
      "https://dict.youdao.com/dictvoice?audio=above&type=1",
    );
    expect(wordAudioUrl("above", "us")).toBe(
      "https://dict.youdao.com/dictvoice?audio=above&type=2",
    );
    // 含特殊字符的词必须编码，否则会被 CDN 截断
    expect(wordAudioUrl("don't", "us")).toContain(`audio=${encodeURIComponent("don't")}`);
  });

  it("主轨正常播完（ended）：不降级，回调 onEnd", () => {
    const created: FakeAudio[] = [];
    const factory: AudioElementFactory = (url) => {
      const el = new FakeAudio(url);
      created.push(el);
      return el;
    };
    const onEnd = vi.fn();
    const onFallback = vi.fn();

    playWordAudio("above", "us", { onEnd, onFallback }, factory);

    expect(created).toHaveLength(1);
    expect(created[0].src).toBe(wordAudioUrl("above", "us"));
    expect(created[0].playCalls).toBe(1);
    expect(onFallback).not.toHaveBeenCalled();

    act(() => created[0].onended?.());

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("主轨加载失败（error）：降级 Web Speech，不回调 onEnd（TTS 仍在念）", () => {
    const created: FakeAudio[] = [];
    const factory: AudioElementFactory = (url) => {
      const el = new FakeAudio(url);
      created.push(el);
      return el;
    };
    const onEnd = vi.fn();
    const onFallback = vi.fn();

    playWordAudio("above", "us", { onEnd, onFallback }, factory);
    act(() => created[0].onerror?.());

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe("above");
  });

  it("主轨 1.5s 无首帧：超时降级 Web Speech", () => {
    vi.useFakeTimers();
    const factory: AudioElementFactory = (url) => new FakeAudio(url);
    const onFallback = vi.fn();

    playWordAudio("above", "us", { onFallback }, factory);
    expect(synth.speak).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WORD_AUDIO_TIMEOUT_MS);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe("above");
  });

  it("环境不具备 mp3 解码能力（jsdom）：直接走 TTS，不发真人音频请求", () => {
    expect(canPlayRealAudio()).toBe(false);
    expect(playWordAudio("above", "us")).toBeDefined();
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe("above");
  });

  it("英音降级走 en-GB（口音开关在备用轨也生效）", () => {
    playWordAudio("above", "uk");
    expect(utterances()[0].lang).toBe("en-GB");
  });

  it("空词条不发声（边界）", () => {
    expect(playWordAudio("   ", "us")).toBeDefined();
    expect(synth.speak).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("pickEnglishVoice：自然语音优选 + 口音优先", () => {
  const voices = [
    { name: "Microsoft David", lang: "en-US", localService: true },
    { name: "Microsoft Aria Online (Natural)", lang: "en-US", localService: false },
    { name: "Google UK English Female", lang: "en-GB", localService: false },
    { name: "Ting-Ting", lang: "zh-CN", localService: true },
  ] as unknown as SpeechSynthesisVoice[];

  it("美音：优先 en-US 的自然语音（Natural/Online）", () => {
    expect(pickEnglishVoice(voices, "us")?.name).toBe("Microsoft Aria Online (Natural)");
  });

  it("英音：口音匹配压过自然度（有 en-GB 就不许念美音）", () => {
    expect(pickEnglishVoice(voices, "uk")?.name).toBe("Google UK English Female");
  });

  it("无对口音音色时退化为任意英语音色", () => {
    const only = [{ name: "Microsoft David", lang: "en-US", localService: true }] as unknown as SpeechSynthesisVoice[];
    expect(pickEnglishVoice(only, "uk")?.name).toBe("Microsoft David");
  });

  it("无任何英语音色 → null（保留 utterance.lang 让引擎自选）", () => {
    const chinese = [{ name: "Ting-Ting", lang: "zh-CN" }] as unknown as SpeechSynthesisVoice[];
    expect(pickEnglishVoice(chinese, "us")).toBeNull();
    expect(pickEnglishVoice([], "uk")).toBeNull();
    expect(pickEnglishVoice(null, "uk")).toBeNull();
  });
});

describe("estimateSpeechMs：TTS 时长估算", () => {
  it("空串为 0，短词有下限，长句按字数增长且封顶", () => {
    expect(estimateSpeechMs("  ")).toBe(0);
    expect(estimateSpeechMs("above")).toBe(600);
    expect(estimateSpeechMs("a".repeat(100))).toBe(7000);
    expect(estimateSpeechMs("a".repeat(5000))).toBe(60_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("Exam 例句朗读按钮", () => {
  it("ClueZone 渲染「听例句」并在点击时回调", () => {
    const onPlaySentence = vi.fn();
    const container = render(
      createElement(ClueZone, {
        exam: null,
        text: EXAMPLE_TEXT,
        maskTerm: "above",
        maskRevealed: false,
        onUnmask: vi.fn(),
        onPlaySentence,
        sentencePlaying: false,
      }),
    );

    const button = container.querySelector<HTMLButtonElement>('[data-testid="clue-play-example"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("朗读例句 (E)");

    act(() => button?.click());
    expect(onPlaySentence).toHaveBeenCalledTimes(1);

    // 按钮在正面线索区里，必须不触发翻面
    expect(button?.hasAttribute("data-no-flip")).toBe(true);
  });

  // 防回归：真库 words.examples[0].source_type 实测为
  // press 6407 / reference 302 / institution 38 / academic 16 / quote 3 / media 1，
  // 且 `source ~ '考研|真题'` 命中 0 条 —— 例句来自报刊与词典，不是历年真题原文。
  // 文案一旦写回「真题」，就是对内容来源的失实陈述（100% 用户可见）。
  it("例句按钮文案不得出现「真题」字样（正反面两侧同口径）", () => {
    const container = render(
      createElement(ClueZone, {
        exam: null,
        text: EXAMPLE_TEXT,
        maskTerm: "above",
        maskRevealed: false,
        onUnmask: vi.fn(),
        onPlaySentence: vi.fn(),
        sentencePlaying: false,
      }),
    );
    const button = container.querySelector<HTMLButtonElement>('[data-testid="clue-play-example"]');
    expect(button).not.toBeNull();
    expect(button?.textContent ?? "").not.toContain("真题");
    expect(button?.getAttribute("aria-label") ?? "").not.toContain("真题");
    expect(button?.getAttribute("title") ?? "").not.toContain("真题");
  });

  it("ClueZone 未接入朗读时不渲染按钮（未接线不出现死按钮）", () => {
    const container = render(
      createElement(ClueZone, {
        exam: null,
        text: EXAMPLE_TEXT,
        maskTerm: "above",
        maskRevealed: false,
        onUnmask: vi.fn(),
      }),
    );
    expect(container.querySelector('[data-testid="clue-play-example"]')).toBeNull();
  });

  it("ClueZone 播放中显示状态文案", () => {
    const container = render(
      createElement(ClueZone, {
        exam: null,
        text: EXAMPLE_TEXT,
        maskTerm: "above",
        maskRevealed: false,
        onUnmask: vi.fn(),
        onPlaySentence: vi.fn(),
        sentencePlaying: true,
      }),
    );
    expect(container.querySelector('[data-testid="clue-play-example"]')?.textContent).toContain("播放中");
  });

  it("ExampleLayerBlock 渲染「朗读例句」并在点击时回调", () => {
    const onPlaySentence = vi.fn();
    const container = render(
      createElement(ExampleLayerBlock, {
        text: EXAMPLE_TEXT,
        translation: EXAMPLE_TRANSLATION,
        term: "above",
        source: "2021 考研英语一 Text 1",
        sourceType: "考研真题",
        url: null,
        modified: false,
        verifiedCount: 2,
        onPlaySentence,
        sentencePlaying: false,
      }),
    );

    const button = container.querySelector<HTMLButtonElement>('[data-testid="ex-layer-play"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("朗读例句 (E)");

    act(() => button?.click());
    expect(onPlaySentence).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
function makeCard(): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "w1",
      slug: "above",
      title: "above",
      lemma: "above",
      short_definition: "在...之上",
      ipa: "/əˈbʌv/",
      pos: "prep",
      cefr: "A1",
    },
    state: "review",
    dueAt: new Date().toISOString(),
    lastRating: null,
    reviewCount: 1,
    note_entries: [],
  };
}

function renderCard(): HTMLDivElement {
  return render(
    createElement(MemoryRouter, null, createElement(ReviewCardView, { card: makeCard(), onAnswer: vi.fn() })),
  );
}

describe("ReviewCardView：声学胶囊与快捷键", () => {
  it("拼读胶囊常驻：词形 / 音标 / 口音开关 / 发音入口齐备", () => {
    const container = renderCard();
    const anchor = container.querySelector('[data-testid="acoustic-sticky-anchor"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.className).toContain("sticky");
    expect(anchor?.className).toContain("top-20");
    expect(anchor?.textContent).toContain("above");
    expect(anchor?.textContent).toContain("/əˈbʌv/");
    expect(container.querySelector('[data-testid="accent-toggle"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="朗读发音 (R)"]')).not.toBeNull();
  });

  it("R 键朗读单词（降级 TTS，en-US）", () => {
    renderCard();
    pressKey("r");
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe("above");
    expect(utterances()[0].lang).toBe("en-US");
  });

  it("发音按钮点击等同于 R", () => {
    const container = renderCard();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="朗读发音 (R)"]');
    act(() => button?.click());
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe("above");
  });

  it("Shift+R 切换口音（美音 → 英音），随后 R 走 en-GB", () => {
    const container = renderCard();
    const toggle = container.querySelector('[data-testid="accent-toggle"]');
    expect(toggle?.getAttribute("aria-label")).toBe("当前美音，切换到英音");

    pressKey("r", { shiftKey: true });
    expect(toggle?.getAttribute("aria-label")).toBe("当前英音，切换到美音");
    expect(synth.speak).not.toHaveBeenCalled();

    pressKey("r");
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].lang).toBe("en-GB");
  });

  it("E 键朗读例句（正面 ClueZone）", () => {
    const container = renderCard();
    expect(container.querySelector('[data-testid="clue-play-example"]')).not.toBeNull();

    pressKey("e");

    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe(EXAMPLE_TEXT);
    expect(utterances()[0].rate).toBe(0.9);
    expect(container.querySelector('[data-testid="clue-play-example"]')?.textContent).toContain("播放中");
  });

  it("E 键播放中再次按下：打断复位，且**真正调用** speechSynthesis.cancel（物理停声）", () => {
    const container = renderCard();
    pressKey("e");
    expect(utterances()).toHaveLength(1);
    const cancelsBefore = synth.cancel.mock.calls.length;

    pressKey("e");

    // 断言点必须落在底层：只验 UI 复位会漏掉"界面复位了、耳机还在念"的幽灵音轨
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(utterances()).toHaveLength(1);
    expect(container.querySelector('[data-testid="clue-play-example"]')?.textContent).toContain("听例句");
  });

  it("例句播放中按 R：先物理打断例句，再念单词，两轨不撞车", () => {
    const container = renderCard();
    pressKey("e");
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe(EXAMPLE_TEXT);
    const cancelsBefore = synth.cancel.mock.calls.length;

    pressKey("r");

    // 例句 TTS 被显式 cancel，否则会与单词真人语音双轨混音
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(utterances()).toHaveLength(2);
    expect(utterances()[1].text).toBe("above");
    // 声源已切到单词 → 例句按钮复位
    expect(container.querySelector('[data-testid="clue-play-example"]')?.textContent).toContain("听例句");
  });

  it("正面「听例句」按钮在播放中点击 = 打断复位（与 E 键行为一致）", () => {
    const container = renderCard();
    pressKey("e");
    expect(container.querySelector('[data-testid="clue-play-example"]')?.textContent).toContain("播放中");
    const cancelsBefore = synth.cancel.mock.calls.length;

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="clue-play-example"]')?.click());

    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(utterances()).toHaveLength(1);
    expect(container.querySelector('[data-testid="clue-play-example"]')?.textContent).toContain("听例句");
  });

  it("背面「朗读例句」按钮在播放中点击 = 打断复位（正反面同一入口）", () => {
    // preview 直接渲染卡背（不经翻转动画），可在 jsdom 里稳定触达 ex-layer-play
    const container = render(
      createElement(
        MemoryRouter,
        null,
        createElement(ReviewCardView, { card: makeCard(), preview: true, onAnswer: vi.fn() }),
      ),
    );
    const play = () => container.querySelector<HTMLButtonElement>('[data-testid="ex-layer-play"]');
    expect(play()).not.toBeNull();

    act(() => play()?.click());
    expect(utterances()).toHaveLength(1);
    expect(play()?.textContent).toContain("播放中");
    const cancelsBefore = synth.cancel.mock.calls.length;

    act(() => play()?.click());

    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(utterances()).toHaveLength(1);
    expect(play()?.textContent).toContain("朗读例句");
  });

  it("真人轨在途不被 estimateSpeechMs 腰斩：600ms 处仍在播放态", () => {
    vi.useFakeTimers();
    // jsdom 默认 canPlayType("audio/mpeg") === ""（判定为无解码能力）。这里模拟
    // 具备解码能力的浏览器，逼 playWord 走**真人音频主轨**分支。
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    expect(canPlayRealAudio()).toBe(true);

    const container = renderCard();
    pressKey("r");
    expect(utterances()).toHaveLength(0);

    // 缺陷回归点：真人 mp3 需网络拉取，短词 600ms 估算到点即腰斩声波并丢失打断能力
    act(() => void vi.advanceTimersByTime(estimateSpeechMs("above")));
    expect(container.querySelector('[data-testid="audio-waveform"]')).not.toBeNull();

    // 首帧 1.5s 超时后才降级 TTS，此时才切回按字符数估算的复位定时器
    act(() => void vi.advanceTimersByTime(WORD_AUDIO_TIMEOUT_MS - estimateSpeechMs("above")));
    expect(utterances()).toHaveLength(1);
    expect(utterances()[0].text).toBe("above");

    act(() => void vi.advanceTimersByTime(estimateSpeechMs("above")));
    expect(container.querySelector('[data-testid="audio-waveform"]')).toBeNull();
  });

  it("正面「听例句」按钮可用（不消耗 H1 提示）", () => {
    const container = renderCard();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="clue-play-example"]');
    act(() => button?.click());
    expect(utterances()).toHaveLength(1);
    // 听觉线索与"揭示词形"正交：遮罩仍在，提示级未被消费
    expect(container.querySelector('[data-testid="clue-mask"]')).not.toBeNull();
  });

  it("输入控件聚焦时快捷键豁免（严格保留既有规则）", () => {
    renderCard();
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
