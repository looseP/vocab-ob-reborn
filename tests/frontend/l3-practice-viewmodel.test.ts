/**
 * T11 练习 viewModel 纯函数测试（node 环境）：
 * 出题（挖空 / 跳过计数）、目标词边界定位、快照读写、展示标签。
 */
import { describe, expect, it } from "vitest";
import type { L3OccurrenceListItem } from "@/domain";
import {
  buildPracticeSnapshot,
  buildPracticeTasks,
  findFirstTargetMatch,
  judgeDictation,
  newPracticeRunId,
  outcomeLabel,
  practiceTypeLabel,
  readPracticeSnapshot,
} from "@/frontend/viewModels/l3PracticeViewModel";

function occurrenceItem(overrides: {
  text?: string;
  surface?: string;
  lemma?: string | null;
  boundSense?: string | null;
  id?: string;
  contextId?: string;
} = {}): L3OccurrenceListItem {
  return {
    occurrence: {
      id: overrides.id ?? "occ-1",
      context_id: overrides.contextId ?? "ctx-1",
      word_id: "w1",
      user_id: "u1",
      surface: overrides.surface === undefined ? "vivid" : overrides.surface,
      lemma: overrides.lemma === undefined ? null : overrides.lemma,
      start_offset: null,
      end_offset: null,
      confidence: null,
      evidence: {},
      bound_sense: overrides.boundSense === undefined ? "生动鲜明的" : overrides.boundSense,
      created_at: "2026-09-12T00:00:00.000Z",
    },
    word: { id: "w1", slug: "vivid", title: "vivid" },
    context: {
      id: overrides.contextId ?? "ctx-1",
      source_id: "src-1",
      user_id: "u1",
      context_type: "sentence",
      text: overrides.text ?? "The vivid sunset faded.",
      normalized_text: null,
      language: "en",
      position: {},
      metadata: {},
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T00:00:00.000Z",
    },
    source: {
      id: "src-1",
      user_id: "u1",
      wordbook_id: "wb-1",
      source_type: "manual",
      title: "来源 A",
      author: null,
      url: null,
      language: "en",
      metadata: {},
      content_text: null,
      content_hash: null,
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T00:00:00.000Z",
    },
  };
}

describe("l3PracticeViewModel builders", () => {
  it("blanks the target word for dictation and keeps the expected fragment", () => {
    const built = buildPracticeTasks([occurrenceItem()], "essay_dictation");
    expect(built.skipped).toBe(0);
    expect(built.tasks).toHaveLength(1);
    const task = built.tasks[0];
    expect(task.promptText).toBe("The ____ sunset faded.");
    expect(task.blankText).toBe("vivid");
    expect(task.target).toBe("vivid");
    expect(task.boundSense).toBeNull();
  });

  it("counts skipped items when the target cannot be located or is missing", () => {
    const noMatch = occurrenceItem({ surface: "banana", lemma: null });
    const noTarget = occurrenceItem({ surface: "", lemma: null, id: "occ-2", contextId: "ctx-2" });
    const built = buildPracticeTasks([noMatch, noTarget, occurrenceItem()], "essay_dictation");
    expect(built.tasks).toHaveLength(1);
    expect(built.skipped).toBe(2);
  });

  it("falls back to the lemma when the surface does not match", () => {
    const built = buildPracticeTasks(
      [occurrenceItem({ surface: "faded away", lemma: "faded" })],
      "essay_dictation",
    );
    expect(built.tasks).toHaveLength(1);
    expect(built.tasks[0].blankText).toBe("faded");
  });

  it("skips context quiz items without a bound sense and builds the rest", () => {
    const withoutSense = occurrenceItem({ boundSense: null, id: "occ-2", contextId: "ctx-2" });
    const built = buildPracticeTasks([withoutSense, occurrenceItem()], "context_quiz");
    expect(built.skipped).toBe(1);
    expect(built.tasks).toHaveLength(1);
    expect(built.tasks[0].promptText).toBe("The vivid sunset faded.");
    expect(built.tasks[0].boundSense).toBe("生动鲜明的");
    expect(built.tasks[0].blankText).toBeNull();
  });

  it("skips blank contexts", () => {
    const built = buildPracticeTasks([occurrenceItem({ text: "   " })], "essay_dictation");
    expect(built.tasks).toHaveLength(0);
    expect(built.skipped).toBe(1);
  });
});

describe("findFirstTargetMatch", () => {
  it("respects word boundaries and case", () => {
    expect(findFirstTargetMatch("The party was fun.", "art")).toBeNull();
    const match = findFirstTargetMatch("The Party was fun.", "party");
    expect(match).not.toBeNull();
    expect(match?.text).toBe("Party");
  });

  it("returns the first of several occurrences", () => {
    const match = findFirstTargetMatch("vivid sky, vivid dreams.", "vivid");
    expect(match?.start).toBe(0);
  });

  it("returns null when the target never appears", () => {
    expect(findFirstTargetMatch("The sunset faded.", "vivid")).toBeNull();
  });
});

describe("practice snapshots and labels", () => {
  it("reads snapshots defensively", () => {
    expect(readPracticeSnapshot(null)).toEqual({ text: null, target: null });
    expect(readPracticeSnapshot([])).toEqual({ text: null, target: null });
    expect(readPracticeSnapshot("nope")).toEqual({ text: null, target: null });
    expect(readPracticeSnapshot({ text: "  ", target: "vivid" })).toEqual({ text: null, target: "vivid" });
    expect(readPracticeSnapshot({ text: "A sentence.", target: "vivid" })).toEqual({
      text: "A sentence.",
      target: "vivid",
    });
  });

  it("builds an attempt snapshot from a task", () => {
    const built = buildPracticeTasks([occurrenceItem()], "essay_dictation");
    const snapshot = buildPracticeSnapshot({ task: built.tasks[0], userInput: "vividly" });
    expect(snapshot).toMatchObject({
      text: "The vivid sunset faded.",
      target: "vivid",
      prompt: "The ____ sunset faded.",
      expected: "vivid",
      input: "vividly",
    });
    expect(buildPracticeSnapshot({ task: built.tasks[0] }).input).toBeNull();
  });

  it("exposes Chinese labels", () => {
    expect(outcomeLabel("correct")).toBe("正确");
    expect(outcomeLabel("wrong")).toBe("错误");
    expect(outcomeLabel("skip")).toBe("跳过");
    expect(outcomeLabel(null)).toBe("—");
    expect(practiceTypeLabel("essay_dictation")).toBe("作文句默写");
    expect(practiceTypeLabel("context_quiz")).toBe("语境义自测");
  });

  it("generates a non-empty run id", () => {
    const runId = newPracticeRunId();
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps judging symmetric with normalization", () => {
    expect(judgeDictation("VIVID", "vivid")).toBe(true);
  });
});
