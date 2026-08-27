/**
 * DrillEngine 单元测试 —— L1 练习变体（cram drill）纯函数引擎。
 *
 * 验证点：
 * - 队列状态机：答对出队、答错回尾计错、晚点再看、首次通过统计
 * - 变体工具：maskLemma 词形遮盖 / normalizeDrillAnswer 答案归一化
 * - cloze 解析：redactLemmaInSentence 精确/后缀变体/去尾-e/子串兜底
 * - findClozeFromExamples 取第一条可挖词
 */

import { describe, it, expect } from "vitest";
import {
  createDrillQueue,
  submitDrillAnswer,
  deferDrillCard,
  remainingInDrill,
  countFirstTryPasses,
  maskLemma,
  normalizeDrillAnswer,
  redactLemmaInSentence,
  findClozeFromExamples,
  CLOZE_BLANK_TOKEN,
  type DrillCard,
} from "@/services/drill-engine";

function makeCard(overrides: Partial<DrillCard> = {}): DrillCard {
  return {
    progressId: "p1",
    wordId: "w1",
    lemma: "abandon",
    title: "Abandon",
    slug: "abandon",
    shortDefinition: "放弃",
    state: "review",
    clozeText: `He decided to ${CLOZE_BLANK_TOKEN} the project.`,
    clozeLength: 7,
    clozeSource: "He decided to abandon the project.",
    ...overrides,
  };
}

describe("createDrillQueue", () => {
  it("enters done phase for an empty deck", () => {
    const state = createDrillQueue([]);
    expect(state.phase).toBe("done");
    expect(state.totalUnique).toBe(0);
  });

  it("preserves deck order and counts unique cards", () => {
    const state = createDrillQueue([makeCard(), makeCard({ progressId: "p2", lemma: "abound" })]);
    expect(state.phase).toBe("playing");
    expect(state.totalUnique).toBe(2);
    expect(state.queue.map((c) => c.progressId)).toEqual(["p1", "p2"]);
  });
});

describe("submitDrillAnswer", () => {
  it("removes the card on a correct answer and marks it passed", () => {
    const state = createDrillQueue([makeCard(), makeCard({ progressId: "p2" })]);
    const { correct, next } = submitDrillAnswer(state, "abandon");
    expect(correct).toBe(true);
    expect(next.queue.length).toBe(1);
    expect(next.queue[0].progressId).toBe("p2");
    expect(next.passedByCard["p1"]).toBe(true);
  });

  it("moves the card to the tail and increments attempts on a wrong answer", () => {
    const state = createDrillQueue([makeCard(), makeCard({ progressId: "p2" })]);
    const { correct, correctAnswer, next } = submitDrillAnswer(state, "wrong");
    expect(correct).toBe(false);
    expect(correctAnswer).toBe("abandon");
    expect(next.queue.map((c) => c.progressId)).toEqual(["p2", "p1"]);
    expect(next.attemptsByCard["p1"]).toBe(1);
  });

  it("normalises case, whitespace and trailing punctuation when comparing", () => {
    const state = createDrillQueue([makeCard()]);
    const { correct } = submitDrillAnswer(state, "  Abandon. ");
    expect(correct).toBe(true);
  });

  it("reaches done phase when the last card is answered correctly", () => {
    const state = createDrillQueue([makeCard()]);
    const { next } = submitDrillAnswer(state, "abandon");
    expect(next.phase).toBe("done");
    expect(remainingInDrill(next)).toBe(0);
  });

  it("is a no-op on an empty queue", () => {
    const state = createDrillQueue([]);
    const { correct, next } = submitDrillAnswer(state, "x");
    expect(correct).toBe(false);
    expect(next).toBe(state);
  });
});

describe("deferDrillCard", () => {
  it("moves the head card to the tail without recording an attempt", () => {
    const state = createDrillQueue([makeCard(), makeCard({ progressId: "p2" })]);
    const next = deferDrillCard(state);
    expect(next.queue.map((c) => c.progressId)).toEqual(["p2", "p1"]);
    expect(Object.keys(next.attemptsByCard)).toHaveLength(0);
  });

  it("leaves a single-card queue unchanged", () => {
    const state = createDrillQueue([makeCard()]);
    expect(deferDrillCard(state).queue).toHaveLength(1);
  });
});

describe("countFirstTryPasses", () => {
  it("counts only cards passed with zero wrong attempts", () => {
    let state = createDrillQueue([
      makeCard(),
      makeCard({ progressId: "p2", lemma: "abound" }),
    ]);
    // p1 答错一次 → 回尾
    ({ next: state } = submitDrillAnswer(state, "wrong"));
    // p2 答对 → passed, 首次通过
    ({ next: state } = submitDrillAnswer(state, "abound"));
    // p1 答对 → passed, 但有过错题
    ({ next: state } = submitDrillAnswer(state, "abandon"));
    expect(state.passedByCard["p2"]).toBe(true);
    expect(countFirstTryPasses(state)).toBe(1);
  });
});

describe("maskLemma", () => {
  it("shows words of length <= 3 in full", () => {
    expect(maskLemma("cat")).toBe("cat");
  });
  it("keeps first and last letter for longer words", () => {
    expect(maskLemma("abandon")).toMatch(/^a.*n$/);
    expect(maskLemma("abandon")).not.toContain("b");
  });
});

describe("normalizeDrillAnswer", () => {
  it("lowercases, trims and strips trailing punctuation", () => {
    expect(normalizeDrillAnswer("  Abandon. ")).toBe("abandon");
    expect(normalizeDrillAnswer("give  up,")).toBe("give up");
    expect(normalizeDrillAnswer("")).toBe("");
  });
});

describe("redactLemmaInSentence", () => {
  it("redacts an exact whole-word match", () => {
    const r = redactLemmaInSentence("He decided to abandon the project.", "abandon");
    expect(r).not.toBeNull();
    expect(r!.text).toContain(CLOZE_BLANK_TOKEN);
    expect(r!.matchedLength).toBe(7);
  });

  it("redacts morphological suffix variants (ing)", () => {
    const r = redactLemmaInSentence("She is abandoning the plan.", "abandon");
    expect(r?.text).toContain(CLOZE_BLANK_TOKEN);
    expect(r?.matchedLength).toBe(10);
  });

  it("applies the drop-final-e rule for -ed/-ing", () => {
    const r = redactLemmaInSentence("They loved the movie.", "love");
    expect(r?.text).toContain(CLOZE_BLANK_TOKEN);
    expect(r?.matchedLength).toBe(5);
  });

  it("falls back to a substring match for non-ASCII text", () => {
    const r = redactLemmaInSentence("这是一个 abandon 示例", "abandon");
    expect(r?.text).toContain(CLOZE_BLANK_TOKEN);
  });

  it("strips simple markdown emphasis before matching", () => {
    const r = redactLemmaInSentence("He **abandoned** the idea.", "abandon");
    expect(r?.text).toContain(CLOZE_BLANK_TOKEN);
    expect(r?.text).not.toContain("*");
  });

  it("returns null when the sentence has no redactable lemma", () => {
    expect(redactLemmaInSentence("Nothing related here.", "abandon")).toBeNull();
    expect(redactLemmaInSentence("", "abandon")).toBeNull();
  });
});

describe("findClozeFromExamples", () => {
  it("picks the first redactable example deterministically", () => {
    const examples = [
      { text: "No match here." },
      { text: "He decided to abandon the plan." },
    ];
    const r = findClozeFromExamples(examples, "abandon");
    expect(r?.text).toContain(CLOZE_BLANK_TOKEN);
    expect(r?.source).toBe("He decided to abandon the plan.");
  });

  it("returns null for empty or unmatchable examples", () => {
    expect(findClozeFromExamples([], "abandon")).toBeNull();
    expect(findClozeFromExamples([{ text: "nothing" }], "abandon")).toBeNull();
    expect(findClozeFromExamples(null, "abandon")).toBeNull();
  });
});
