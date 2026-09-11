import { describe, expect, it } from "vitest";
import { computeUpgradeSuggestion } from "@/domain/upgrade-suggestion";
import type { OtherBookL2Signal } from "@/domain/upgrade-suggestion";

function l1(recentRatings: string[], state = "learning") {
  return { recentRatings, state };
}

function l2(overrides: Partial<OtherBookL2Signal> = {}): OtherBookL2Signal {
  return { state: "review", retrievability: 0.95, l2ProductionStatus: null, ...overrides };
}

describe("computeUpgradeSuggestion", () => {
  describe("R1 需要沉淀｜当前书失败证据", () => {
    it("最近一次 again → needs_settling（即使他书已掌握）", () => {
      expect(
        computeUpgradeSuggestion({ currentBookL1: l1(["good", "again"]), otherBooksL2: [l2()] }),
      ).toBe("needs_settling");
    });

    it("当前书 state=relearning → needs_settling（即使他书已掌握）", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good"], "relearning"),
          otherBooksL2: [l2()],
        }),
      ).toBe("needs_settling");
    });

    it("窗口只看最近 3 次：更早的 again 不否决", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["again", "good", "good", "good"]),
          otherBooksL2: [],
        }),
      ).toBe("normal");
    });
  });

  describe("R2 需要沉淀｜他书全无掌握且存在不稳定证据", () => {
    it("他书 state=relearning → needs_settling", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good", "good"]),
          otherBooksL2: [l2({ state: "relearning" })],
        }),
      ).toBe("needs_settling");
    });

    it("他书 retrievability 低于 0.7 → needs_settling", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good", "good"]),
          otherBooksL2: [l2({ retrievability: 0.6 })],
        }),
      ).toBe("needs_settling");
    });

    it("他书产出步自评 weak → needs_settling（即使 state=review 且 retrievability 高）", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good", "good"]),
          otherBooksL2: [l2({ retrievability: 0.98, l2ProductionStatus: "weak" })],
        }),
      ).toBe("needs_settling");
    });
  });

  describe("R3 强烈推荐升级｜他书存在可复用掌握状态", () => {
    it("state=review 且 retrievability ≥ 0.9 → strong", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good", "easy", "good"]),
          otherBooksL2: [l2({ retrievability: 0.9 })],
        }),
      ).toBe("strong");
    });

    it("产出步 passed 可独立支撑 strong（retrievability 缺失）", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good"]),
          otherBooksL2: [l2({ retrievability: null, l2ProductionStatus: "passed" })],
        }),
      ).toBe("strong");
    });

    it("跨书掌握单独成立：当前书还没有评分也判 strong", () => {
      expect(
        computeUpgradeSuggestion({ currentBookL1: l1([]), otherBooksL2: [l2()] }),
      ).toBe("strong");
    });

    it("当前书首答 hard 不否决 strong（跨书掌握才是主信号）", () => {
      expect(
        computeUpgradeSuggestion({ currentBookL1: l1(["hard"]), otherBooksL2: [l2()] }),
      ).toBe("strong");
    });

    it("一本弱行不否决另一本的强行 → strong", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good"]),
          otherBooksL2: [l2({ state: "relearning" }), l2({ retrievability: 0.95 })],
        }),
      ).toBe("strong");
    });

    it("review 但 retrievability 未达 0.9 且未 passed → 不算掌握", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good", "good"]),
          otherBooksL2: [l2({ retrievability: 0.85 })],
        }),
      ).toBe("normal");
    });
  });

  describe("R4 推荐升级｜无他书掌握证据时仅看当前书表现", () => {
    it("无他书记录 + 近期全 good/easy → normal", () => {
      expect(
        computeUpgradeSuggestion({ currentBookL1: l1(["good", "easy"]), otherBooksL2: [] }),
      ).toBe("normal");
    });

    it("他书既非掌握也非挣扎（state=learning / retrievability 缺失）→ normal", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good"]),
          otherBooksL2: [l2({ state: "learning", retrievability: null })],
        }),
      ).toBe("normal");
    });
  });

  describe("R5 兜底 = 需要沉淀｜零证据或证据不足", () => {
    it("空输入（零证据）→ needs_settling", () => {
      expect(
        computeUpgradeSuggestion({ currentBookL1: l1([]), otherBooksL2: [] }),
      ).toBe("needs_settling");
    });

    it("无他书记录 + 最近一次 hard → needs_settling", () => {
      expect(
        computeUpgradeSuggestion({ currentBookL1: l1(["good", "hard"]), otherBooksL2: [] }),
      ).toBe("needs_settling");
    });

    it("无他书记录 + 窗口内含 again（非末次）→ needs_settling", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1(["good", "again", "good"]),
          otherBooksL2: [],
        }),
      ).toBe("needs_settling");
    });

    it("他书未掌握且当前书零评分 → needs_settling", () => {
      expect(
        computeUpgradeSuggestion({
          currentBookL1: l1([]),
          otherBooksL2: [l2({ retrievability: 0.85 })],
        }),
      ).toBe("needs_settling");
    });
  });

  it("同输入恒同输出（纯函数、无时间依赖）", () => {
    const input = {
      currentBookL1: l1(["good", "easy"]),
      otherBooksL2: [l2({ retrievability: 0.4 })],
    };
    expect(computeUpgradeSuggestion(input)).toBe(computeUpgradeSuggestion(input));
  });
});
