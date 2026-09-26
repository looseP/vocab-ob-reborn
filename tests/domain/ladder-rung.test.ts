/**
 * 阶梯起步档纯函数单元测试（ADR-0036 决策 1）。
 *
 * 验证点：
 * - shiftLadderRung：good/easy +1 · hard 0 · again −1；边界 clamp 1..3
 * - floorLadderRung：S≥21d ⇒ ≥R2 单向地板（只升不降）；S 缺失原样
 * - settleLadderRung：先 ±1 再地板
 * - deriveLadderRung（迁移 0045 幂等回填的可测镜像）：
 *   rv=0→1；S≥21→3；S≥7→2；其余→1（与迁移 SQL 逐分支一致）
 */

import { describe, it, expect } from "vitest";
import {
  shiftLadderRung,
  floorLadderRung,
  settleLadderRung,
  deriveLadderRung,
} from "@/domain/ladder-rung";

describe("shiftLadderRung", () => {
  it("good/easy 各 +1", () => {
    expect(shiftLadderRung(1, "good")).toBe(2);
    expect(shiftLadderRung(1, "easy")).toBe(2);
    expect(shiftLadderRung(2, "good")).toBe(3);
    expect(shiftLadderRung(2, "easy")).toBe(3);
  });

  it("hard 原地不动", () => {
    expect(shiftLadderRung(1, "hard")).toBe(1);
    expect(shiftLadderRung(2, "hard")).toBe(2);
    expect(shiftLadderRung(3, "hard")).toBe(3);
  });

  it("again −1", () => {
    expect(shiftLadderRung(3, "again")).toBe(2);
    expect(shiftLadderRung(2, "again")).toBe(1);
  });

  it("边界 clamp：R3 的 good/easy 停在 3，R1 的 again 停在 1", () => {
    expect(shiftLadderRung(3, "good")).toBe(3);
    expect(shiftLadderRung(3, "easy")).toBe(3);
    expect(shiftLadderRung(1, "again")).toBe(1);
  });
});

describe("floorLadderRung（单向地板）", () => {
  it("S≥21d 把 R1 抬到 R2（只升不降）", () => {
    expect(floorLadderRung(1, 21)).toBe(2);
    expect(floorLadderRung(1, 30)).toBe(2);
    expect(floorLadderRung(1, 365)).toBe(2);
  });

  it("地板永不降档：R2/R3 在 S≥21d 保持原档", () => {
    expect(floorLadderRung(2, 25)).toBe(2);
    expect(floorLadderRung(3, 25)).toBe(3);
  });

  it("S<21d 无地板效应", () => {
    expect(floorLadderRung(1, 20.9)).toBe(1);
    expect(floorLadderRung(3, 1)).toBe(3);
    expect(floorLadderRung(2, 0)).toBe(2);
  });

  it("S 缺失/非法时原样返回", () => {
    expect(floorLadderRung(1, null)).toBe(1);
    expect(floorLadderRung(2, undefined)).toBe(2);
    expect(floorLadderRung(3, Number.NaN)).toBe(3);
  });
});

describe("settleLadderRung（±1 + 单向地板）", () => {
  it("again 先降到 1，再被 S≥21d 地板抬回 2", () => {
    expect(settleLadderRung(2, "again", 25)).toBe(2);
  });

  it("无地板时按纯 ±1 结算", () => {
    expect(settleLadderRung(2, "again", 3)).toBe(1);
    expect(settleLadderRung(2, "good", 3)).toBe(3);
    expect(settleLadderRung(2, "hard", 25)).toBe(2);
  });

  it("R1 + good + S≥21d → R2（shift 与 floor 同向叠加）", () => {
    expect(settleLadderRung(1, "good", 21)).toBe(2);
  });
});

describe("deriveLadderRung（迁移 0045 回填口径）", () => {
  it("rv=0 一律 R1（新卡/未复习）", () => {
    expect(deriveLadderRung({ stabilityDays: null, reviewCount: 0 })).toBe(1);
    expect(deriveLadderRung({ stabilityDays: 30, reviewCount: 0 })).toBe(1);
  });

  it("S≥21d → R3", () => {
    expect(deriveLadderRung({ stabilityDays: 21, reviewCount: 3 })).toBe(3);
    expect(deriveLadderRung({ stabilityDays: 26, reviewCount: 5 })).toBe(3);
  });

  it("7≤S<21 → R2", () => {
    expect(deriveLadderRung({ stabilityDays: 7, reviewCount: 2 })).toBe(2);
    expect(deriveLadderRung({ stabilityDays: 20.9, reviewCount: 2 })).toBe(2);
  });

  it("S<7 / S 缺失 → R1", () => {
    expect(deriveLadderRung({ stabilityDays: 6.9, reviewCount: 2 })).toBe(1);
    expect(deriveLadderRung({ stabilityDays: null, reviewCount: 4 })).toBe(1);
  });

  it("幂等：同一输入重复派生结果不变（回填可重放）", () => {
    const cases = [
      { stabilityDays: null, reviewCount: 0 },
      { stabilityDays: 30, reviewCount: 2 },
      { stabilityDays: 10, reviewCount: 3 },
      { stabilityDays: 2, reviewCount: 1 },
    ] as const;
    for (const input of cases) {
      expect(deriveLadderRung({ ...input })).toBe(deriveLadderRung({ ...input }));
    }
  });
});
