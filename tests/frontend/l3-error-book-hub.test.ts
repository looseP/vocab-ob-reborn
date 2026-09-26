/**
 * 错题库枢纽 · 回流出口 URL 构造（2026-09-26）。
 *
 * 这是「错题 → 再练」闭环最容易悄悄坏掉的地方：URL 拼错 = 点了没反应 / 落到
 * 别的面。故逐条锁死构造口径，且坚持「站内生成、不可回看就不给链接」。
 */
import { describe, expect, it } from "vitest";
import type { L3UnifiedErrorBookItem } from "@/domain";
import {
  buildErrorBookHubRow,
  buildErrorBookHubSections,
  buildPracticeHref,
  buildQuestionHref,
  ERROR_BOOK_KIND_LABELS,
  ERROR_BOOK_OUTCOME_LABELS,
  errorBookRowActionLabel,
  errorBookSourceLabel,
} from "@/frontend/viewModels/l3ErrorBookHubViewModel";

const CONTEXT = "00000000-0000-4000-8000-000000000501";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const SOURCE = "00000000-0000-4000-8000-000000000302";
const SHEET = "00000000-0000-4000-8000-000000000401";

function item(overrides: Partial<L3UnifiedErrorBookItem> = {}): L3UnifiedErrorBookItem {
  return {
    kind: "sentence",
    id: "attempt-1",
    target_id: CONTEXT,
    target_label: "The vivid sunset faded.",
    target_secondary: null,
    source_id: SOURCE,
    source_title: "2023 Text2",
    question_type: null,
    space: "阅读",
    direction: "考研",
    sheet_id: null,
    practice_type: "essay_dictation",
    wrong_count: 1,
    latest_outcome: "wrong",
    latest_at: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildPracticeHref（句级回流）", () => {
  it("落练习页并带 context 锚点（练习页据此只练这一条）", () => {
    expect(buildPracticeHref(CONTEXT)).toBe(`/l3?section=practice&context=${CONTEXT}`);
  });

  it("id 做 URL 编码（不假设调用方已编码）", () => {
    expect(buildPracticeHref("a b/c")).toBe("/l3?section=practice&context=a%20b%2Fc");
  });
});

describe("buildQuestionHref（题级回流）", () => {
  it("有来源 → 题型空间深链，带题目定位与题纸回看", () => {
    const href = buildQuestionHref(item({
      kind: "question",
      target_id: QUESTION,
      question_type: "reading_choice",
      source_id: SOURCE,
      sheet_id: SHEET,
    }));
    expect(href).toBe(
      `/l3?venue=reading_choice&file=${SOURCE}&question=${QUESTION}&resumeSheet=${SHEET}`,
    );
  });

  it("有来源但无题纸 → 不带 resumeSheet（不写空参数）", () => {
    const href = buildQuestionHref(item({
      kind: "question",
      target_id: QUESTION,
      question_type: "reading_choice",
      source_id: SOURCE,
      sheet_id: null,
    }));
    expect(href).toBe(`/l3?venue=reading_choice&file=${SOURCE}&question=${QUESTION}`);
    expect(href).not.toContain("resumeSheet");
  });

  it("无来源但有题纸（作文内建题）→ 走 F-1 题纸回看深链", () => {
    const href = buildQuestionHref(item({
      kind: "question",
      target_id: QUESTION,
      source_id: null,
      sheet_id: SHEET,
    }));
    expect(href).toBe(`/l3?sheet=${SHEET}`);
  });

  it("无来源且无题纸 → null（不给死按钮）", () => {
    expect(buildQuestionHref(item({
      kind: "question",
      source_id: null,
      sheet_id: null,
    }))).toBeNull();
  });

  it("有来源但题型未知 → 仍给深链，只是不带 venue（file 参数同时匹配 source_id）", () => {
    const href = buildQuestionHref(item({
      kind: "question",
      target_id: QUESTION,
      source_id: SOURCE,
      question_type: null,
    }));
    expect(href).toBe(`/l3?file=${SOURCE}&question=${QUESTION}`);
  });
});

describe("buildErrorBookHubRow", () => {
  it("句级行出口恒为「再练一次」", () => {
    const row = buildErrorBookHubRow(item());
    expect(row.kind).toBe("sentence");
    expect(errorBookRowActionLabel(row)).toBe("再练一次");
    expect(row.hrefMissingReason).toBeNull();
  });

  it("题级行出口为「回看原题」；不可回看时给出原因而非 null href", () => {
    const ok = buildErrorBookHubRow(item({ kind: "question", target_id: QUESTION, question_type: "cloze" }));
    expect(errorBookRowActionLabel(ok)).toBe("回看原题");
    expect(ok.hrefMissingReason).toBeNull();

    const orphan = buildErrorBookHubRow(item({ kind: "question", source_id: null, sheet_id: null }));
    expect(orphan.href).toBeNull();
    expect(orphan.hrefMissingReason).toMatch(/无法回看/);
  });

  it("key 含 kind（两腿 id 空间不同，不靠 id 唯一）", () => {
    const a = buildErrorBookHubRow(item({ id: "same-id" }));
    const b = buildErrorBookHubRow(item({ id: "same-id", kind: "question" }));
    expect(a.key).not.toBe(b.key);
  });
});

describe("buildErrorBookHubSections", () => {
  it("题级在前、句级在后；空分区不出现", () => {
    const sections = buildErrorBookHubSections([
      item({ id: "a1" }),
      item({ id: "q1", kind: "question", target_id: QUESTION, question_type: "cloze" }),
    ]);
    expect(sections.map((s) => s.kind)).toEqual(["question", "sentence"]);
    expect(sections[0]!.label).toBe(ERROR_BOOK_KIND_LABELS.question);
    expect(sections[0]!.rows).toHaveLength(1);
    expect(sections[1]!.rows).toHaveLength(1);
  });

  it("只有一腿时另一腿仍存在但为空（分区标题稳定，不随数据跳变）", () => {
    const sections = buildErrorBookHubSections([item()]);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.rows).toHaveLength(0);
    expect(sections[1]!.rows).toHaveLength(1);
  });
});

describe("标签与兜底文案", () => {
  it("两套结果词表不互相映射（partial 不是句级的 skip/wrong）", () => {
    expect(ERROR_BOOK_OUTCOME_LABELS.partial).toBe("部分对");
    expect(ERROR_BOOK_OUTCOME_LABELS.wrong).toBe("错");
    expect(ERROR_BOOK_OUTCOME_LABELS.skip).toBe("跳过");
  });

  it("未知结果标签回落到原值（不吞）", () => {
    expect(ERROR_BOOK_OUTCOME_LABELS.sound).toBeUndefined();
  });

  it("来源兜底三态：有标题 / 已删除 / 无来源", () => {
    expect(errorBookSourceLabel(item())).toBe("2023 Text2");
    expect(errorBookSourceLabel(item({ source_title: null }))).toBe("（来源已删除）");
    expect(errorBookSourceLabel(item({ source_title: null, source_id: null }))).toBe("（无来源）");
  });
});
