/**
 * 作文子空间 domain 契约测试（W1 冻结：ADR《writing-workspace》§3/§5）。
 * 纯函数与 schema 边界：换行归一、英文词计数、UTF-16 锚点、反馈结构收口、
 * 草稿保存 schema、任务创建输入。
 */
import { describe, expect, it } from "vitest";
import {
  WRITING_TEXT_MAX,
  WRITING_TITLE_MAX,
  countEnglishWords,
  hasWritingContent,
  normalizeWritingText,
  validateFeedbackAnchors,
  writingDraftInputSchema,
  writingFeedbackSchema,
  writingTaskCreateInputSchema,
  type WritingFeedback,
} from "@/domain/l3-writing";

const REQUEST_ID = "00000000-0000-4000-8000-000000000901";
const QUESTION_ID = "00000000-0000-4000-8000-000000000902";

function feedbackFixture(overrides: Partial<WritingFeedback> = {}): WritingFeedback {
  return {
    schemaVersion: 1,
    summary: "结构清楚，论据需要更具体。",
    strengths: ["开头立场明确"],
    dimensions: {
      task_response: { applicable: true, comment: "回应了题目要求。" },
      organization: { applicable: true, comment: "两段结构可辨。" },
      language: { applicable: true, comment: "基本通顺，时态有滑点。" },
      expression: { applicable: false, comment: "本稿不评表达风格。" },
    },
    priorities: [
      {
        id: "p1",
        dimension: "task_response",
        observation: "第二段没有给出具体例子。",
        action: "补一个具体事例支撑观点。",
        anchor: null,
      },
    ],
    ...overrides,
  };
}

describe("normalizeWritingText", () => {
  it("只归一换行并保留空格（不 trim）", () => {
    expect(normalizeWritingText("  A\r\nB\r")).toBe("  A\nB\n");
  });

  it("已是 LF 的文本原样返回", () => {
    const text = "第一段。\n\n第二段。 ";
    expect(normalizeWritingText(text)).toBe(text);
  });
});

describe("hasWritingContent", () => {
  it("空白文本视为空稿（不可提交），非空文本可提交", () => {
    expect(hasWritingContent("")).toBe(false);
    expect(hasWritingContent("   \n  ")).toBe(false);
    expect(hasWritingContent("有内容")).toBe(true);
  });
});

describe("countEnglishWords", () => {
  it("统计英文/数字串（含内部撇号与连字符），中文不计", () => {
    expect(countEnglishWords("I don't think it's well-known.")).toBe(5);
    expect(countEnglishWords("中文中文中文")).toBe(0);
    expect(countEnglishWords("混合 mixed 内容 with 3 items")).toBe(4);
  });

  it("空文本为 0", () => {
    expect(countEnglishWords("")).toBe(0);
  });
});

describe("validateFeedbackAnchors（UTF-16 offset 逐字匹配）", () => {
  it("emoji 锚点按 UTF-16 code unit 匹配", () => {
    expect(validateFeedbackAnchors("A😀B", [{ start: 1, end: 3, quote: "😀" }])).toEqual([]);
    expect(validateFeedbackAnchors("A😀B", [{ start: 1, end: 2, quote: "😀" }])).not.toEqual([]);
  });

  it("中文与换行锚点精确匹配", () => {
    const text = "第一行\n第二行。";
    expect(validateFeedbackAnchors(text, [{ start: 4, end: 7, quote: "第二行" }])).toEqual([]);
    expect(validateFeedbackAnchors(text, [{ start: 4, end: 7, quote: "第二行。" }])).not.toEqual([]);
  });

  it("越界与逆序区间拒绝", () => {
    expect(validateFeedbackAnchors("abc", [{ start: 2, end: 9, quote: "c" }])).not.toEqual([]);
    expect(validateFeedbackAnchors("abc", [{ start: 2, end: 2, quote: "" }])).not.toEqual([]);
  });
});

describe("writingDraftInputSchema（专用文本保存契约）", () => {
  it("空稿可保存（text 允许空串）", () => {
    expect(writingDraftInputSchema.safeParse({ expectedVersion: 0, text: "" }).success).toBe(true);
  });

  it("20000 字符接受；20001 拒绝", () => {
    expect(writingDraftInputSchema.safeParse({ expectedVersion: 1, text: "a".repeat(WRITING_TEXT_MAX) }).success).toBe(true);
    expect(writingDraftInputSchema.safeParse({ expectedVersion: 1, text: "a".repeat(WRITING_TEXT_MAX + 1) }).success).toBe(false);
  });

  it("未知键拒绝、负版本拒绝（strict）", () => {
    expect(writingDraftInputSchema.safeParse({ expectedVersion: 0, text: "x", extra: 1 }).success).toBe(false);
    expect(writingDraftInputSchema.safeParse({ expectedVersion: -1, text: "x" }).success).toBe(false);
  });
});

describe("writingFeedbackSchema（S§5 结构收口）", () => {
  it("完整反馈通过", () => {
    expect(writingFeedbackSchema.safeParse(feedbackFixture()).success).toBe(true);
  });

  it("priorities 为 0 条合法（没有问题允许 0 项）", () => {
    expect(writingFeedbackSchema.safeParse(feedbackFixture({ priorities: [] })).success).toBe(true);
  });

  it("相同 priority id 拒绝", () => {
    const base = feedbackFixture().priorities[0]!;
    const dup = writingFeedbackSchema.safeParse(
      feedbackFixture({ priorities: [base, { ...base, observation: "另一个问题" }] }),
    );
    expect(dup.success).toBe(false);
  });

  it("dimensions 四维缺一拒绝；strengths 超 3 条拒绝", () => {
    const bad = feedbackFixture();
    // @ts-expect-error 故意缺维度
    delete bad.dimensions.expression;
    expect(writingFeedbackSchema.safeParse(bad).success).toBe(false);
    expect(writingFeedbackSchema.safeParse(
      feedbackFixture({ strengths: ["a", "b", "c", "d"] }),
    ).success).toBe(false);
  });

  it("anchor 非 null 时必须带 quote；无 numeric score 键（strict）", () => {
    const bad = feedbackFixture();
    // @ts-expect-error 越权键
    bad.score = 8;
    expect(writingFeedbackSchema.safeParse(bad).success).toBe(false);
  });
});

describe("writingTaskCreateInputSchema", () => {
  it("prompt 与 questionId 互斥", () => {
    const both = writingTaskCreateInputSchema.safeParse({
      requestId: REQUEST_ID, kind: "free", direction: "通用",
      prompt: "题目", questionId: QUESTION_ID,
    });
    expect(both.success).toBe(false);
  });

  it("纯直接开始（prompt 缺省）合法；标题超长拒绝", () => {
    expect(writingTaskCreateInputSchema.safeParse({
      requestId: REQUEST_ID, kind: "whole", direction: "考研",
    }).success).toBe(true);
    expect(writingTaskCreateInputSchema.safeParse({
      requestId: REQUEST_ID, kind: "whole", direction: "考研",
      title: "t".repeat(WRITING_TITLE_MAX + 1),
    }).success).toBe(false);
  });

  it("requestId 非 UUID 拒绝", () => {
    expect(writingTaskCreateInputSchema.safeParse({
      requestId: "not-a-uuid", kind: "free", direction: "通用",
    }).success).toBe(false);
  });
});
