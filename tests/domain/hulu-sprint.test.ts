/**
 * 葫芦冲刺纯函数单元测试（ADR-0041，完备设计 §三 / §十 测试 4、9 的 domain 侧）。
 *
 * 验证点：
 * - assessHuluRisk：风险三档边界（含 `need === left × 2` 恰好值、`need === left`
 *   恰好值），perRound = ceil(n/400)，need = rounds × perRound
 * - huluGateDecision：闸门边界用**传入的 ratio 参数**（不写死 0.8），total ≤ 0 自动通过
 * - clampElapsedSeconds：负数归 0、超上限夹取、非有限值归 0
 */

import { describe, it, expect } from "vitest";
import {
  HULU_WORDS_PER_DAY,
  HULU_MAX_SINGLE_ROUND_SECONDS,
  assessHuluRisk,
  huluGateDecision,
  clampElapsedSeconds,
} from "@/domain/hulu-sprint";

describe("assessHuluRisk（风险三档）", () => {
  it("常量口径：每日 400 词，单轮上限 7 天", () => {
    expect(HULU_WORDS_PER_DAY).toBe(400);
    expect(HULU_MAX_SINGLE_ROUND_SECONDS).toBe(7 * 86400);
  });

  it("perRound = ceil(wordCount / 400)，need = targetRounds × perRound", () => {
    // 1000 词 → ceil(2.5) = 3 天/轮；4 轮 → 12 天
    const result = assessHuluRisk({ wordCount: 1000, targetRounds: 4, leftDays: 30 });
    expect(result.perRound).toBe(3);
    expect(result.need).toBe(12);
    expect(result.left).toBe(30);
    expect(result.level).toBe("ok");
  });

  it("整除时 perRound 不向上取整（800 词 → 2 天/轮）", () => {
    expect(assessHuluRisk({ wordCount: 800, targetRounds: 4, leftDays: 30 }).perRound).toBe(2);
  });

  it("刚好 1 词也占一天（ceil 的最小正数情形）", () => {
    expect(assessHuluRisk({ wordCount: 1, targetRounds: 2, leftDays: 30 }).perRound).toBe(1);
  });

  it("need > left 但 ≤ left × 2 → warn", () => {
    // 4000 词 → 10 天/轮；4 轮 → 40 天；剩余 30 天：40 > 30 且 40 ≤ 60 → warn
    const result = assessHuluRisk({ wordCount: 4000, targetRounds: 4, leftDays: 30 });
    expect(result).toEqual({ perRound: 10, need: 40, left: 30, level: "warn" });
  });

  it("need === left 恰好值 → ok（恰好赶上不算缺口）", () => {
    // 4000 词 → 10 天/轮；4 轮 → 40 天；剩余恰好 40 天
    const result = assessHuluRisk({ wordCount: 4000, targetRounds: 4, leftDays: 40 });
    expect(result.need).toBe(result.left);
    expect(result.level).toBe("ok");
  });

  it("need === left × 2 恰好值 → warn（恰好两倍是「还有救」，不是 block）", () => {
    // 4000 词 → 10 天/轮；4 轮 → 40 天；剩余 20 天：40 === 20 × 2 → warn
    const result = assessHuluRisk({ wordCount: 4000, targetRounds: 4, leftDays: 20 });
    expect(result.need).toBe(result.left * 2);
    expect(result.level).toBe("warn");
  });

  it("need > left × 2 → block", () => {
    // 剩余 19 天：40 > 38 → block
    const result = assessHuluRisk({ wordCount: 4000, targetRounds: 4, leftDays: 19 });
    expect(result.level).toBe("block");
  });

  it("block 结果携带 { need, left, perRound } 供 422 响应体使用", () => {
    const result = assessHuluRisk({ wordCount: 4000, targetRounds: 4, leftDays: 5 });
    expect(result).toEqual({ perRound: 10, need: 40, left: 5, level: "block" });
  });

  it("wordsPerDay 可注入（缺省为 HULU_WORDS_PER_DAY）", () => {
    const withDefault = assessHuluRisk({ wordCount: 1000, targetRounds: 2, leftDays: 10 });
    const explicit = assessHuluRisk({ wordCount: 1000, targetRounds: 2, leftDays: 10, wordsPerDay: 400 });
    expect(withDefault).toEqual(explicit);
    // 每日 100 词 → perRound = 10，2 轮 → 20 天
    expect(assessHuluRisk({ wordCount: 1000, targetRounds: 2, leftDays: 10, wordsPerDay: 100 }).need).toBe(20);
  });

  it("leftDays = 0（今天到期）且 need > 0 → block", () => {
    expect(assessHuluRisk({ wordCount: 400, targetRounds: 2, leftDays: 0 }).level).toBe("block");
  });
});

describe("huluGateDecision（页级闸门）", () => {
  it("恰好等于闸门比例 → pass（≥ 口径）", () => {
    expect(huluGateDecision(16, 20, 0.8)).toBe("pass");
    expect(huluGateDecision(5, 10, 0.5)).toBe("pass");
    expect(huluGateDecision(10, 10, 1)).toBe("pass");
  });

  it("低于闸门比例 → block", () => {
    expect(huluGateDecision(15, 20, 0.8)).toBe("block");
    expect(huluGateDecision(4, 10, 0.5)).toBe("block");
    expect(huluGateDecision(9, 10, 1)).toBe("block");
  });

  it("用传入的 ratio 参数判定，不写死 0.8", () => {
    // 同一个 (passed, total) 在两个不同 ratio 下结论相反
    expect(huluGateDecision(7, 10, 0.7)).toBe("pass");
    expect(huluGateDecision(7, 10, 0.71)).toBe("block");
  });

  it("total ≤ 0（整页定格词已删）→ 自动 pass", () => {
    expect(huluGateDecision(0, 0, 0.8)).toBe("pass");
    expect(huluGateDecision(0, -1, 0.8)).toBe("pass");
    // 即使 passed 也 ≤ 0，仍是 pass（删空页没有「不过闸」这件事）
    expect(huluGateDecision(-3, 0, 1)).toBe("pass");
  });
});

describe("clampElapsedSeconds（墙钟夹取）", () => {
  it("正常值原样通过（向下取整）", () => {
    expect(clampElapsedSeconds(0)).toBe(0);
    expect(clampElapsedSeconds(90)).toBe(90);
    expect(clampElapsedSeconds(90.9)).toBe(90);
  });

  it("负数（时钟回拨）归 0，不报错", () => {
    expect(clampElapsedSeconds(-1)).toBe(0);
    expect(clampElapsedSeconds(-86400)).toBe(0);
  });

  it("超上限夹取到 max（缺省 7 天）", () => {
    expect(clampElapsedSeconds(HULU_MAX_SINGLE_ROUND_SECONDS)).toBe(HULU_MAX_SINGLE_ROUND_SECONDS);
    expect(clampElapsedSeconds(HULU_MAX_SINGLE_ROUND_SECONDS + 1)).toBe(HULU_MAX_SINGLE_ROUND_SECONDS);
    expect(clampElapsedSeconds(1e12)).toBe(HULU_MAX_SINGLE_ROUND_SECONDS);
  });

  it("max 可注入", () => {
    expect(clampElapsedSeconds(500, 100)).toBe(100);
    expect(clampElapsedSeconds(50, 100)).toBe(50);
  });

  it("非有限值归 0（NaN / Infinity 都不让轮次丢）", () => {
    expect(clampElapsedSeconds(Number.NaN)).toBe(0);
    expect(clampElapsedSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampElapsedSeconds(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
