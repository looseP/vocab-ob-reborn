import { describe, expect, it } from "vitest";
import {
  buildL2ProductionTask,
  collectDistractorPool,
  generateL2DiscriminationTask,
  judgeL2TaskChoice,
  stripAnswer,
} from "../../src/domain/l2-task";

const SESSION = "sess-11111111-1111-4111-8111-111111111111";
const WORD_ID = "w-22222222-2222-4222-8222-222222222222";

function makeWord(overrides: Partial<Parameters<typeof generateL2DiscriminationTask>[0]["word"]> = {}) {
  return {
    lemma: "sustain",
    short_definition: "维持；支撑",
    corpus_items: [
      { text: "Sunlight sustains life on earth.", translation: "阳光维持地球上的生命。" },
      { text: "The shelf can sustain heavy loads." },
    ],
    synonym_items: [
      { word: "maintain", semanticDiff: "maintain 强调保持现状" },
      { word: "support", semanticDiff: "support 偏物理支撑" },
      { word: "endure", semanticDiff: "endure 强调忍受" },
    ],
    antonym_items: [{ word: "abandon", semanticDiff: "" }],
    ...overrides,
  };
}

describe("l2-task generator", () => {
  it("is deterministic for the same session+word seed", () => {
    const a = generateL2DiscriminationTask({ sessionId: SESSION, wordId: WORD_ID, word: makeWord() });
    const b = generateL2DiscriminationTask({ sessionId: SESSION, wordId: WORD_ID, word: makeWord() });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.taskId).toBe(b!.taskId);
    expect(a!.prompt).toBe(b!.prompt);
    expect(a!.options).toEqual(b!.options);
    expect(a!.answerIndex).toBe(b!.answerIndex);
  });

  it("builds a cloze task when corpus hits and distractor pool suffices", () => {
    // 只有 corpus 可用（同义词池清空）→ 必为 cloze_mcq
    const word = makeWord({
      synonym_items: [],
      antonym_items: [
        { word: "maintain", semanticDiff: "" },
        { word: "weaken", semanticDiff: "" },
        { word: "destroy", semanticDiff: "" },
      ],
    });
    const task = generateL2DiscriminationTask({ sessionId: SESSION, wordId: WORD_ID, word });
    expect(task).not.toBeNull();
    expect(task!.taskType).toBe("cloze_mcq");
    expect(task!.prompt).toContain("____");
    expect(task!.options).toHaveLength(4);
    expect(new Set(task!.options).size).toBe(4);
    expect(task!.options).toContain("sustain");
  });

  it("respects word boundaries when matching corpus", () => {
    // "art" 不应命中 "party"
    const word = makeWord({
      lemma: "art",
      corpus_items: [{ text: "It was a party to remember." }],
      synonym_items: [],
      antonym_items: [],
    });
    const task = generateL2DiscriminationTask({ sessionId: SESSION, wordId: WORD_ID, word });
    expect(task).toBeNull(); // 无命中且无辨析素材 → 单步降级信号
  });

  it("returns null when both types are infeasible (degradation signal)", () => {
    const word = makeWord({
      corpus_items: [],
      synonym_items: [],
      antonym_items: [],
    });
    const task = generateL2DiscriminationTask({ sessionId: SESSION, wordId: WORD_ID, word });
    expect(task).toBeNull();
  });

  it("filters distractor pool by hygiene rules", () => {
    const pool = collectDistractorPool(
      makeWord({
        synonym_items: [
          { word: "", semanticDiff: "" },
          { word: "x".repeat(41), semanticDiff: "" },
          { word: "Sustain", semanticDiff: "" }, // 大小写不敏感排除目标词
          { word: "valid", semanticDiff: "" },
        ],
        antonym_items: [],
      }),
      new Set(["sustain"]),
    );
    expect(pool).toEqual(["valid"]);
  });

  it("production task is always feasible and carries hint/reference", () => {
    const task = buildL2ProductionTask({ sessionId: SESSION, wordId: WORD_ID, word: makeWord() });
    expect(task.taskType).toBe("production");
    expect(task.prompt).toContain("sustain");
    expect(task.hintTranslation).toContain("维持");
    expect(task.referenceExample).toContain("sustains");
    expect(task.options).toBeUndefined();
    expect(task.answerIndex).toBeUndefined();
  });

  it("stripAnswer removes answerIndex from API-facing payloads", () => {
    const task = generateL2DiscriminationTask({ sessionId: SESSION, wordId: WORD_ID, word: makeWord() })!;
    const safe = stripAnswer(task);
    expect("answerIndex" in safe).toBe(false);
    // 判分仍可用原始 payload 完成
    expect(judgeL2TaskChoice(task, task.answerIndex!)).toBe(true);
    expect(judgeL2TaskChoice(task, (task.answerIndex! + 1) % 4)).toBe(false);
  });
});

// ─── H4 回归：stepIndex 字段必须出现在响应负载里且等于入参 ─────────────────────
// 响应契约 l2TaskPayloadSchema 要求 stepIndex: z.number().int().nonnegative()。
// 此前 domain L2TaskPayload 接口缺该字段，构建器返回体也不含它，
// 导致响应里 stepIndex 为 undefined，OpenAPI 文档与前端 L2DrillTask 类型失真。
describe("l2-task payload carries stepIndex (H4 regression)", () => {
  it("discrimination task carries stepIndex === 0 when stepIndex omitted", () => {
    const task = generateL2DiscriminationTask({
      sessionId: SESSION,
      wordId: WORD_ID,
      word: makeWord(),
    })!;
    expect(task).not.toBeNull();
    expect(task.stepIndex).toBe(0);
    expect(Number.isInteger(task.stepIndex)).toBe(true);
    expect(task.stepIndex).toBeGreaterThanOrEqual(0);
  });

  it("discrimination task reflects explicit stepIndex", () => {
    const task = generateL2DiscriminationTask({
      sessionId: SESSION,
      wordId: WORD_ID,
      stepIndex: 7,
      word: makeWord(),
    })!;
    expect(task.stepIndex).toBe(7);
  });

  it("production task carries stepIndex === 1 when stepIndex omitted", () => {
    const task = buildL2ProductionTask({
      sessionId: SESSION,
      wordId: WORD_ID,
      word: makeWord(),
    });
    expect(task.stepIndex).toBe(1);
  });

  it("production task reflects explicit stepIndex", () => {
    const task = buildL2ProductionTask({
      sessionId: SESSION,
      wordId: WORD_ID,
      stepIndex: 3,
      word: makeWord(),
    });
    expect(task.stepIndex).toBe(3);
  });

  it("stripAnswer preserves stepIndex (answerIndex-only剥离)", () => {
    const task = generateL2DiscriminationTask({
      sessionId: SESSION,
      wordId: WORD_ID,
      word: makeWord(),
    })!;
    const safe = stripAnswer(task);
    expect("answerIndex" in safe).toBe(false);
    expect(safe.stepIndex).toBe(task.stepIndex);
  });

  it("stepIndex stays consistent across seeds for the same (session, word, step)", () => {
    for (let i = 0; i < 50; i++) {
      const task = generateL2DiscriminationTask({
        sessionId: `h4-${i}`,
        wordId: WORD_ID,
        stepIndex: 0,
        word: makeWord(),
      });
      if (!task) continue;
      expect(task.stepIndex).toBe(0);
    }
  });
});

describe("l2-task option hygiene (regression)", () => {
  const hygWord = {
    lemma: "sustain",
    short_definition: "maintain",
    corpus_items: [],
    synonym_items: [
      { word: "maintain", semanticDiff: "d1" },
      { word: "support", semanticDiff: "d2" },
      { word: "endure", semanticDiff: "d3" },
    ],
    antonym_items: [],
  };

  it("synonym discrimination options are always 4 distinct words across seeds", () => {
    const synonymWords = new Set(["maintain", "support", "endure"]);
    for (let i = 0; i < 300; i++) {
      const task = generateL2DiscriminationTask({ sessionId: `s-${i}`, wordId: "w1", word: hygWord });
      expect(task).not.toBeNull();
      const opts = task!.options ?? [];
      expect(opts).toHaveLength(4);
      expect(new Set(opts).size).toBe(4);
      // 目标词恰好出现一次
      expect(opts.filter((o) => o === "sustain")).toHaveLength(1);
      // 答案必须是某个同义词（贴合差异描述的词），且槽位一致
      const answer = task!.options![task!.answerIndex!];
      expect(synonymWords.has(answer)).toBe(true);
    }
  });

  it("cloze options stay distinct across seeds too", () => {
    const clozeWord = {
      ...hygWord,
      corpus_items: [{ text: "Sunlight can sustain life on earth." }],
    };
    let checked = 0;
    for (let i = 0; i < 100; i++) {
      const task = generateL2DiscriminationTask({ sessionId: `c-${i}`, wordId: "w2", word: clozeWord });
      if (!task || task.taskType !== "cloze_mcq") continue;
      checked++;
      expect(new Set(task.options ?? []).size).toBe(4);
      expect(task.options![task.answerIndex!]).toBe("sustain");
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ─── 对抗性属性化扫描（H1/H2 回归）─────────────────────────────────────────
// H1：cloze 原句中 lemma 出现 ≥2 次时，replace 只换第一处 → prompt 仍含明文答案
// H2：synonym_items 中存在 word === lemma 的脏数据时，options 出现重复且判分错位
// 这两条属性在当前实现下应当失败（红色测试），用于在修复前暴露 bug、修复后防止回归。

/** 词边界匹配计数（带 g 标志，统计所有出现次数；与源码 buildClozeMcq 的 "i" 标志对照）。 */
function countBoundaryMatches(text: string, lemma: string): number {
  const escaped = lemma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, "gi");
  return [...text.matchAll(re)].length;
}

/** H1 触发数据：corpus 句中 lemma 裸词出现 ≥2 次，synonym 清空强制走 cloze。 */
function makeClozeLemmaRepeatWord() {
  return {
    lemma: "sustain",
    short_definition: "维持",
    corpus_items: [
      { text: "To sustain growth is to sustain quality." }, // "sustain" × 2
      { text: "We sustain the project to sustain the team." }, // "sustain" × 2
    ],
    synonym_items: [], // 强制走 cloze
    antonym_items: [
      { word: "maintain", semanticDiff: "" },
      { word: "support", semanticDiff: "" },
      { word: "endure", semanticDiff: "" },
    ],
  };
}

/**
 * H2 触发数据：synonym_items 含 word === lemma 的自指脏数据 + 合法同义词混合。
 * 修复后脏数据被过滤，合法候选仍能产出任务，且 options 四项互异。
 */
function makeSynonymSelfReferentialWord() {
  return {
    lemma: "sustain",
    short_definition: "维持",
    corpus_items: [], // 强制走 synonym
    synonym_items: [
      { word: "sustain", semanticDiff: "self-referential 脏数据" }, // ← H2 触发（修复后被过滤）
      { word: "maintain", semanticDiff: "保持现状" }, // 合法
      { word: "support", semanticDiff: "物理支撑" }, // 合法
      { word: "endure", semanticDiff: "忍受" }, // 合法
    ],
    antonym_items: [
      { word: "weaken", semanticDiff: "" },
      { word: "destroy", semanticDiff: "" },
      { word: "release", semanticDiff: "" },
    ],
  };
}

describe("l2-task adversarial property scan (H1/H2 regression)", () => {
  it("H1: cloze prompt must not leak lemma when corpus contains it ≥2 times", () => {
    const word = makeClozeLemmaRepeatWord();
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const task = generateL2DiscriminationTask({
        sessionId: `h1-${i}`,
        wordId: "w-h1",
        word,
      });
      if (!task || task.taskType !== "cloze_mcq") continue;
      checked++;
      // (a) prompt 中 lemma 按词边界出现次数必须为 0（无答案泄漏）
      expect(countBoundaryMatches(task.prompt, word.lemma)).toBe(0);
      // (b) options 四项互异
      expect(task.options).toHaveLength(4);
      expect(new Set(task.options).size).toBe(4);
      // (c) answerIndex 处必须是 lemma
      expect(task.options![task.answerIndex!]).toBe(word.lemma);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("H2: synonym options stay distinct when chosen.word === lemma (dirty data)", () => {
    const word = makeSynonymSelfReferentialWord();
    let checked = 0;
    for (let i = 0; i < 50; i++) {
      const task = generateL2DiscriminationTask({
        sessionId: `h2-${i}`,
        wordId: "w-h2",
        word,
      });
      if (!task || task.taskType !== "synonym_discrimination") continue;
      checked++;
      // (a) options 四项互异
      expect(task.options).toHaveLength(4);
      expect(new Set(task.options).size).toBe(4);
      // (b) answerIndex 处的词在其余 3 个槽位不出现
      const answer = task.options![task.answerIndex!];
      const otherSlots = task.options!.filter((_, idx) => idx !== task.answerIndex);
      expect(otherSlots).not.toContain(answer);
      // (c) judgeL2TaskChoice 一致性：相同字符串的槽位必须同判定
      //     （不能出现"答 A 槽位对、答相同字符串的 B 槽位错"的判分歧义）
      const groupedByValue = new Map<string, number[]>();
      task.options!.forEach((opt, idx) => {
        const arr = groupedByValue.get(opt) ?? [];
        arr.push(idx);
        groupedByValue.set(opt, arr);
      });
      for (const indices of groupedByValue.values()) {
        const verdicts = indices.map((idx) => judgeL2TaskChoice(task, idx));
        const allTrue = verdicts.every((v) => v === true);
        const allFalse = verdicts.every((v) => v === false);
        expect(allTrue || allFalse).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("H1+H2 combined: judgeL2TaskChoice has no ambiguous scoring across data shapes × seeds", () => {
    const scenarios = [
      { name: "cloze-clean", word: makeWord() },
      { name: "cloze-lemma-repeat", word: makeClozeLemmaRepeatWord() },
      { name: "synonym-self-ref", word: makeSynonymSelfReferentialWord() },
    ];
    for (const { name, word } of scenarios) {
      for (let i = 0; i < 100; i++) {
        const task = generateL2DiscriminationTask({
          sessionId: `scan-${name}-${i}`,
          wordId: `w-${name}`,
          word,
        });
        if (!task || !task.options || task.answerIndex === undefined) continue;
        // answerIndex 处必须判定 true
        expect(judgeL2TaskChoice(task, task.answerIndex)).toBe(true);
        // 关键：与 answerIndex 处字符串相同的所有槽位必须同样判定 true
        //   当前 judgeL2TaskChoice 只比较 index 不比较值，一旦 options 出现重复
        //   （H1/H2 bug 触发），就会出现"答相同字符串但判定不同"的歧义
        const answerValue = task.options[task.answerIndex];
        for (let idx = 0; idx < 4; idx++) {
          if (task.options[idx] === answerValue) {
            expect(judgeL2TaskChoice(task, idx)).toBe(true);
          }
        }
      }
    }
  });
});