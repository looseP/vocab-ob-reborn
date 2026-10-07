/**
 * 葫芦冲刺纯函数单元测试（ADR-0041，完备设计 §三 / §十 测试 4、9 的 domain 侧）。
 *
 * 验证点：
 * - assessHuluRisk：风险三档边界（含 `need === left × 2` 恰好值、`need === left`
 *   恰好值），perRound = ceil(n/400)，need = rounds × perRound
 * - huluGateDecision：闸门边界用**传入的 ratio 参数**（不写死 0.8），total ≤ 0 自动通过
 * - clampElapsedSeconds：负数归 0、超上限夹取、非有限值归 0
 * - huluSameWordSet（R13）：指纹一致才算可比较轮，null 两边任一即不可比
 */

import { describe, it, expect } from "vitest";
import {
  HULU_WORDS_PER_DAY,
  HULU_MAX_SINGLE_ROUND_SECONDS,
  assessHuluRisk,
  huluGateDecision,
  huluSameWordSet,
  huluWordSetVerdict,
  clampElapsedSeconds,
  type HuluProtocolVersion,
  type HuluRoundKind,
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

describe("huluSameWordSet（R13 可比较轮判据）", () => {
  it("两边指纹非空且相等 → true（结算词集一致，降幅可比）", () => {
    expect(huluSameWordSet("a1b2c3d4e5f60718", "a1b2c3d4e5f60718")).toBe(true);
  });

  it("指纹不同 → false（词集漂移，降幅不可比）", () => {
    expect(huluSameWordSet("a1b2c3d4e5f60718", "0f1e2d3c4b5a6978")).toBe(false);
  });

  it("任一边为 null（未收尾 / 存量行不回填）→ false（不比较）", () => {
    expect(huluSameWordSet(null, "a1b2c3d4e5f60718")).toBe(false);
    expect(huluSameWordSet("a1b2c3d4e5f60718", null)).toBe(false);
    expect(huluSameWordSet(null, null)).toBe(false);
  });

  it("空串不被当作有效指纹（空串 ≠ 空串）", () => {
    // 空串是「有值」但无意义：契约上指纹要么是 16 位 hex、要么 null；
    // 这里锁住「空串不构成可比较」，免得把脏数据当成同一词集。
    expect(huluSameWordSet("", "")).toBe(false);
    expect(huluSameWordSet("", "a1b2c3d4e5f60718")).toBe(false);
  });

  it("词数相同不构成可比较（判据是指纹不是长度）：同长度不同值 → false", () => {
    expect(huluSameWordSet("0000000000000000", "0000000000000001")).toBe(false);
  });

  it("防御性：整列缺席（undefined，旧缓存/局部 mock）不炸，按不可比较处理", () => {
    const missing = undefined as unknown as string | null;
    expect(huluSameWordSet(missing, "a1b2c3d4e5f60718")).toBe(false);
    expect(huluSameWordSet("a1b2c3d4e5f60718", missing)).toBe(false);
    expect(huluSameWordSet(missing, missing)).toBe(false);
  });
});

describe("huluWordSetVerdict（三态判据，界面文案据此区分两种「不可比」）", () => {
  it("指纹非空且相等 → comparable（且与 huluSameWordSet 恒等）", () => {
    expect(huluWordSetVerdict("a1b2c3d4e5f60718", "a1b2c3d4e5f60718")).toBe("comparable");
    expect(huluSameWordSet("a1b2c3d4e5f60718", "a1b2c3d4e5f60718"))
      .toBe(huluWordSetVerdict("a1b2c3d4e5f60718", "a1b2c3d4e5f60718") === "comparable");
  });

  it("指纹不同 → different-word-set（词集**真的**漂移了）", () => {
    expect(huluWordSetVerdict("a1b2c3d4e5f60718", "0f1e2d3c4b5a6978")).toBe("different-word-set");
  });

  it("指纹缺失（null / 空串 / undefined）→ no-fingerprint，**不是** different-word-set", () => {
    // 这是在修一个会撒谎的文案：存量 legacy 轮回填后指纹为 null（0051 明文不回填），
    // 若把它归进「词集已变化」，老计划用户会看到「词集变了」而实际没变。
    expect(huluWordSetVerdict(null, "a1b2c3d4e5f60718")).toBe("no-fingerprint");
    expect(huluWordSetVerdict("a1b2c3d4e5f60718", null)).toBe("no-fingerprint");
    expect(huluWordSetVerdict(null, null)).toBe("no-fingerprint");
    expect(huluWordSetVerdict("", "")).toBe("no-fingerprint");
    expect(huluWordSetVerdict("", "a1b2c3d4e5f60718")).toBe("no-fingerprint");
    const missing = undefined as unknown as string | null;
    expect(huluWordSetVerdict(missing, "a1b2c3d4e5f60718")).toBe("no-fingerprint");
  });

  it("三态互斥且完备：任取输入只落一态，且 comparable ⟺ huluSameWordSet 为真", () => {
    const inputs: Array<[string | null, string | null]> = [
      ["fp-a", "fp-a"],
      ["fp-a", "fp-b"],
      [null, "fp-a"],
      ["fp-a", null],
      [null, null],
      ["", "fp-a"],
    ];
    for (const [a, b] of inputs) {
      expect(["comparable", "no-fingerprint", "different-word-set"]).toContain(huluWordSetVerdict(a, b));
      expect(huluSameWordSet(a, b)).toBe(huluWordSetVerdict(a, b) === "comparable");
    }
  });
});

describe("协议类型（迁移 0051 的取值面）", () => {
  it("HuluRoundKind 三值齐备（曝光 / 复习 / 存量）", () => {
    const kinds: HuluRoundKind[] = ["exposure", "recall", "legacy"];
    expect(kinds).toHaveLength(3);
  });

  it("HuluProtocolVersion 两值齐备（新 / 存量）", () => {
    const versions: HuluProtocolVersion[] = ["v2", "legacy"];
    expect(versions).toHaveLength(2);
  });
});

describe("clampElapsedSeconds（墙钟夹取）", () => {  it("正常值原样通过（向下取整）", () => {
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
