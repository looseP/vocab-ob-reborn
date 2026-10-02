import { describe, expect, it } from "vitest";
import {
  PROXIMITY_REASON_LABELS,
  resolveProximityQuestion,
  type ProximityBlankAnchor,
  type ProximityQuestionRef,
} from "@/frontend/viewModels/examProximityBinding";

/**
 * 就近绑定引擎。
 *
 * 断言的不只是「选到了对的题」，还有**判定等级**（enclosed=high / nearest=medium）
 * 与**候选序**。两者都会被 UI 直接消费：等级决定是否默认预选，候选序决定下拉里的
 * 排列 —— 只测目标题会漏掉「列表还是乱序」这类回归。
 */
const Q = (id: string, ordinal: number, stem = `${id} stem`): ProximityQuestionRef => ({ id, ordinal, stem });

const questions: ProximityQuestionRef[] = [Q("q1", 0), Q("q2", 1), Q("q3", 2)];
/** 三个空位：q1→空1(10..13)、q2→空2(40..43)、q3→空3(70..73)。 */
const blanks: ProximityBlankAnchor[] = [
  { blankNo: 1, start: 10, end: 13, questionId: "q1" },
  { blankNo: 2, start: 40, end: 43, questionId: "q2" },
  { blankNo: 3, start: 70, end: 73, questionId: "q3" },
];

describe("resolveProximityQuestion", () => {
  it("选区完整包住空位 → 证据级锁定该题（high / enclosed_blank）", () => {
    const match = resolveProximityQuestion({ selectionStart: 4, selectionEnd: 20, blanks, questions });
    expect(match).toMatchObject({
      targetQuestionId: "q1",
      displayNo: 1,
      reason: "enclosed_blank",
      confidence: "high",
    });
    expect(match!.sortedCandidates[0]!.questionId).toBe("q1");
  });

  it("选区包住多个空位时取阅读序最靠前的那个（不按距离抖动）", () => {
    const match = resolveProximityQuestion({ selectionStart: 0, selectionEnd: 100, blanks, questions });
    expect(match!.targetQuestionId).toBe("q1");
    expect(match!.reason).toBe("enclosed_blank");
  });

  it("选区内无空位 → 按字符中点距离取最近（medium / nearest_blank）", () => {
    // 选区 [44,48)，中点 46；空2 中点 41.5（距 4.5）、空3 中点 71.5（距 25.5）
    const match = resolveProximityQuestion({ selectionStart: 44, selectionEnd: 48, blanks, questions });
    expect(match).toMatchObject({
      targetQuestionId: "q2",
      displayNo: 2,
      reason: "nearest_blank",
      confidence: "medium",
    });
  });

  it("候选按距离升序，首选恒在第 1 位", () => {
    // 选区 [44,48) 中点 46：q2(41.5→4.5) < q3(71.5→25.5) < q1(11.5→34.5)
    const match = resolveProximityQuestion({ selectionStart: 44, selectionEnd: 48, blanks, questions });
    expect(match!.sortedCandidates.map((c) => c.questionId)).toEqual(["q2", "q3", "q1"]);
  });

  it("两侧等距时取靠前的空位（稳定 tie-break，不随输入顺序变）", () => {
    // 中点落在空1 与空2 正中：选区 [26,27)，中点 26.5；空1 中点 11.5、空2 中点 41.5
    const match = resolveProximityQuestion({ selectionStart: 26, selectionEnd: 27, blanks, questions });
    expect(match!.targetQuestionId).toBe("q1");
    const shuffled = resolveProximityQuestion({
      selectionStart: 26,
      selectionEnd: 27,
      blanks: [...blanks].reverse(),
      questions: [...questions].reverse(),
    });
    expect(shuffled!.targetQuestionId).toBe("q1");
    expect(shuffled!.sortedCandidates.map((c) => c.questionId)).toEqual(match!.sortedCandidates.map((c) => c.questionId));
  });

  it("快照外的题（blanks 里的 id 不在卷内）直接不作候选，也不崩", () => {
    const match = resolveProximityQuestion({
      selectionStart: 4,
      selectionEnd: 20,
      blanks: [{ blankNo: 9, start: 4, end: 20, questionId: "ghost" }, ...blanks],
      questions,
    });
    expect(match!.targetQuestionId).toBe("q1");
    expect(match!.sortedCandidates.some((c) => c.questionId === "ghost")).toBe(false);
  });

  it("displayNo 以调用方传入的 Map 为权威（新题型 ordinal+41 不是 ordinal+1）", () => {
    const map = new Map([["q1", 41], ["q2", 42], ["q3", 43]]);
    const match = resolveProximityQuestion({
      selectionStart: 4, selectionEnd: 20, blanks, questions, questionDisplayNo: map,
    });
    expect(match!.displayNo).toBe(41);
  });

  it("无空位卷回退段落对齐（阅读选择题），仍是 medium", () => {
    const match = resolveProximityQuestion({
      selectionStart: 100,
      selectionEnd: 110,
      blanks: [],
      questions,
      paragraphAnchors: [
        { paragraphIndex: 0, start: 0, end: 80, questionId: "q1" },
        { paragraphIndex: 1, start: 80, end: 160, questionId: "q2" },
        { paragraphIndex: 2, start: 160, end: 240, questionId: "q3" },
      ],
    });
    expect(match).toMatchObject({
      targetQuestionId: "q2",
      reason: "paragraph_aligned",
      confidence: "medium",
    });
  });

  it("无任何可用依据 → null（调用方回退旧交互，不硬塞猜测）", () => {
    expect(resolveProximityQuestion({ selectionStart: 4, selectionEnd: 20, blanks: [], questions })).toBeNull();
    expect(resolveProximityQuestion({ selectionStart: 4, selectionEnd: 20, questions })).toBeNull();
    expect(resolveProximityQuestion({ selectionStart: 4, selectionEnd: 20, blanks, questions: [] })).toBeNull();
  });

  it("退化选区（空选 / 反向选 / NaN）→ null，不猜", () => {
    expect(resolveProximityQuestion({ selectionStart: 20, selectionEnd: 20, blanks, questions })).toBeNull();
    expect(resolveProximityQuestion({ selectionStart: 30, selectionEnd: 20, blanks, questions })).toBeNull();
    expect(resolveProximityQuestion({ selectionStart: Number.NaN, selectionEnd: 20, blanks, questions })).toBeNull();
  });

  it("同一题出现多次空位时只保留最近的那次（候选不重复）", () => {
    const match = resolveProximityQuestion({
      selectionStart: 44,
      selectionEnd: 48,
      blanks: [
        { blankNo: 2, start: 70, end: 73, questionId: "q2" },
        { blankNo: 2, start: 40, end: 43, questionId: "q2" },
        ...blanks,
      ],
      questions,
    });
    expect(match!.targetQuestionId).toBe("q2");
    expect(match!.sortedCandidates.filter((c) => c.questionId === "q2")).toHaveLength(1);
  });

  it("三种判定原因都有界面文案（UI 不自己拼字符串，缺文案即回归）", () => {
    expect(Object.values(PROXIMITY_REASON_LABELS).every((label) => label.length > 0)).toBe(true);
  });
});
