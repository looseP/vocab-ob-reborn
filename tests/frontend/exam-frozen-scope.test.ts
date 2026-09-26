/**
 * 题单定格 · 客户端裁剪（2026-09-26）
 *
 * 服务端在开纸时把作用域题集冻结进 sheet.question_ids；交卷物化与评卷读面都以
 * 它为唯一题集。前端渲染必须同口径，否则用户会答到卷外的题、那些作答在交卷时
 * 被静默丢弃。本文件锁死裁剪口径：只缩不换、顺序随快照、空卷节移除、未定格原样。
 */
import { describe, expect, it } from "vitest";
import {
  countQuestionsOutsideFrozenList,
  scopePaperToFrozenList,
  type ExamPaper,
  type ExamQuestion,
} from "@/frontend/components/l3/examTypes";

function question(id: string): ExamQuestion {
  return { id, ordinal: 0, stem: `stem-${id}`, options: [], answer: {}, explanation: null };
}

function paper(): ExamPaper {
  return {
    id: "file:src-1:reading_choice",
    title: "2023 Text2",
    direction: "考研",
    metadata: {},
    sections: [
      {
        key: "reading_choice",
        title: "阅读选择",
        questionType: "reading_choice",
        sourceId: "src-1",
        fileKey: null,
        questionIds: ["q1", "q2", "q3"],
        missing: false,
        source_title: "2023 Text2",
        source_content: "passage",
        questions: [question("q1"), question("q2"), question("q3")],
      },
    ],
  };
}

describe("scopePaperToFrozenList", () => {
  it("未定格（null/空）时原样返回——历史题纸与写作草稿沿用旧行为", () => {
    const input = paper();
    expect(scopePaperToFrozenList(input, null)).toBe(input);
    expect(scopePaperToFrozenList(input, [])).toBe(input);
    expect(scopePaperToFrozenList(input, undefined)).toBe(input);
  });

  it("裁掉快照外的题，并按快照顺序重排", () => {
    const scoped = scopePaperToFrozenList(paper(), ["q3", "q1"]);
    expect(scoped.sections[0]!.questionIds).toEqual(["q3", "q1"]);
    expect(scoped.sections[0]!.questions.map((q) => q.id)).toEqual(["q3", "q1"]);
  });

  it("题组多出来的题不渲染（否则会在交卷时被静默丢弃）", () => {
    const scoped = scopePaperToFrozenList(paper(), ["q1"]);
    expect(scoped.sections[0]!.questionIds).toEqual(["q1"]);
    expect(scoped.sections).toHaveLength(1);
  });

  it("只缩不换：快照里有、题组里没有的题不虚构", () => {
    const scoped = scopePaperToFrozenList(paper(), ["q1", "q-gone"]);
    expect(scoped.sections[0]!.questionIds).toEqual(["q1"]);
  });

  it("整节被裁空时移除该节（不留空壳 section）", () => {
    const twoSections = paper();
    twoSections.sections.push({
      key: "cloze",
      title: "完形",
      questionType: "cloze",
      sourceId: "src-1",
      fileKey: null,
      questionIds: ["c1", "c2"],
      missing: false,
      source_title: "2023 Text2",
      source_content: "passage",
      questions: [question("c1"), question("c2")],
    });
    const scoped = scopePaperToFrozenList(twoSections, ["q1"]);
    expect(scoped.sections.map((s) => s.key)).toEqual(["reading_choice"]);
  });

  it("重复 id 去重（快照只认一次）", () => {
    const scoped = scopePaperToFrozenList(paper(), ["q1", "q1"]);
    expect(scoped.sections[0]!.questionIds).toEqual(["q1"]);
  });

  it("不改动入参（纯函数）", () => {
    const input = paper();
    scopePaperToFrozenList(input, ["q1"]);
    expect(input.sections[0]!.questionIds).toEqual(["q1", "q2", "q3"]);
  });
});

describe("countQuestionsOutsideFrozenList", () => {
  it("未定格时为 0（不显示裁剪提示）", () => {
    expect(countQuestionsOutsideFrozenList(paper(), null)).toBe(0);
    expect(countQuestionsOutsideFrozenList(paper(), [])).toBe(0);
  });

  it("统计题组中被裁掉的题数（跨 section 累加）", () => {
    expect(countQuestionsOutsideFrozenList(paper(), ["q1"])).toBe(2);
    expect(countQuestionsOutsideFrozenList(paper(), ["q1", "q2", "q3"])).toBe(0);
  });
});
