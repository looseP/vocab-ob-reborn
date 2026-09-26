/**
 * 学习笔记（N1）domain 合同测试（Task 01）——
 * marker 解析（marked 顶层 paragraph 完全相等识别）、引用集合一致性、
 * UTF-16 锚点校验、引用/保存/创建/专题输入 schema 边界。
 *
 * 合同来源：docs/plan/study-notes-design-2026-09-18.md §3（引用契约）、
 * §5（数据字段）、§6（保存一致性）、§7（HTTP 合同限额）。
 */
import { describe, expect, it } from "vitest";
import {
  ReferenceContractError,
  assertReferenceSet,
  parseReferenceIds,
  validateQuote,
  referenceTargetSchema,
  referenceWriteSchema,
  saveStudyNoteSchema,
  createStudyNoteSchema,
  createStudyTopicSchema,
  saveStudyTopicSchema,
  moveStudyTopicMemberSchema,
  removeStudyTopicMemberSchema,
  normalizeStudyUuid,
  REFERENCE_KINDS,
  STUDY_SHEET_EXCERPT_MAX,
  STUDY_ATTEMPT_EXCERPT_MAX,
} from "@/domain/l3-study-notes";
import {
  QUESTION_ID,
  REF,
  REF_B,
  REQUEST_ID,
  SOURCE_ID,
  marker,
} from "../helpers/study-notes";

const M = marker(REF);
const M_B = marker(REF_B);

// ── marker 解析：只在 marked lexer 顶层 paragraph 且 text 完全等于标记时识别 ──

describe("parseReferenceIds", () => {
  it("识别独立顶层段落的完整标记", () => {
    expect(parseReferenceIds(M)).toEqual([REF]);
    expect(parseReferenceIds(`第一段。\n\n${M}\n\n第二段。`)).toEqual([REF]);
  });

  it("代码围栏内的同形文本不识别", () => {
    expect(parseReferenceIds(`${M}\n\n\`\`\`text\n${M}\n\`\`\``)).toEqual([REF]);
    expect(parseReferenceIds(`\`\`\`text\n${M}\n\`\`\``)).toEqual([]);
  });

  it("引用块与行内代码内的同形文本不识别", () => {
    expect(parseReferenceIds(`> ${M}\n\n\`${M}\``)).toEqual([]);
  });

  it("标题、列表内的同形文本不识别", () => {
    expect(parseReferenceIds(`# ${M}`)).toEqual([]);
    expect(parseReferenceIds(`- ${M}`)).toEqual([]);
  });

  it("段落内嵌标记（不完全等于）按普通文本，不识别", () => {
    expect(parseReferenceIds(`我的判断是 ${M}`)).toEqual([]);
    expect(parseReferenceIds(`${M} 后面还有字`)).toEqual([]);
  });

  it("多个标记按出现顺序返回", () => {
    expect(parseReferenceIds(`${M}\n\n中间段。\n\n${M_B}`)).toEqual([REF, REF_B]);
  });

  it("识别结果保持原始出现顺序（含重复——重复由集合校验拒绝）", () => {
    expect(parseReferenceIds(`${M}\n\n${M}`)).toEqual([REF, REF]);
  });

  it("顶层段落形如标记但内容非法 UUID：明确报错（未知标记），不静默当文本", () => {
    expect(() => parseReferenceIds("[[ref:not-a-uuid]]")).toThrow(ReferenceContractError);
    expect(() => parseReferenceIds("[[ref:]]")).toThrow(ReferenceContractError);
  });

  it("空正文与普通 Markdown 均无标记", () => {
    expect(parseReferenceIds("")).toEqual([]);
    expect(parseReferenceIds("普通段落，无标记。")).toEqual([]);
  });
});

// ── 集合一致性：marker 集合与 ReferenceWrite.id 集合完全相等且无重复 ────────

describe("assertReferenceSet", () => {
  it("集合完全一致时通过（keep 与 capture 混合）", () => {
    expect(() =>
      assertReferenceSet(`${M}\n\n正文。\n\n${M_B}`, [
        { id: REF, action: "keep" },
        { id: REF_B, action: "capture", target: { kind: "source", sourceId: SOURCE_ID } },
      ]),
    ).not.toThrow();
  });

  it("正文有标记但引用缺失：拒绝", () => {
    expect(() => assertReferenceSet(M, [])).toThrow(ReferenceContractError);
  });

  it("引用存在但正文无标记（多余引用）：拒绝", () => {
    expect(() =>
      assertReferenceSet("正文无标记。", [{ id: REF, action: "keep" }]),
    ).toThrow(ReferenceContractError);
  });

  it("同一 markerId 在正文出现两次：拒绝", () => {
    expect(() =>
      assertReferenceSet(`${M}\n\n${M}`, [{ id: REF, action: "keep" }]),
    ).toThrow(ReferenceContractError);
  });

  it("重复引用 id：拒绝", () => {
    expect(() =>
      assertReferenceSet(M, [
        { id: REF, action: "keep" },
        { id: REF, action: "keep" },
      ]),
    ).toThrow(ReferenceContractError);
  });

  it("无标记无引用：通过（引用非必填）", () => {
    expect(() => assertReferenceSet("自由笔记，没有引用。", [])).not.toThrow();
  });
});

// ── UTF-16 锚点：不 trim、不归一化、不拆代理对 ─────────────────────────────

describe("validateQuote", () => {
  it("UTF-16 code unit 坐标（emoji 占两个 unit 且端点在代理对边界上）", () => {
    expect(validateQuote("A😀 B", 1, 3, "😀")).toBe(true);
    // 端点切进代理对内部 → 拒绝（即使字符串字面量相同也不接受）
    expect(validateQuote("A😀 B", 1, 2, "😀")).toBe(false);
    expect(validateQuote("A😀 B", 2, 3, "😀")).toBe(false);
  });

  it("quote 为残段代理对时同样拒绝（坐标不得落在代理对内部）", () => {
    const text = "A😀B"; // A + 高代理 + 低代理 + B
    expect(validateQuote(text, 1, 2, "\ud83d")).toBe(false);
    expect(validateQuote(text, 2, 3, "\ude00")).toBe(false);
  });

  it("quote 必须严格等于 slice(start,end)，不 trim", () => {
    expect(validateQuote("选择题 one two", 4, 7, "one")).toBe(true);
    expect(validateQuote("选择题 one two", 4, 7, " one")).toBe(false);
    expect(validateQuote("a b", 1, 2, " ")).toBe(true);
  });

  it("越界与非法区间拒绝", () => {
    expect(validateQuote("abc", 0, 4, "abc")).toBe(false);
    expect(validateQuote("abc", 2, 1, "c")).toBe(false);
    expect(validateQuote("abc", -1, 1, "a")).toBe(false);
    expect(validateQuote("", 0, 1, "a")).toBe(false);
    expect(validateQuote("abc", 0.5, 1, "a")).toBe(false);
  });

  it("非 ASCII 正文中的锚点（中文按 1 个 code unit 计）", () => {
    expect(validateQuote("选项扩大了原文范围", 2, 4, "扩大")).toBe(true);
    expect(validateQuote("选项扩大了原文范围", 2, 4, "扩大了")).toBe(false);
  });

  it("非字符串输入防御返回 false", () => {
    expect(validateQuote(null as unknown as string, 0, 1, "a")).toBe(false);
    expect(validateQuote("abc", 0, 1, null as unknown as string)).toBe(false);
  });
});

// ── 引用输入 schema：五种 kind 严格枚举 ────────────────────────────────────

describe("referenceTargetSchema", () => {
  it("接受五种 kind 的合法形态", () => {
    const samples = [
      { kind: "source", sourceId: SOURCE_ID },
      { kind: "source_quote", sourceId: SOURCE_ID, start: 0, end: 4, quote: "原文摘" },
      { kind: "question", questionId: QUESTION_ID },
      { kind: "stem_quote", questionId: QUESTION_ID, start: 1, end: 3, quote: "题干" },
      { kind: "option_quote", questionId: QUESTION_ID, optionKey: "A", start: 0, end: 2, quote: "选项" },
    ] as const;
    for (const sample of samples) {
      expect(referenceTargetSchema.safeParse(sample).success).toBe(true);
    }
  });

  it("未知 kind 与未知字段拒绝（strict）", () => {
    expect(referenceTargetSchema.safeParse({ kind: "unknown", sourceId: SOURCE_ID }).success).toBe(false);
    expect(
      referenceTargetSchema.safeParse({ kind: "source", sourceId: SOURCE_ID, extra: true }).success,
    ).toBe(false);
  });

  it("start/end 必须为非负整数且 end > start", () => {
    const base = { kind: "source_quote", sourceId: SOURCE_ID, quote: "x" };
    expect(referenceTargetSchema.safeParse({ ...base, start: 0, end: 0 }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, start: 2, end: 1 }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, start: -1, end: 2 }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, start: 0.5, end: 2 }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, start: 0, end: 2 }).success).toBe(true);
  });

  it("quote 1–4000，空串与超长拒绝", () => {
    const base = { kind: "stem_quote", questionId: QUESTION_ID, start: 0, end: 1 };
    expect(referenceTargetSchema.safeParse({ ...base, quote: "" }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, quote: "x".repeat(4000) }).success).toBe(true);
    expect(referenceTargetSchema.safeParse({ ...base, quote: "x".repeat(4001) }).success).toBe(false);
  });

  it("optionKey 1–8 字符", () => {
    const base = { kind: "option_quote", questionId: QUESTION_ID, start: 0, end: 1, quote: "x" };
    expect(referenceTargetSchema.safeParse({ ...base, optionKey: "" }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, optionKey: "A" }).success).toBe(true);
    expect(referenceTargetSchema.safeParse({ ...base, optionKey: "abcdefgh" }).success).toBe(true);
    expect(referenceTargetSchema.safeParse({ ...base, optionKey: "abcdefghi" }).success).toBe(false);
  });

  it("UUID 非法拒绝", () => {
    expect(referenceTargetSchema.safeParse({ kind: "source", sourceId: "not-uuid" }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ kind: "question", questionId: "123" }).success).toBe(false);
  });
});

describe("referenceWriteSchema", () => {
  it("keep 不带 target；capture 必须带 target（strict）", () => {
    expect(referenceWriteSchema.safeParse({ id: REF, action: "keep" }).success).toBe(true);
    expect(referenceWriteSchema.safeParse({ id: REF, action: "keep", target: { kind: "source", sourceId: SOURCE_ID } }).success).toBe(false);
    expect(
      referenceWriteSchema.safeParse({
        id: REF,
        action: "capture",
        target: { kind: "source", sourceId: SOURCE_ID },
      }).success,
    ).toBe(true);
    expect(referenceWriteSchema.safeParse({ id: REF, action: "capture" }).success).toBe(false);
  });

  it("未知 action 拒绝", () => {
    expect(referenceWriteSchema.safeParse({ id: REF, action: "update" }).success).toBe(false);
  });
});

// ── 保存输入：UTF-16 限额、venues 去重、引用上限 ───────────────────────────

function validSaveInput(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: 1,
    requestId: REQUEST_ID,
    title: "标题",
    bodyMd: "正文",
    venues: ["reading_choice"],
    pinned: false,
    status: "active",
    references: [],
    ...overrides,
  };
}

describe("saveStudyNoteSchema", () => {
  it("接受合法完整输入", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput()).success).toBe(true);
  });

  it("未知字段拒绝（strict；客户端不得伪造 userId/hash/snapshot）", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ userId: SOURCE_ID })).success).toBe(false);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ fieldHash: "x" })).success).toBe(false);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ displaySnapshot: {} })).success).toBe(false);
  });

  it("标题 0–120 UTF-16 code units（emoji 计 2 个 unit）", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ title: "" })).success).toBe(true);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ title: "a".repeat(120) })).success).toBe(true);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ title: "a".repeat(121) })).success).toBe(false);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ title: "😀".repeat(60) })).success).toBe(true); // 120 units
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ title: "😀".repeat(61) })).success).toBe(false); // 122 units
  });

  it("正文 0–100000 UTF-16 code units", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ bodyMd: "" })).success).toBe(true);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ bodyMd: "x".repeat(100_000) })).success).toBe(true);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ bodyMd: "x".repeat(100_001) })).success).toBe(false);
  });

  it("venues 1–7 且无重复", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ venues: [] })).success).toBe(false);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ venues: ["reading_choice", "reading_choice"] })).success).toBe(false);
    expect(
      saveStudyNoteSchema.safeParse(validSaveInput({ venues: ["cloze", "reading_choice"] })).success,
    ).toBe(true);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ venues: ["not_a_type"] })).success).toBe(false);
  });

  it("引用最多 100 条；超限拒绝", () => {
    const refs = Array.from({ length: 100 }, (_, i) => ({ id: REF, action: "keep" }));
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ references: refs })).success).toBe(true);
    expect(
      saveStudyNoteSchema.safeParse(validSaveInput({ references: [...refs, { id: REF_B, action: "keep" }] })).success,
    ).toBe(false);
  });

  it("expectedVersion 必须为正整数", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ expectedVersion: 0 })).success).toBe(false);
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ expectedVersion: 1.5 })).success).toBe(false);
  });

  it("status 仅 active|archived", () => {
    expect(saveStudyNoteSchema.safeParse(validSaveInput({ status: "draft" })).success).toBe(false);
  });
});

// ── 创建与专题输入 ─────────────────────────────────────────────────────────

describe("createStudyNoteSchema", () => {
  it("venue 必填且为七题型之一；未知字段拒绝", () => {
    expect(createStudyNoteSchema.safeParse({ requestId: REQUEST_ID, venue: "cloze" }).success).toBe(true);
    expect(createStudyNoteSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(false);
    expect(createStudyNoteSchema.safeParse({ requestId: REQUEST_ID, venue: "x" }).success).toBe(false);
    expect(createStudyNoteSchema.safeParse({ requestId: REQUEST_ID, venue: "cloze", extra: 1 }).success).toBe(false);
  });
});

describe("study topic schemas", () => {
  it("创建：title 1–120、venue 枚举", () => {
    expect(
      createStudyTopicSchema.safeParse({ requestId: REQUEST_ID, venue: "reading_choice", title: "专题" }).success,
    ).toBe(true);
    expect(
      createStudyTopicSchema.safeParse({ requestId: REQUEST_ID, venue: "reading_choice", title: "" }).success,
    ).toBe(false);
    expect(
      createStudyTopicSchema.safeParse({ requestId: REQUEST_ID, venue: "reading_choice", title: "t".repeat(121) }).success,
    ).toBe(false);
  });

  it("保存：expectedVersion + title + status", () => {
    const ok = { requestId: REQUEST_ID, expectedVersion: 1, title: "改名", status: "archived" };
    expect(saveStudyTopicSchema.safeParse(ok).success).toBe(true);
    expect(saveStudyTopicSchema.safeParse({ ...ok, status: "deleted" }).success).toBe(false);
    expect(saveStudyTopicSchema.safeParse({ ...ok, expectedVersion: 0 }).success).toBe(false);
  });

  it("成员移动：beforeNoteId 为 null 或 uuid", () => {
    const ok = { requestId: REQUEST_ID, expectedVersion: 1, beforeNoteId: null };
    expect(moveStudyTopicMemberSchema.safeParse(ok).success).toBe(true);
    expect(
      moveStudyTopicMemberSchema.safeParse({ ...ok, beforeNoteId: "00000000-0000-4000-8000-000000000101" }).success,
    ).toBe(true);
    expect(moveStudyTopicMemberSchema.safeParse({ ...ok, beforeNoteId: "abc" }).success).toBe(false);
    expect(moveStudyTopicMemberSchema.safeParse({ requestId: REQUEST_ID, expectedVersion: 1 }).success).toBe(false);
  });

  it("成员移除：requestId + expectedVersion", () => {
    expect(
      removeStudyTopicMemberSchema.safeParse({ requestId: REQUEST_ID, expectedVersion: 2 }).success,
    ).toBe(true);
    expect(removeStudyTopicMemberSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(false);
  });
});

// ── F5（补修批次）：UUID 身份规范化合同 ─────────────────────────────────────

// ── N2 第三条链：sheet / attempt 目标（红测先行，实现见 §7.0.3）──────────────

const SUBMISSION = "00000000-0000-4000-8000-000000000321";
const ATTEMPT = "00000000-0000-4000-8000-000000000331";
const GRADED_QUESTION = "00000000-0000-4000-8000-000000000341";

describe("referenceTargetSchema · sheet / attempt（N2 第三条链）", () => {
  it("REFERENCE_KINDS 扩到十值（与 DB kind_check 同口径：新增 sheet / attempt / grading）", () => {
    expect(REFERENCE_KINDS).toEqual([
      "source",
      "source_quote",
      "question",
      "stem_quote",
      "option_quote",
      "assessment",
      "note",
      "sheet",
      "attempt",
      "grading",
    ]);
  });

  it("grading：target 只收 {sheetId, questionId}，没有版本维度（ADR-0039 决策 2）", () => {
    const base = { kind: "grading", sheetId: SUBMISSION, questionId: GRADED_QUESTION };
    expect(referenceTargetSchema.safeParse(base).success).toBe(true);
    // strict：多余字段一律拒（防止前端悄悄塞一个 version 进去）。
    expect(referenceTargetSchema.safeParse({ ...base, version: 1 }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ ...base, gradingVersion: 1 }).success).toBe(false);
    expect(referenceTargetSchema.safeParse({ kind: "grading", questionId: GRADED_QUESTION }).success).toBe(false);
  });

  it("sheet 非 writing：只有 submissionId（revisionNo 省略或显式 null 皆可）", () => {
    expect(referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION }).success).toBe(true);
    expect(
      referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION, revisionNo: null }).success,
    ).toBe(true);
  });

  it("sheet writing：revisionNo 为正整数（>0，与 DB revision_no_check 同口径）", () => {
    expect(
      referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION, revisionNo: 2 }).success,
    ).toBe(true);
  });

  it("sheet：revisionNo 为 0 / 负数 / 非整数 / 字符串 → 拒绝", () => {
    for (const revisionNo of [0, -1, 1.5, "2"]) {
      expect(
        referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION, revisionNo }).success,
      ).toBe(false);
    }
  });

  it("sheet 不得携带其它目标型字段（strict；K5 无身份兜底）", () => {
    expect(
      referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION, questionId: QUESTION_ID }).success,
    ).toBe(false);
    expect(
      referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION, attemptId: ATTEMPT }).success,
    ).toBe(false);
    expect(
      referenceTargetSchema.safeParse({ kind: "sheet", submissionId: SUBMISSION, sourceId: SOURCE_ID }).success,
    ).toBe(false);
  });

  it("attempt：只有 attemptId（K9 不拼 question / sheet / venue）", () => {
    expect(referenceTargetSchema.safeParse({ kind: "attempt", attemptId: ATTEMPT }).success).toBe(true);
    expect(
      referenceTargetSchema.safeParse({ kind: "attempt", attemptId: ATTEMPT, questionId: QUESTION_ID }).success,
    ).toBe(false);
    expect(
      referenceTargetSchema.safeParse({ kind: "attempt", attemptId: ATTEMPT, submissionId: SUBMISSION }).success,
    ).toBe(false);
  });

  it("快照摘录预算族：sheet / attempt 与既有同量级 280（K13）", () => {
    expect(STUDY_SHEET_EXCERPT_MAX).toBe(280);
    expect(STUDY_ATTEMPT_EXCERPT_MAX).toBe(280);
  });
});

describe("normalizeStudyUuid（F5 UUID 身份）", () => {
  // 含 a–f 的样例 UUID（纯数字 UUID 无法暴露大小写问题）
  const UPPER = "ABCDEF01-2345-4789-8ABC-DEF012345678";
  const LOWER = "abcdef01-2345-4789-8abc-def012345678";

  it("合法大写/混合大小写 UUID 归一为小写（同一身份）", () => {
    expect(normalizeStudyUuid(UPPER)).toBe(LOWER);
    expect(normalizeStudyUuid("aBcDeF01-2345-4789-8AbC-dEf012345678")).toBe(LOWER);
  });

  it("小写输入不变；非法输入按原样返回（合法性仍由既有校验器/PG 收口，不新增错误面）", () => {
    expect(normalizeStudyUuid(LOWER)).toBe(LOWER);
    expect(normalizeStudyUuid("not-a-uuid")).toBe("not-a-uuid");
  });
});
