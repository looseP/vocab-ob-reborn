/**
 * stageMap 纯函数单元测试（ADR-0036 / 演示页 D 区契约，LW-1 验收）。
 *
 * 政策 B 边界（计划卡指定四例）：
 * - card=easy + dict=good → good（客观只降不升的 min 语义）
 * - card=good + dict wt=6 → again（磨 6 键就是重来，卡面自评不漂高）
 * - listen 档封顶 hard
 * - copy 档封顶 again
 */

import { describe, it, expect } from "vitest";
import {
  baseRating,
  dictationHintCap,
  dictMapOf,
  policyBFinal,
  TIER_CAP,
  VISIT_TEMPLATE,
  SESSION_SCHEDULER,
} from "@/frontend/reviewFlow/stageMap";

describe("baseRating（档内表现映射，THRESH goodMax=2 / hardMax=4）", () => {
  it("0 错→easy；1–2 错→good；3–4 错→hard；≥5 键→again", () => {
    expect(baseRating(0)).toBe("easy");
    expect(baseRating(1)).toBe("good");
    expect(baseRating(2)).toBe("good");
    expect(baseRating(3)).toBe("hard");
    expect(baseRating(4)).toBe("hard");
    expect(baseRating(5)).toBe("again");
    expect(baseRating(6)).toBe("again");
  });
});

describe("dictMapOf = min(表现映射, T3 提示上限, 档位上限)", () => {
  it("默写档无档位上限：仅表现与提示约束", () => {
    expect(dictMapOf({ wrongTimes: 0, hintChars: 0, tier: "dictation" })).toBe("easy");
    expect(dictMapOf({ wrongTimes: 1, hintChars: 0, tier: "dictation" })).toBe("good");
    expect(dictMapOf({ wrongTimes: 3, hintChars: 0, tier: "dictation" })).toBe("hard");
  });

  it("T3 提示上限：揭 1 字母→good、≥2 字母→hard", () => {
    expect(dictMapOf({ wrongTimes: 0, hintChars: 1, tier: "dictation" })).toBe("good");
    expect(dictMapOf({ wrongTimes: 0, hintChars: 2, tier: "dictation" })).toBe("hard");
    expect(dictationHintCap(3)).toBe("hard");
  });

  it("listen 档封顶 hard；copy 档封顶 again（cap 只压不抬）", () => {
    expect(dictMapOf({ wrongTimes: 0, hintChars: 0, tier: "listen" })).toBe("hard");
    // wt=6 表现本身已是 again：cap 语义是「不得好于 hard」，不把 again 抬回 hard
    expect(dictMapOf({ wrongTimes: 6, hintChars: 0, tier: "listen" })).toBe("again");
    expect(dictMapOf({ wrongTimes: 2, hintChars: 0, tier: "copy" })).toBe("again");
    expect(dictMapOf({ wrongTimes: 0, hintChars: 0, tier: "copy" })).toBe("again");
    expect(TIER_CAP.listen).toBe("hard");
    expect(TIER_CAP.copy).toBe("again");
    expect(TIER_CAP.dictation).toBeNull();
  });
});

describe("policyBFinal（拍板①：min(卡面自评, 默写映射)，客观只降不升）", () => {
  it("card=easy + dict=good → good", () => {
    expect(policyBFinal({ ladderRung: 1, cardRating: "easy", dictMap: "good" })).toBe("good");
  });

  it("card=good + dict wt=6(→again) → again", () => {
    const dictMap = dictMapOf({ wrongTimes: 6, hintChars: 0, tier: "dictation" });
    expect(dictMap).toBe("again");
    expect(policyBFinal({ ladderRung: 1, cardRating: "good", dictMap })).toBe("again");
  });

  it("dict 不严于卡面时保持卡面自评（只降不升）", () => {
    expect(policyBFinal({ ladderRung: 1, cardRating: "hard", dictMap: "good" })).toBe("hard");
    expect(policyBFinal({ ladderRung: 2, cardRating: "good", dictMap: "good" })).toBe("good");
  });

  it("R3 词：final = dictMap（本档即测量，卡面自评不参与）", () => {
    expect(policyBFinal({ ladderRung: 3, cardRating: "easy", dictMap: "hard" })).toBe("hard");
    expect(policyBFinal({ ladderRung: 3, cardRating: null, dictMap: null })).toBe("again");
  });
});

describe("模板与调度常量（演示页 D 区冻结值）", () => {
  it("VISIT_TEMPLATE 四档模板", () => {
    expect(VISIT_TEMPLATE.NEW).toEqual(["card-encode", "follow", "dictation", "first-rate"]);
    expect(VISIT_TEMPLATE.R1).toEqual(["card", "follow", "dictation"]);
    expect(VISIT_TEMPLATE.R2).toEqual(["card-no-hints", "follow", "dictation"]);
    expect(VISIT_TEMPLATE.R3).toEqual(["dictation"]);
  });

  it("SESSION_SCHEDULER：三轮制 + 新旧交替 + 同词不背靠背 + 复核入队尾", () => {
    expect(SESSION_SCHEDULER.passes).toEqual(["recognition", "consolidation", "production"]);
    expect(SESSION_SCHEDULER.rule).toBe("no-back-to-back-same-word");
    expect(SESSION_SCHEDULER.fallbackEnqueue).toBe("session-tail");
  });
});
