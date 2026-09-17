import { describe, expect, it } from "vitest";
import {
  DICTATION_BLANK_MARKER,
  DICTATION_NORMALIZATION,
  MAX_PROMPT_TEXT_LENGTH,
  buildContextQuizTask,
  buildEssayDictationTask,
  deterministicTaskId,
  l3PracticePrng,
  l3PracticeSeed,
  normalizeDictationText,
} from "@/domain/l3-practice-task";
import type { L3PracticeTask } from "@/domain/l3-practice-task";

const CONTEXT = {
  id: "ctx-0001",
  text: "The contemplative mind resists the urge to react.",
};
const OCCURRENCE = {
  id: "occ-0001",
  surface: "contemplative",
  lemma: "contemplate",
};

/** 把 cloze 结果还原成原句（判定空位下标与期望填入串自洽）。 */
function restoreCloze(task: L3PracticeTask): string {
  const index = task.prompt.blankIndex as number;
  return (
    task.prompt.text.slice(0, index) +
    (task.answer.blankText ?? "") +
    task.prompt.text.slice(index + DICTATION_BLANK_MARKER.length)
  );
}

function required(task: L3PracticeTask | null): L3PracticeTask {
  if (task === null) throw new Error("expected a task, got null");
  return task;
}

describe("l3PracticeSeed / deterministicTaskId", () => {
  it("种子 = sessionId:contextId:attemptIndex", () => {
    expect(l3PracticeSeed("sess-1", "ctx-1", 0)).toBe("sess-1:ctx-1:0");
    expect(l3PracticeSeed("sess-1", "ctx-1", 3)).toBe("sess-1:ctx-1:3");
  });

  it("taskId = sha256(seed) 前 16 位 + 题型前缀，同种子恒同 id", () => {
    const seed = l3PracticeSeed("sess-1", "ctx-1", 0);
    const id = deterministicTaskId("essay_dictation", seed);
    expect(id).toMatch(/^essay_dictation:[0-9a-f]{16}$/);
    expect(deterministicTaskId("essay_dictation", seed)).toBe(id);
    expect(deterministicTaskId("context_quiz", seed)).not.toBe(id);
    expect(deterministicTaskId("essay_dictation", l3PracticeSeed("sess-1", "ctx-1", 1))).not.toBe(id);
  });

  it("PRNG 同种子同序列、不同种子不同序列", () => {
    const a = l3PracticePrng("seed-a");
    const b = l3PracticePrng("seed-a");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(l3PracticePrng("seed-a")()).not.toBe(l3PracticePrng("seed-b")());
  });
});

describe("buildEssayDictationTask", () => {
  const seed = l3PracticeSeed("sess-1", CONTEXT.id, 0);

  it("cloze（默认）：挖空目标词、下标自洽、携带期望填入串与词形提示", () => {
    const task = required(buildEssayDictationTask({ context: CONTEXT, occurrence: OCCURRENCE, seed }));

    expect(task.taskId).toBe(deterministicTaskId("essay_dictation", seed));
    expect(task.practiceType).toBe("essay_dictation");
    expect(task.contextId).toBe(CONTEXT.id);
    expect(task.occurrenceId).toBe(OCCURRENCE.id);
    expect(task.prompt.target).toBe("contemplative");
    expect(task.prompt.truncated).toBe(false);
    expect(task.prompt.blankIndex).toBe(CONTEXT.text.indexOf("contemplative"));
    expect(task.prompt.text).toBe("The ____ mind resists the urge to react.");
    expect(task.prompt.text).not.toContain("contemplative");
    expect(task.answer.text).toBe(CONTEXT.text);
    expect(task.answer.blankText).toBe("contemplative");
    expect(task.answer.hidden).toBe(false);
    expect(task.answer.normalization).toBe(DICTATION_NORMALIZATION);
    expect(task.hints).toEqual([`词形提示：c${"_".repeat(12)}`]);
    expect(restoreCloze(task)).toBe(task.answer.text);
  });

  it("cloze：句中的实际片段保留原句大小写", () => {
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-case", text: "Contemplate the void, then rest." },
        occurrence: { id: "occ-case", surface: "contemplate" },
        seed,
      }),
    );
    expect(task.answer.blankText).toBe("Contemplate");
    expect(task.prompt.blankIndex).toBe(0);
    expect(task.prompt.text).toBe("____ the void, then rest.");
  });

  it("full（参数定）：不出空位，整句即答案", () => {
    const task = required(
      buildEssayDictationTask({ context: CONTEXT, occurrence: OCCURRENCE, mode: "full", seed }),
    );
    expect(task.prompt.text).toBe(CONTEXT.text);
    expect(task.prompt.blankIndex).toBeNull();
    expect(task.prompt.target).toBe("contemplative");
    expect(task.answer.text).toBe(CONTEXT.text);
    expect(task.answer.blankText).toBeNull();
    expect(task.hints).toEqual(["句中需用到目标词：contemplative"]);
  });

  it("无 occurrence 默认 full：无空位、无提示、不带 occurrenceId", () => {
    const task = required(buildEssayDictationTask({ context: CONTEXT, seed }));
    expect(task.prompt.text).toBe(CONTEXT.text);
    expect(task.prompt.blankIndex).toBeNull();
    expect(task.prompt.target).toBeNull();
    expect(task.occurrenceId).toBeUndefined();
    expect(task.hints).toBeUndefined();
  });

  it("无 occurrence + 显式 cloze → null（没有目标词不能挖空）", () => {
    expect(buildEssayDictationTask({ context: CONTEXT, mode: "cloze", seed })).toBeNull();
  });

  it("空文本 → null（cloze / full 都不出题）", () => {
    const blankContext = { id: "ctx-blank", text: "   " };
    expect(
      buildEssayDictationTask({ context: blankContext, occurrence: OCCURRENCE, seed }),
    ).toBeNull();
    expect(buildEssayDictationTask({ context: blankContext, seed })).toBeNull();
  });

  it("surface 定位不到时回退 lemma", () => {
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-lemma", text: "They contemplate the void every evening." },
        occurrence: { id: "occ-lemma", surface: "contemplates", lemma: "contemplate" },
        seed,
      }),
    );
    expect(task.prompt.target).toBe("contemplate");
    expect(task.answer.blankText).toBe("contemplate");
    expect(task.prompt.text).toBe("They ____ the void every evening.");
  });

  it("surface / lemma 都定位不到：cloze → null，full 仍可出题（仅作提醒）", () => {
    const occurrence = { id: "occ-drift", surface: "sustain", lemma: "sustained" };
    expect(buildEssayDictationTask({ context: CONTEXT, occurrence, seed })).toBeNull();

    const task = required(
      buildEssayDictationTask({ context: CONTEXT, occurrence, mode: "full", seed }),
    );
    expect(task.prompt.text).toBe(CONTEXT.text);
    expect(task.prompt.target).toBe("sustain");
    expect(task.hints).toEqual(["句中需用到目标词：sustain"]);
  });

  it("词边界：art 不命中 party（无命中则 cloze 不出题）", () => {
    const task = buildEssayDictationTask({
      context: { id: "ctx-boundary", text: "The party started at nine." },
      occurrence: { id: "occ-art", surface: "art" },
      seed,
    });
    expect(task).toBeNull();
  });

  it("短语词面同样可挖空", () => {
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-phrase", text: "They went on in spite of the rain." },
        occurrence: { id: "occ-phrase", surface: "in spite of" },
        seed,
      }),
    );
    expect(task.prompt.text).toBe("They went on ____ the rain.");
    expect(task.answer.blankText).toBe("in spite of");
    expect(task.hints).toEqual(["词形提示：i_ s____ o_"]);
  });

  it("多出现位置：同种子恒同位，不同种子覆盖不同位置", () => {
    const context = { id: "ctx-multi", text: "The contemplative mind and the contemplative heart rest." };
    const seeds = Array.from({ length: 24 }, (_, index) => l3PracticeSeed("sess-1", context.id, index));
    const tasks = seeds.map((each) =>
      required(buildEssayDictationTask({ context, occurrence: OCCURRENCE, seed: each })),
    );

    // 同种子恒同位（确定性）
    const again = required(buildEssayDictationTask({ context, occurrence: OCCURRENCE, seed: seeds[0] }));
    expect(again.prompt.blankIndex).toBe(tasks[0]!.prompt.blankIndex);
    // 24 个种子覆盖两个出现位置（PRNG 真的参与了选位）
    const indexes = new Set(tasks.map((task) => task.prompt.blankIndex));
    expect(indexes.size).toBe(2);
    // 每个任务的空位都自洽
    for (const task of tasks) {
      expect(restoreCloze(task)).toBe(task.answer.text);
      expect(task.prompt.text).toContain(DICTATION_BLANK_MARKER);
    }
  });

  it("超长句截断：以目标词为中心窗口化，空位仍在窗口内且下标自洽", () => {
    const text = `${"averyverylongsegment ".repeat(12)}contemplative${" trailingwords".repeat(12)}`;
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-long", text },
        occurrence: { id: "occ-long", surface: "contemplative" },
        seed,
      }),
    );

    expect(task.prompt.truncated).toBe(true);
    expect(task.prompt.text.startsWith("…")).toBe(true);
    expect(task.prompt.text.endsWith("…")).toBe(true);
    expect(task.answer.text.length).toBe(MAX_PROMPT_TEXT_LENGTH + 2);
    // prompt 用空位标记替换目标词：长度 = 窗口 - 词长 + 标记长
    const blankText = task.answer.blankText ?? "";
    expect(task.prompt.text.length).toBe(
      MAX_PROMPT_TEXT_LENGTH + 2 - blankText.length + DICTATION_BLANK_MARKER.length,
    );
    expect(restoreCloze(task)).toBe(task.answer.text);
    expect(task.answer.text).toContain("contemplative");
  });

  it("超长句截断：目标词贴近句首时不加前缀省略号", () => {
    const text = `contemplative ${"z".repeat(300)}`;
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-head", text },
        occurrence: { id: "occ-head", surface: "contemplative" },
        seed,
      }),
    );
    expect(task.prompt.truncated).toBe(true);
    expect(task.prompt.text.startsWith("…")).toBe(false);
    expect(task.prompt.text.endsWith("…")).toBe(true);
    expect(task.prompt.blankIndex).toBe(0);
    expect(restoreCloze(task)).toBe(task.answer.text);
  });

  it("超长句截断：目标词贴近句尾时贴齐右边界、不加后缀省略号", () => {
    const text = `${"z".repeat(300)} contemplative`;
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-tail", text },
        occurrence: { id: "occ-tail", surface: "contemplative" },
        seed,
      }),
    );
    expect(task.prompt.truncated).toBe(true);
    expect(task.prompt.text.startsWith("…")).toBe(true);
    expect(task.prompt.text.endsWith("…")).toBe(false);
    expect(task.answer.text).toContain("contemplative");
    expect(restoreCloze(task)).toBe(task.answer.text);
  });

  it("病态长目标串：整段仍完整落在窗口内（右边界外扩）", () => {
    const longSurface = "z".repeat(200);
    const task = required(
      buildEssayDictationTask({
        context: { id: "ctx-huge", text: longSurface },
        occurrence: { id: "occ-huge", surface: longSurface },
        seed,
      }),
    );
    expect(task.answer.text).toContain(longSurface);
    expect(task.answer.blankText).toBe(longSurface);
    // 整段恰好就是窗口 → 没有内容被切掉
    expect(task.prompt.truncated).toBe(false);
    expect(restoreCloze(task)).toBe(task.answer.text);
  });

  it("同 seed 同输入 → 完全同题（可幂等重放）", () => {
    const build = () => buildEssayDictationTask({ context: CONTEXT, occurrence: OCCURRENCE, seed });
    expect(build()).toEqual(build());
  });
});

describe("buildContextQuizTask", () => {
  const seed = l3PracticeSeed("sess-1", CONTEXT.id, 0);

  it("原句展示 + 隐藏 bound sense（判定数据即答案）", () => {
    const task = required(
      buildContextQuizTask({
        context: CONTEXT,
        occurrence: { ...OCCURRENCE, boundSense: "沉思的；冥想的" },
        seed,
      }),
    );

    expect(task.taskId).toBe(deterministicTaskId("context_quiz", seed));
    expect(task.practiceType).toBe("context_quiz");
    expect(task.contextId).toBe(CONTEXT.id);
    expect(task.occurrenceId).toBe(OCCURRENCE.id);
    expect(task.prompt.text).toBe(CONTEXT.text);
    expect(task.prompt.target).toBe("contemplative");
    expect(task.prompt.blankIndex).toBeNull();
    expect(task.prompt.truncated).toBe(false);
    expect(task.answer.text).toBe("沉思的；冥想的");
    expect(task.answer.blankText).toBeNull();
    expect(task.answer.hidden).toBe(true);
    expect(task.answer.normalization).toBeNull();
    expect(task.hints).toBeUndefined();
  });

  it("boundSense 缺失或纯空白 → null（回退由装配层用 short_definition 兜底）", () => {
    const base = { context: CONTEXT, seed };
    expect(buildContextQuizTask({ ...base, occurrence: OCCURRENCE })).toBeNull();
    expect(
      buildContextQuizTask({ ...base, occurrence: { ...OCCURRENCE, boundSense: "" } }),
    ).toBeNull();
    expect(
      buildContextQuizTask({ ...base, occurrence: { ...OCCURRENCE, boundSense: "  " } }),
    ).toBeNull();
  });

  it("空文本 → null", () => {
    expect(
      buildContextQuizTask({
        context: { id: "ctx-blank", text: "\n" },
        occurrence: { ...OCCURRENCE, boundSense: "沉思的" },
        seed,
      }),
    ).toBeNull();
  });

  it("surface 未命中退 lemma；都没有目标串也不拦出题", () => {
    const withLemma = required(
      buildContextQuizTask({
        context: { id: "ctx-lemma", text: "They contemplate the void." },
        occurrence: { id: "occ-1", surface: "contemplates", lemma: "contemplate", boundSense: "沉思" },
        seed,
      }),
    );
    expect(withLemma.prompt.target).toBe("contemplate");

    const noTarget = required(
      buildContextQuizTask({
        context: { id: "ctx-drift", text: "They contemplate the void." },
        occurrence: { id: "occ-2", surface: "", lemma: "", boundSense: "沉思" },
        seed,
      }),
    );
    expect(noTarget.prompt.target).toBeNull();
    expect(noTarget.prompt.text).toBe("They contemplate the void.");
  });

  it("超长句截断：窗口锚定目标词首次出现", () => {
    const text = `${"averyverylongsegment ".repeat(12)}contemplative${" trailingwords".repeat(12)}`;
    const task = required(
      buildContextQuizTask({
        context: { id: "ctx-long", text },
        occurrence: { id: "occ-long", surface: "contemplative", boundSense: "沉思的" },
        seed,
      }),
    );
    expect(task.prompt.truncated).toBe(true);
    expect(task.prompt.text.length).toBe(MAX_PROMPT_TEXT_LENGTH + 2);
    expect(task.prompt.text).toContain("contemplative");
    expect(task.answer.text).toBe("沉思的");
  });

  it("同 seed 同输入 → 完全同题", () => {
    const build = () =>
      buildContextQuizTask({
        context: CONTEXT,
        occurrence: { ...OCCURRENCE, boundSense: "沉思的" },
        seed,
      });
    expect(build()).toEqual(build());
  });
});

describe("normalizeDictationText", () => {
  it("折叠空白 + 去首尾 + 小写", () => {
    expect(normalizeDictationText("  The   Mind\nResists  ")).toBe("the mind resists");
  });

  it("NFKC 归一（全角字母/数字/全角空格）", () => {
    expect(normalizeDictationText("ＡＢＣ　１２３")).toBe("abc 123");
  });

  it("标点不宽容：默写要还原原句标点", () => {
    expect(normalizeDictationText("Rest.")).toBe("rest.");
    expect(normalizeDictationText("rest")).not.toBe(normalizeDictationText("rest."));
  });
});
