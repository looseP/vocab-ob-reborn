/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 切卡自动伴读（2026-10-12）测试套件。
 *
 * 四层锁定，从纯函数到组件接线：
 *  A. autoAudioSettings —— 配置默认值与脏值回落（存储纪律）；
 *  B. useFaceAutoAudio —— 每卡一次 / 总闸 / 泄题面默认关 / 换卡重触发；
 *  C. useAudioController.playSequence —— 逐段衔接 / 用户手动优先 / stop 取消；
 *  D. 组件接线 —— 卡面类别按到达时可见内容判定（①词形面播词、②释义面播中文）。
 *
 * speech 模块整体 mock（与 review-card-audio 同款口径）：jsdom 无真人音频解码，
 * 词形轨必然走 TTS 备用轨，用 speak/speakSentence 的调用序列断言编排顺序。
 */

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncodeCardView } from "@/frontend/components/review/EncodeCardView";
import { FollowCopyView } from "@/frontend/components/review/FollowCopyView";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import { useAudioController, type AudioController } from "@/frontend/reviewFlow/audioEngine";
import { useFaceAutoAudio, type FaceAutoAudioInput } from "@/frontend/reviewFlow/useFaceAutoAudio";
import {
  AUDIO_ACCENT_STORAGE_KEY,
  AUTO_AUDIO_STORAGE_KEY,
  DEFAULT_AUTO_AUDIO_CONFIG,
  readAudioAccent,
  readAutoAudioConfig,
  writeAudioAccent,
  writeAutoAudioConfig,
} from "@/frontend/utils/autoAudioSettings";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const { speakMock, speakSentenceMock } = vi.hoisted(() => ({
  speakMock: vi.fn(() => true),
  speakSentenceMock: vi.fn(() => true),
}));

vi.mock("@/frontend/reviewFlow/speech", () => ({
  isSpeechSynthesisAvailable: () => true,
  speak: speakMock,
  speakSentence: speakSentenceMock,
  cancelSpeech: vi.fn(),
  SENTENCE_RATE: 0.9,
}));

vi.mock("@/frontend/api/client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({ examples: [] })),
}));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", null, props.content),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  localStorage.clear();
  speakMock.mockClear();
  speakSentenceMock.mockClear();
});

afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mount(ui: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, ui));
  });
  mounted.push({ root, container });
  return container;
}

function makeCard(word: Partial<ReviewCard["word"]> = {}): ReviewCard {
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
      ...word,
    },
    state: "review",
    dueAt: new Date().toISOString(),
    lastRating: null,
    reviewCount: 1,
    note_entries: [],
  };
}

// ── A. 配置模块 ────────────────────────────────────────────────────────────

describe("autoAudioSettings：配置解析与存储纪律", () => {
  it("默认编排：①词→例句 ②释义→例句 ③a 词 ③b 释义，总闸开", () => {
    const config = readAutoAudioConfig();
    expect(config).toEqual(DEFAULT_AUTO_AUDIO_CONFIG);
    expect(config.master).toBe(true);
    expect(config.faces["en-word"]).toEqual(["word", "sentence"]);
    expect(config.faces["zh-meaning"]).toEqual(["definition", "sentence"]);
    expect(config.faces["typing-en"]).toEqual(["word"]);
    expect(config.faces["typing-zh"]).toEqual(["definition"]);
    expect(config.onReveal).toBe("off");
    expect(config.gapMs).toBe(350);
  });

  it("脏值逐个回落：未知单元剔除、重复去重、越界 gapMs 回落、master 非 true 即关", () => {
    localStorage.setItem(
      AUTO_AUDIO_STORAGE_KEY,
      JSON.stringify({
        master: "yes",
        faces: { "en-word": ["word", "bogus", "word"], "typing-zh": ["sentence"] },
        onReveal: "garbage",
        gapMs: 99999,
      }),
    );
    const config = readAutoAudioConfig();
    expect(config.master).toBe(false); // 字符串 "yes" 不是 true
    expect(config.faces["en-word"]).toEqual(["word"]); // bogus 剔除 + word 去重
    expect(config.faces["typing-zh"]).toEqual(["sentence"]); // 该字段合法，照单全收
    expect(config.faces["zh-meaning"]).toEqual(DEFAULT_AUTO_AUDIO_CONFIG.faces["zh-meaning"]); // 缺字段回落
    expect(config.onReveal).toBe("off"); // 非法值回落
    expect(config.gapMs).toBe(350); // 越界回落
  });

  it("空数组归一为 off；坏 JSON 整体回落默认", () => {
    localStorage.setItem(AUTO_AUDIO_STORAGE_KEY, JSON.stringify({ faces: { "en-word": [] } }));
    expect(readAutoAudioConfig().faces["en-word"]).toBe("off");

    localStorage.setItem(AUTO_AUDIO_STORAGE_KEY, "{ 不是 json");
    expect(readAutoAudioConfig()).toEqual(DEFAULT_AUTO_AUDIO_CONFIG);
  });

  it("口音偏好：读写往返；脏值按未设置处理", () => {
    expect(readAudioAccent()).toBeNull();
    writeAudioAccent("uk");
    expect(readAudioAccent()).toBe("uk");
    localStorage.setItem(AUDIO_ACCENT_STORAGE_KEY, "fr");
    expect(readAudioAccent()).toBeNull();
  });

  it("配置写入后可被读回（设置页即时生效的存储契约）", () => {
    writeAutoAudioConfig({
      master: false,
      faces: { ...DEFAULT_AUTO_AUDIO_CONFIG.faces, "zh-meaning": ["sentence"] },
      onReveal: ["word"],
      gapMs: 500,
    });
    const config = readAutoAudioConfig();
    expect(config.master).toBe(false);
    expect(config.faces["zh-meaning"]).toEqual(["sentence"]);
    expect(config.onReveal).toEqual(["word"]);
    expect(config.gapMs).toBe(500);
  });
});

// ── B. useFaceAutoAudio（假控制器） ────────────────────────────────────────

function fakeController(
  overrides: Partial<Pick<AudioController, "available" | "isPlaying">> = {},
): Pick<AudioController, "available" | "isPlaying" | "playSequence" | "stop"> {
  return {
    available: true,
    isPlaying: false,
    ...overrides,
    playSequence: vi.fn(),
    stop: vi.fn(),
  };
}

function Probe({ input }: { input: FaceAutoAudioInput }) {
  useFaceAutoAudio(input);
  return null;
}

function renderProbe(input: FaceAutoAudioInput): void {
  mount(createElement(Probe, { input }));
}

const baseProbe = {
  face: "en-word" as const,
  triggerKey: "p1",
  lemma: "above",
  sentence: "The book is on the shelf above.",
  definition: "在...之上",
};

describe("useFaceAutoAudio：触发与编排选择", () => {
  it("挂载即按卡面类别播一次（①词→例句），卸载即停", () => {
    const controller = fakeController();
    renderProbe({ ...baseProbe, controller });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);
    expect(controller.playSequence).toHaveBeenCalledWith(
      [
        { kind: "word", text: "above" },
        { kind: "sentence", text: "The book is on the shelf above." },
      ],
      350,
    );
    expect(controller.stop).not.toHaveBeenCalled();

    act(() => {
      mounted.splice(0).forEach((m) => m.root.unmount());
    });
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });

  it("②中文卡面读「释义→例句」编排", () => {
    const controller = fakeController();
    renderProbe({ ...baseProbe, face: "zh-meaning", controller });
    expect(controller.playSequence).toHaveBeenCalledWith(
      [
        { kind: "definition", text: "在...之上" },
        { kind: "sentence", text: "The book is on the shelf above." },
      ],
      350,
    );
  });

  it("③b 纯中文面默认只读释义：题面即音频，词形绝不入编排（防泄题）", () => {
    const controller = fakeController();
    renderProbe({ ...baseProbe, face: "typing-zh", controller });
    expect(controller.playSequence).toHaveBeenCalledWith([{ kind: "definition", text: "在...之上" }], 350);
    const playedKinds = controller.playSequence.mock.calls.flatMap((call) =>
      (call[0] as Array<{ kind: string }>).map((unit) => unit.kind),
    );
    expect(playedKinds, "念英文等于把答案说出口").toEqual(["definition"]);
  });

  it("总闸关闭时一律不播", () => {
    localStorage.setItem(AUTO_AUDIO_STORAGE_KEY, JSON.stringify({ master: false }));
    const controller = fakeController();
    renderProbe({ ...baseProbe, controller });
    expect(controller.playSequence).not.toHaveBeenCalled();
  });

  it("换卡（triggerKey 变）重新播一次，且先停上一段", () => {
    const controller = fakeController();
    const input: FaceAutoAudioInput = { ...baseProbe, controller };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    // 同一个 root 换 props：effect 依赖变 → 先跑清理（stop）再重跑（playSequence）
    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(Probe, { input })));
    });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(Probe, { input: { ...input, triggerKey: "p2" } })));
    });
    expect(controller.playSequence).toHaveBeenCalledTimes(2);
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });

  it("空文本单元被剔除：stub 词（无例句）降级为只播词", () => {
    const controller = fakeController();
    renderProbe({ ...baseProbe, sentence: null, definition: null, controller });
    expect(controller.playSequence).toHaveBeenCalledWith([{ kind: "word", text: "above" }], 350);
  });

  it("全空（无词无形无释义）不播", () => {
    const controller = fakeController();
    renderProbe({ ...baseProbe, lemma: null, sentence: null, definition: null, controller });
    expect(controller.playSequence).not.toHaveBeenCalled();
  });

  it("例句异步到齐：只补播例句，同一个词不重播（不掐断重来）", () => {
    const controller = fakeController();
    // 首帧只有词形 —— 例句要等详情异步回来
    const root = renderProbeInRoot({ ...baseProbe, sentence: null, definition: null, controller });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);
    expect(controller.playSequence).toHaveBeenLastCalledWith([{ kind: "word", text: "above" }], 350);

    // 例句到齐：补上这句，**词不再念第二遍**
    rerenderProbe(root, { ...baseProbe, sentence: baseProbe.sentence, definition: null, controller });
    expect(controller.playSequence).toHaveBeenCalledTimes(2);
    expect(controller.playSequence).toHaveBeenLastCalledWith(
      [{ kind: "sentence", text: baseProbe.sentence }],
      350,
    );
    // 补播是新内容接上，不是掐断重来
    expect(controller.stop).not.toHaveBeenCalled();

    // 内容不再变的重渲染：一次都不该多播
    rerenderProbe(root, { ...baseProbe, sentence: baseProbe.sentence, definition: null, controller });
    expect(controller.playSequence).toHaveBeenCalledTimes(2);
  });

  it("中文卡面释义未到：先不播，到齐才播一次", () => {
    const controller = fakeController();
    const input: FaceAutoAudioInput = { ...baseProbe, face: "zh-meaning", controller };
    const root = renderProbeInRoot({ ...input, sentence: null, definition: null });
    // 首帧没有可读内容（③ 类卡面的编排只有释义 / 例句）——不抢跑
    expect(controller.playSequence).not.toHaveBeenCalled();

    rerenderProbe(root, { ...input, sentence: null, definition: "在...之上" });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);
    expect(controller.playSequence).toHaveBeenLastCalledWith(
      [{ kind: "definition", text: "在...之上" }],
      350,
    );
  });

  it("首帧还在念时，晚到的例句攒着等念完再接（不打断在途、也不重念词）", () => {
    const controller = fakeController({ isPlaying: true });
    const root = renderProbeInRoot({ ...baseProbe, sentence: null, definition: null, controller });
    // 有词可播，但控制器此刻在播别的东西：不硬切，先攒着
    expect(controller.playSequence).not.toHaveBeenCalled();

    // 例句随后到齐：仍然在播 → 继续攒（词已在队列里，不会重复）
    rerenderProbe(root, { ...baseProbe, sentence: baseProbe.sentence, definition: null, controller });
    expect(controller.playSequence).not.toHaveBeenCalled();

    // 在途那段念完：把攒下的接上，一次播完（词 + 例句，各一次）
    rerenderProbe(root, {
      ...baseProbe,
      sentence: baseProbe.sentence,
      definition: null,
      controller: { ...controller, isPlaying: false },
    });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);
    expect(controller.playSequence).toHaveBeenLastCalledWith(
      [
        { kind: "word", text: "above" },
        { kind: "sentence", text: baseProbe.sentence },
      ],
      350,
    );
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it("环境无发声能力时不播", () => {
    const controller = { ...fakeController(), available: false };
    renderProbe({ ...baseProbe, controller });
    expect(controller.playSequence).not.toHaveBeenCalled();
  });
});

// ── B2. 翻卡编排（onReveal）与长例句保护 ──────────────────────────────────

/** 同一 root 反复 render：翻卡是「同 props 变化」，必须复用实例才验得准。 */
function renderProbeInRoot(input: FaceAutoAudioInput): Root {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  rerenderProbe(root, input);
  return root;
}

function rerenderProbe(root: Root, input: FaceAutoAudioInput): void {
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(Probe, { input })));
  });
}

/**
 * 只数「整条都是释义单元」的播放：那是 onReveal 编排（本组固定配 `["definition"]`）
 * 的特征，与切卡编排（词 / 词＋例句）区分得开。
 */
function revealPlayCount(controller: ReturnType<typeof fakeController>): number {
  return controller.playSequence.mock.calls.filter((call) =>
    (call[0] as { kind: string }[]).every((unit) => unit.kind === "definition"),
  ).length;
}

describe("useFaceAutoAudio：翻卡编排（onReveal）", () => {
  it("默认关：翻卡（revealed false → true）不额外播 —— 切卡播一次是主语义", () => {
    const controller = fakeController();
    const root = renderProbeInRoot({ ...baseProbe, controller, revealed: false });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);

    rerenderProbe(root, { ...baseProbe, controller, revealed: true });
    expect(controller.playSequence).toHaveBeenCalledTimes(1);
  });

  it("开了 onReveal：翻卡那一刻播该编排；同态重渲染不重播", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, onReveal: ["definition"] });
    const controller = fakeController();
    const root = renderProbeInRoot({ ...baseProbe, controller, revealed: false });
    expect(revealPlayCount(controller)).toBe(0);

    rerenderProbe(root, { ...baseProbe, controller, revealed: true });
    expect(revealPlayCount(controller)).toBe(1);
    expect(controller.playSequence).toHaveBeenLastCalledWith(
      [{ kind: "definition", text: "在...之上" }],
      350,
    );

    // 揭示态内内容变化（例如释义详情异步回来）：切卡编排**只补播新到的单元**
    // （这里就是新例句），念过的词不重复；onReveal 也不再响 —— 揭示是
    // 「一次性动作」，不是内容变化的结果。
    rerenderProbe(root, { ...baseProbe, controller, revealed: true, sentence: "换了例句" });
    expect(revealPlayCount(controller)).toBe(1);
    expect(controller.playSequence).toHaveBeenLastCalledWith(
      [{ kind: "sentence", text: "换了例句" }],
      350,
    );
  });

  it("回看再翻（true → false → true）可以再播一次", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, onReveal: ["word"] });
    const controller = fakeController();
    const root = renderProbeInRoot({ ...baseProbe, controller, revealed: false });
    rerenderProbe(root, { ...baseProbe, controller, revealed: true });
    expect(controller.playSequence).toHaveBeenCalledTimes(2);

    rerenderProbe(root, { ...baseProbe, controller, revealed: false });
    rerenderProbe(root, { ...baseProbe, controller, revealed: true });
    expect(controller.playSequence).toHaveBeenCalledTimes(3);
    expect(controller.playSequence).toHaveBeenLastCalledWith([{ kind: "word", text: "above" }], 350);
  });

  it("到达即揭示（首帧 revealed=true，如 preview 直展）不触发 onReveal", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, onReveal: ["definition"] });
    const controller = fakeController();
    renderProbe({ ...baseProbe, controller, revealed: true });
    // 只有切卡编排那一次，翻卡编排不该冒出来
    expect(controller.playSequence).toHaveBeenCalledTimes(1);
  });

  it("总闸关闭时翻卡不播（即使 onReveal 配了值）", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, master: false, onReveal: ["definition"] });
    const controller = fakeController();
    const root = renderProbeInRoot({ ...baseProbe, controller, revealed: false });
    rerenderProbe(root, { ...baseProbe, controller, revealed: true });
    expect(controller.playSequence).not.toHaveBeenCalled();
  });

  it("onReveal 编排为空（off）时翻卡静默", () => {
    writeAutoAudioConfig({
      ...DEFAULT_AUTO_AUDIO_CONFIG,
      onReveal: "off",
      faces: { ...DEFAULT_AUTO_AUDIO_CONFIG.faces, "en-word": "off" },
    });
    const controller = fakeController();
    const root = renderProbeInRoot({ ...baseProbe, controller, revealed: false });
    rerenderProbe(root, { ...baseProbe, controller, revealed: true });
    expect(controller.playSequence).not.toHaveBeenCalled();
  });
});

describe("useFaceAutoAudio：长例句保护（自动播报不可随时按停）", () => {
  /** estimateSpeechMs 按 70ms/字符、下限 600ms 估算 —— 10s 阈值恰好卡在 143 字符。 */
  it("例句估算超 10 秒（144 字符）整条跳过：①编排降级为只播词", () => {
    const controller = fakeController();
    const longSentence = "x".repeat(144);
    renderProbe({ ...baseProbe, sentence: longSentence, controller });
    expect(controller.playSequence).toHaveBeenCalledWith([{ kind: "word", text: "above" }], 350);
  });

  it("边界：142 字符（估算 9940ms）保留，143 字符（10010ms）跳过", () => {
    const kept = fakeController();
    renderProbe({ ...baseProbe, sentence: "y".repeat(142), controller: kept });
    expect(kept.playSequence).toHaveBeenCalledWith(
      [
        { kind: "word", text: "above" },
        { kind: "sentence", text: "y".repeat(142) },
      ],
      350,
    );

    const skipped = fakeController();
    renderProbe({ ...baseProbe, sentence: "y".repeat(143), controller: skipped });
    expect(skipped.playSequence).toHaveBeenCalledWith([{ kind: "word", text: "above" }], 350);
  });

  it("长例句在 onReveal 编排里同样跳过（只剩释义）", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, onReveal: ["sentence", "definition"] });
    const controller = fakeController();
    const root = renderProbeInRoot({
      ...baseProbe,
      sentence: "z".repeat(200),
      controller,
      revealed: false,
    });
    rerenderProbe(root, { ...baseProbe, sentence: "z".repeat(200), controller, revealed: true });
    expect(controller.playSequence).toHaveBeenLastCalledWith(
      [{ kind: "definition", text: "在...之上" }],
      350,
    );
  });
});

// ── C. playSequence 引擎（真实控制器 + fake speech） ───────────────────────

describe("useAudioController.playSequence：逐段衔接与打断", () => {
  let controller: AudioController | null = null;

  function ControllerProbe() {
    controller = useAudioController();
    return null;
  }

  function mountController(): void {
    controller = null;
    mount(createElement(ControllerProbe));
    if (!controller) throw new Error("controller not mounted");
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("按编排顺序逐段朗读：词 → 停顿 → 例句 → 停顿 → 中文释义", () => {
    mountController();
    act(() => {
      controller!.playSequence([
        { kind: "word", text: "above" },
        { kind: "sentence", text: "The book is on the shelf above." },
        { kind: "definition", text: "在...之上" },
      ]);
    });
    // 第一段（词）立即发声
    expect(speakMock).toHaveBeenCalledWith("above");
    expect(speakSentenceMock).not.toHaveBeenCalled();

    // 估算 600ms + 停顿 350ms 后进第二段（例句）
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(speakSentenceMock).toHaveBeenCalledWith("The book is on the shelf above.", {
      accent: "us",
      rate: 0.9,
    });

    // 例句估算（30 字 × 70ms）+ 停顿后进第三段（中文释义，zh-CN）
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(speakMock).toHaveBeenCalledWith("在...之上", "zh-CN");
    expect(speakMock.mock.calls.map((c) => c[0])).toEqual(["above", "在...之上"]);
  });

  it("用户手动播放优先：序列被整条作废，后续段不复活", () => {
    mountController();
    act(() => {
      controller!.playSequence([
        { kind: "word", text: "above" },
        { kind: "sentence", text: "The book is on the shelf above." },
      ]);
    });
    expect(speakMock).toHaveBeenCalledWith("above");

    // 用户按 R 听别的词：打断 + 取消序列
    act(() => {
      controller!.playWord("other");
    });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(speakSentenceMock).not.toHaveBeenCalled();
    expect(speakMock).toHaveBeenCalledWith("other");
  });

  it("stop() 取消在途编排", () => {
    mountController();
    act(() => {
      controller!.playSequence([
        { kind: "word", text: "above" },
        { kind: "sentence", text: "The book is on the shelf above." },
      ]);
    });
    act(() => {
      controller!.stop();
    });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(speakSentenceMock).not.toHaveBeenCalled();
  });

  it("空单元序列不发声", () => {
    mountController();
    act(() => {
      controller!.playSequence([{ kind: "word", text: "   " }]);
    });
    expect(speakMock).not.toHaveBeenCalled();
  });
});

// ── D. 组件接线 ────────────────────────────────────────────────────────────

describe("组件接线：卡面类别按到达时可见内容判定", () => {
  it("经典速刷正面 = ①英文卡面：挂载播词", () => {
    mount(createElement(ReviewCardView, { card: makeCard(), onAnswer: vi.fn() }));
    expect(speakMock).toHaveBeenCalledWith("above");
  });

  it("preview 释义直展 = ②中文卡面：挂载播中文释义（无例句时降级）", () => {
    mount(createElement(ReviewCardView, { card: makeCard(), preview: true, onAnswer: vi.fn() }));
    expect(speakMock).toHaveBeenCalledWith("在...之上", "zh-CN");
  });

  it("巩固轮照着打 = ③a：挂载播词", () => {
    mount(
      createElement(FollowCopyView, {
        lemma: "above",
        definition: "在...之上",
        onDone: vi.fn(),
      }),
    );
    expect(speakMock).toHaveBeenCalledWith("above");
  });

  it("总闸关闭时组件不自动播（手动按钮仍可用，由既有套件覆盖）", () => {
    localStorage.setItem(AUTO_AUDIO_STORAGE_KEY, JSON.stringify({ master: false }));
    mount(createElement(ReviewCardView, { card: makeCard(), onAnswer: vi.fn() }));
    expect(speakMock).not.toHaveBeenCalled();
  });
});

describe("组件接线：翻卡（正 → 反）驱动 onReveal", () => {
  /** 只看「谁被念了」：翻卡编排的语料与切卡编排不同，便于分辨。 */
  function spokenTexts(): string[] {
    return speakMock.mock.calls.map((call) => call[0] as string);
  }

  it("经典速刷：空格翻到背面 → 播 onReveal 编排（配了才播）", () => {
    writeAutoAudioConfig({
      ...DEFAULT_AUTO_AUDIO_CONFIG,
      faces: { ...DEFAULT_AUTO_AUDIO_CONFIG.faces, "en-word": ["word"] },
      onReveal: ["definition"],
    });
    mount(createElement(ReviewCardView, { card: makeCard(), onAnswer: vi.fn() }));
    expect(spokenTexts()).toEqual(["above"]);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    });
    expect(spokenTexts()).toEqual(["above", "在...之上"]);
  });

  it("经典速刷默认（onReveal off）：翻卡保持沉默 —— 切卡播一次是主语义", () => {
    mount(createElement(ReviewCardView, { card: makeCard(), onAnswer: vi.fn() }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    });
    expect(spokenTexts()).toEqual(["above"]);
  });

  it("编码卡：点「看释义（H4）」→ 播 onReveal 编排", () => {
    writeAutoAudioConfig({
      ...DEFAULT_AUTO_AUDIO_CONFIG,
      faces: { ...DEFAULT_AUTO_AUDIO_CONFIG.faces, "en-word": ["word"] },
      onReveal: ["definition"],
    });
    mount(createElement(EncodeCardView, { card: makeCard(), onRate: vi.fn() }));
    expect(spokenTexts()).toEqual(["above"]);

    act(() => {
      fireEvent.click(screen.getByText("看释义（H4）"));
    });
    expect(spokenTexts()).toEqual(["above", "在...之上"]);
  });

  it("编码卡默认（onReveal off）：看释义不发声", () => {
    mount(createElement(EncodeCardView, { card: makeCard(), onRate: vi.fn() }));
    act(() => {
      fireEvent.click(screen.getByText("看释义（H4）"));
    });
    expect(spokenTexts()).toEqual(["above"]);
  });
});
