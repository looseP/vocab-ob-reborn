import { describe, expect, it } from "vitest";
import {
  annotationTagDictSchema,
  PRESET_ENTRY_TAGS,
  PRESET_OPTION_TAGS,
  questionAnnotationInputSchema,
  questionAnnotationPatchSchema,
} from "@/domain/l3-annotations";

const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

describe("preset tag taxonomy", () => {
  it("exposes the six frozen entry-tag labels", () => {
    expect([...PRESET_ENTRY_TAGS]).toEqual([
      "细节题", "推断题", "主旨题", "态度题", "词汇题", "例证题",
    ]);
  });

  it("exposes the seven frozen option-error labels", () => {
    expect([...PRESET_OPTION_TAGS]).toEqual([
      "同义替换", "偷换概念", "无中生有", "过度推断", "正反颠倒", "张冠李戴", "答非所问",
    ]);
  });
});

describe("questionAnnotationInputSchema", () => {
  it("accepts an anchored entry with the full anchor triple", () => {
    const parsed = questionAnnotationInputSchema.parse({
      questionId: QUESTION_ID,
      anchorStart: 10,
      anchorEnd: 18,
      excerpt: "the trap phrase",
      note: "选项 B 偷换主语",
      entryTags: ["推断题"],
      optionTags: { B: ["偷换概念"] },
    });
    expect(parsed.anchorStart).toBe(10);
    expect(parsed.optionTags.B).toEqual(["偷换概念"]);
  });

  it("defaults anchor fields/tags when omitted and accepts a note-only loose entry", () => {
    const parsed = questionAnnotationInputSchema.parse({
      questionId: QUESTION_ID,
      note: "题型归因",
    });
    expect(parsed.anchorStart).toBeNull();
    expect(parsed.anchorEnd).toBeNull();
    expect(parsed.excerpt).toBeNull();
    expect(parsed.entryTags).toEqual([]);
    expect(parsed.optionTags).toEqual({});
  });

  it("accepts an anchored entry without note or tags (anchor alone is content)", () => {
    const result = questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID,
      anchorStart: 0,
      anchorEnd: 5,
      excerpt: "The q",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid questionId", () => {
    expect(questionAnnotationInputSchema.safeParse({ questionId: "q-1" }).success).toBe(false);
  });

  it("rejects anchor start without end (pairwise nullity)", () => {
    const result = questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, anchorStart: 10, note: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("成对"))).toBe(true);
    }
  });

  it("rejects anchor end without start", () => {
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, anchorEnd: 10, note: "x",
    }).success).toBe(false);
  });

  it("rejects anchor end <= start", () => {
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, anchorStart: 10, anchorEnd: 10, excerpt: "x",
    }).success).toBe(false);
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, anchorStart: 10, anchorEnd: 4, excerpt: "x",
    }).success).toBe(false);
  });

  it("rejects an anchor without excerpt and excerpt without an anchor", () => {
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, anchorStart: 0, anchorEnd: 5,
    }).success).toBe(false);
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, excerpt: "lonely excerpt",
    }).success).toBe(false);
  });

  it("rejects an empty loose entry (no anchor, no note, no tags)", () => {
    const result = questionAnnotationInputSchema.safeParse({ questionId: QUESTION_ID });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("空条目"))).toBe(true);
    }
  });

  it("rejects blank/over-long tags and caps entryTags at 8", () => {
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, entryTags: ["  "],
    }).success).toBe(false);
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, entryTags: ["a".repeat(31)],
    }).success).toBe(false);
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, note: "x",
      entryTags: Array.from({ length: 9 }, (_, i) => `标签${i}`),
    }).success).toBe(false);
  });

  it("rejects option tags keyed outside the A–D whitelist and caps one key at 8", () => {
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, optionTags: { E: ["无中生有"] },
    }).success).toBe(false);
    expect(questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, note: "x",
      optionTags: { A: Array.from({ length: 9 }, (_, i) => `错因${i}`) },
    }).success).toBe(false);
  });

  it("accepts multiple A–D keys carrying error tags", () => {
    const result = questionAnnotationInputSchema.safeParse({
      questionId: QUESTION_ID, note: "x",
      optionTags: { A: ["同义替换"], C: ["无中生有", "过度推断"] },
    });
    expect(result.success).toBe(true);
  });
});

describe("questionAnnotationPatchSchema", () => {
  it("accepts a partial note patch without questionId", () => {
    const parsed = questionAnnotationPatchSchema.parse({ note: "改后的分析" });
    expect(parsed.note).toBe("改后的分析");
  });

  it("strips questionId from a patch (not an updatable field)", () => {
    const parsed = questionAnnotationPatchSchema.parse({
      note: "x",
      questionId: QUESTION_ID,
    }) as Record<string, unknown>;
    expect("questionId" in parsed).toBe(false);
  });

  it("keeps unsubmitted patch keys truly absent (defaults must not wipe untouched columns)", () => {
    const parsed = questionAnnotationPatchSchema.parse({ note: "只改笔记" }) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["note"]);
  });

  it("allows clearing entryTags alone without triggering the empty-entry rule", () => {
    const parsed = questionAnnotationPatchSchema.parse({ entryTags: [] }) as Record<string, unknown>;
    expect(parsed.entryTags).toEqual([]);
    expect("note" in parsed).toBe(false);
  });
});

describe("annotationTagDictSchema", () => {
  it("accepts preset-shaped dictionaries", () => {
    const parsed = annotationTagDictSchema.parse({
      entry: [...PRESET_ENTRY_TAGS],
      option: [...PRESET_OPTION_TAGS],
    });
    expect(parsed.entry).toHaveLength(6);
    expect(parsed.option).toHaveLength(7);
  });

  it("rejects a dictionary with more than 50 labels in one kind", () => {
    expect(annotationTagDictSchema.safeParse({
      entry: Array.from({ length: 51 }, (_, i) => `标签${i}`),
      option: [],
    }).success).toBe(false);
  });
});
