/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 自动伴读 · 新面接入（v2 第二批）测试。
 *
 * 每处接线只锁一件事：**它凭什么响、凭什么不响**。
 *  A. 钩子契约：不传 `face` 的卡面（一屏多卡）到达不播，只认翻卡；
 *  B. 葫芦冲刺：整页同挂时不许齐声朗读，翻开核对才播 `onReveal`（默认关）；
 *  C. 冲刷训练：两个题面都归「词形不可见」（③b），默认静默 —— 防泄题；
 *  D. 听写档：读音**就是题面** —— 进入即播、可重播、环境无发声能力时降级跟写。
 *
 * 形状照 `hulu-session.test.tsx` / `face-auto-audio.test.tsx`：jsdom + `createRoot`
 * + 受控 `apiFetch` mock，TTS 用 `speech` 模块打桩（`speechState.available` 可切
 * 「有 / 无发声能力」两条路径）。
 */

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { speakMock, speakSentenceMock, speechState, drillState } = vi.hoisted(() => ({
  speakMock: vi.fn(() => true),
  speakSentenceMock: vi.fn(() => true),
  /** 环境是否具备 TTS：`audioEngine.available` = 真人音频 || TTS，jsdom 里前者为假。 */
  speechState: { available: true },
  /** `useDrill` 的打桩返回值：本套件只关心「题面到达时该不该出声」。 */
  drillState: {
    currentCard: {
      progressId: "p-1",
      lemma: "above",
      shortDefinition: "在...之上",
    } as { progressId: string; lemma: string; shortDefinition: string } | null,
    variant: "definition" as "definition" | "cloze",
    loading: false,
    error: null as string | null,
    stats: { correct: 0, incorrect: 0, answered: 0 },
    startDrill: () => undefined,
  },
}));

/** 保留真实模块的其余导出（SENTENCE_RATE / cancelSpeech），只换掉发声两条路径。 */
vi.mock("@/frontend/reviewFlow/speech", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSpeechSynthesisAvailable: () => speechState.available,
  speak: speakMock,
  speakSentence: speakSentenceMock,
}));
vi.mock("@/frontend/hooks/useDrill", () => ({ useDrill: () => drillState }));
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/frontend/api/wordbooks", () => ({
  getDefaultWordbook: vi.fn(async () => ({ id: "wb-1", name: "默认词书" })),
}));
/** Markdown 懒加载 marked + dompurify：本套件只关心卡面挂载，不关心渲染结果。 */
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) =>
    createElement("div", { "data-testid": "markdown" }, props.content),
}));

import { apiFetch } from "@/frontend/api/client";
import { DrillSession } from "@/frontend/components/review/DrillSession";
import { HuluSprintSession } from "@/frontend/components/review/HuluSprintSession";
import { TypingDictationView } from "@/frontend/components/review/TypingDictationView";
import { useFaceAutoAudio, type FaceAutoAudioInput } from "@/frontend/reviewFlow/useFaceAutoAudio";
import { DEFAULT_AUTO_AUDIO_CONFIG, writeAutoAudioConfig } from "@/frontend/utils/autoAudioSettings";

const apiFetchMock = vi.mocked(apiFetch);
const HULU_PLAN_ID = "11111111-1111-4111-8111-111111111111";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  speakMock.mockClear();
  speakSentenceMock.mockClear();
  speechState.available = true;
  drillState.currentCard = {
    progressId: "p-1",
    lemma: "above",
    shortDefinition: "在...之上",
  };
  drillState.variant = "definition";
  apiFetchMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
});

/** 挂载任意节点（统一登记，afterEach 收口卸载）。 */
function mountInto(node: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mountedRoots.push({ root, container });
  return container;
}

/** 只看「谁被念了」：第一个实参即文本。 */
const spokenTexts = (): string[] => speakMock.mock.calls.map((call) => call[0] as string);

const bodyText = (container: HTMLElement): string =>
  container.textContent?.replace(/\s+/g, " ") ?? "";

function clickTestId(container: HTMLElement, testId: string): void {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  expect(el, `${testId} 应存在`).toBeTruthy();
  act(() => {
    el!.click();
  });
}

// ── A. 钩子契约：不传 face 的卡面只认翻卡 ─────────────────────────────────

function Probe({ input }: { input: FaceAutoAudioInput }): ReactElement | null {
  useFaceAutoAudio(input);
  return null;
}

function fakeController() {
  return { available: true, playSequence: vi.fn(), stop: vi.fn() };
}

const probeSource = {
  triggerKey: "w-1",
  lemma: "above",
  sentence: "The book is on the shelf above.",
  definition: "在...之上",
};

/** 渲染探针并登记回收；返回可反复 re-render 的句柄（翻卡 = 同实例 props 变化）。 */
function mountProbe(controller: ReturnType<typeof fakeController>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  const render = (revealed: boolean) =>
    act(() => {
      root.render(createElement(Probe, { input: { ...probeSource, revealed, controller } }));
    });
  return { render };
}

describe("钩子契约：不传 face 的卡面（一屏多卡）", () => {
  it("到达不播；翻卡（false 转 true）才播 onReveal", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, onReveal: ["definition"] });
    const controller = fakeController();
    const { render } = mountProbe(controller);

    render(false);
    expect(
      controller.playSequence,
      "到达不该有声（整页同挂会变成齐声混响）",
    ).not.toHaveBeenCalled();

    render(true);
    expect(controller.playSequence).toHaveBeenCalledWith(
      [{ kind: "definition", text: "在...之上" }],
      350,
    );
  });

  it("默认档（onReveal off）：到达与翻卡都静默", () => {
    const controller = fakeController();
    const { render } = mountProbe(controller);
    render(false);
    render(true);
    expect(controller.playSequence).not.toHaveBeenCalled();
  });
});

// ── B. 葫芦冲刺：一屏多卡只认「翻开核对」 ─────────────────────────────────

function makeHuluItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w-${i}`,
    slug: `word-${i}`,
    title: `word-${i}`,
    lemma: `word-${i}`,
    ipa: `/w${i}/`,
    pos: "n.",
    cefr: null,
    short_definition: `释义 ${i}`,
    core_definitions: [{ sense: `义项 ${i}`, en: `sense ${i}`, priority: 1, tags: ["core"] }],
    definition_md: `1. 义项 ${i}`,
    examples: [{ text: `例句 ${i}`, translation: `译 ${i}`, source: "测试语料" }],
    prototype_text: null,
    mnemonic_text: `助记 ${i}`,
    mnemonic_type: "词根",
    semantic_chain: `链 ${i}`,
  }));
}

/** 冲刺路径要的最小一套：建计划 → 读计划 → 开轮次 → 取页。 */
function installHuluApi(): void {
  const plan = {
    id: HULU_PLAN_ID,
    user_id: "u-1",
    wordbook_id: "wb-1",
    direction: null,
    exam_date: "2026-12-20",
    target_rounds: 4,
    page_size: 2,
    gate_ratio: 0.8,
    word_count: 2,
    status: "active",
    suspend_review: false,
    suspended_count: 0,
    started_at: "2026-10-06T00:00:00Z",
    ended_at: null,
    created_at: "2026-10-06T00:00:00Z",
  };
  const round = {
    id: "round-1",
    plan_id: HULU_PLAN_ID,
    user_id: "u-1",
    round_no: 1,
    started_at: "2026-10-06T00:00:00Z",
    ended_at: null,
    elapsed_seconds: null,
    pages_passed: 0,
    words_passed: 0,
    words_total: 2,
  };

  apiFetchMock.mockImplementation(
    async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/hulu/plans" && init?.method === "POST") return plan as never;
      if (path === `/hulu/plans/${HULU_PLAN_ID}`) return { plan, rounds: [] } as never;
      if (path === `/hulu/plans/${HULU_PLAN_ID}/rounds` && init?.method === "POST") {
        return round as never;
      }
      const pageMatch = path.match(/^\/hulu\/plans\/[^/]+\/pages\/(\d+)$/);
      if (pageMatch) {
        return {
          pageIndex: Number(pageMatch[1]),
          pages: 1,
          total: 2,
          alive: 2,
          items: makeHuluItems(2),
        } as never;
      }
      throw new Error(`未预期的请求：${path}`);
    },
  );
}

/** 冲刷挂载后的缓存扫描与异步请求链。 */
async function flush(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

/** 点开「开始冲刺」并等进入冲刺态。 */
async function startSprint(container: HTMLElement): Promise<void> {
  const start = container.querySelector('[data-testid="hulu-start"]') as HTMLButtonElement;
  expect(start, "开始按钮应存在").toBeTruthy();
  await act(async () => {
    start.click();
  });
  await flush();
}

describe("葫芦冲刺：一屏多卡不齐声朗读", () => {
  it("到达静默；翻开核对播一次 onReveal", async () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, onReveal: ["definition"] });
    installHuluApi();
    const container = mountInto(createElement(HuluSprintSession, { onBack: vi.fn() }));
    await flush();
    await startSprint(container);

    // 两张卡同时在页面上：到达时谁都不许出声（不传 face 的那条契约）
    expect(spokenTexts(), "整页同挂时到达不该齐声朗读").toEqual([]);

    clickTestId(container, "hulu-flip-0");
    expect(spokenTexts()).toEqual(["释义 0"]);
  });

  it("默认档（onReveal off）：翻开核对也保持沉默", async () => {
    installHuluApi();
    const container = mountInto(createElement(HuluSprintSession, { onBack: vi.fn() }));
    await flush();
    await startSprint(container);

    clickTestId(container, "hulu-flip-0");
    clickTestId(container, "hulu-flip-1");
    expect(spokenTexts()).toEqual([]);
  });
});

// ── C. 冲刷训练：两个题面都防泄题 ─────────────────────────────────────────

/** 开了 ③b 才谈得上出声，本组用它验证「开了也只读题面上看得到的」。 */
function enableTypingZh(): void {
  writeAutoAudioConfig({
    ...DEFAULT_AUTO_AUDIO_CONFIG,
    faces: { ...DEFAULT_AUTO_AUDIO_CONFIG.faces, "typing-zh": ["definition"] },
  });
}

describe("冲刷训练：题面默认静默（答案在音频里）", () => {
  it("默认档：题面到达不发声", () => {
    mountInto(createElement(DrillSession, { onBack: vi.fn() }));
    expect(spokenTexts()).toEqual([]);
  });

  it("开了 ③b：definition 变体只读题面上的中文释义", () => {
    enableTypingZh();
    drillState.variant = "definition";
    mountInto(createElement(DrillSession, { onBack: vi.fn() }));
    expect(spokenTexts()).toEqual(["在...之上"]);
  });

  it("开了 ③b：cloze 变体不给释义（题面上没有中文，挖空句也不喂给 TTS）", () => {
    enableTypingZh();
    drillState.variant = "cloze";
    mountInto(createElement(DrillSession, { onBack: vi.fn() }));
    expect(spokenTexts()).toEqual([]);
  });
});

// ── D. 听写档：读音就是题面 ───────────────────────────────────────────────

function mountDictation(): HTMLDivElement {
  return mountInto(
    createElement(TypingDictationView, {
      lemma: "above",
      definition: "在...之上",
      onDone: vi.fn(),
    }),
  );
}

describe("听写档（LW-2）：音频即题面", () => {
  it("进入听写档即朗读题面，词形不露", () => {
    const container = mountDictation();
    expect(spokenTexts(), "默写档默认静默（③b 默认关）").toEqual([]);

    clickTestId(container, "tier-listen");
    expect(spokenTexts()).toEqual(["above"]);
    expect(bodyText(container), "听写形态 = 无字形").not.toContain("above");
  });

  it("「重播读音」可再听一次；题面不受自动伴读总闸影响", () => {
    writeAutoAudioConfig({ ...DEFAULT_AUTO_AUDIO_CONFIG, master: false });
    const container = mountDictation();

    clickTestId(container, "tier-listen");
    expect(spokenTexts(), "总闸管伴读，不管题面").toEqual(["above"]);

    clickTestId(container, "listen-replay");
    expect(spokenTexts()).toEqual(["above", "above"]);
  });

  it("环境无发声能力：降级跟写（词形转可见、不留按不响的按钮）", () => {
    speechState.available = false;
    const container = mountDictation();

    clickTestId(container, "tier-listen");
    expect(spokenTexts()).toEqual([]);
    expect(
      container.querySelector('[data-testid="listen-replay"]'),
      "按不响的按钮不该留",
    ).toBeNull();
    expect(bodyText(container), "降级 = 跟写语义（词形可见）").toContain("above");
    expect(bodyText(container)).toContain("降级为跟写");
  });
});
