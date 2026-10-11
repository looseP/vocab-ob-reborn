// @vitest-environment jsdom
/**
 * 阶梯双通道开关（ladderSettings）单测。
 *
 * 锁定三条纪律：
 *  1. 默认关 —— 阶梯是有额外时间成本的会话形态，不替用户默认开启；
 *  2. 双通道独立 —— review/learn 各管各的，互不同步（这是 2026-10-10 拍板
 *     「两个独立开关」的结构性保证）；
 *  3. 坏值回落 —— 只认 `"1"` 为开，脏值一律按关（与 dailyReviewLimit 同纪律）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  isLadderEnabledFor,
  ladderModeStorageKey,
  setLadderEnabledFor,
} from "@/frontend/utils/ladderSettings";

beforeEach(() => {
  localStorage.clear();
});

describe("ladderSettings（双通道开关）", () => {
  it("默认关：两通道都无键时均返回 false", () => {
    expect(isLadderEnabledFor("review")).toBe(false);
    expect(isLadderEnabledFor("learn")).toBe(false);
  });

  it("写入开启后持久化到各自的键", () => {
    setLadderEnabledFor("review", true);
    expect(localStorage.getItem(ladderModeStorageKey("review"))).toBe("1");
    expect(isLadderEnabledFor("review")).toBe(true);
    // learn 通道不受影响
    expect(isLadderEnabledFor("learn")).toBe(false);
    expect(localStorage.getItem(ladderModeStorageKey("learn"))).toBeNull();
  });

  it("双通道独立：开 review 不影响 learn，反之亦然", () => {
    setLadderEnabledFor("learn", true);
    expect(isLadderEnabledFor("learn")).toBe(true);
    expect(isLadderEnabledFor("review")).toBe(false);

    setLadderEnabledFor("review", true);
    expect(isLadderEnabledFor("review")).toBe(true);
    expect(isLadderEnabledFor("learn")).toBe(true);

    setLadderEnabledFor("review", false);
    expect(isLadderEnabledFor("review")).toBe(false);
    expect(isLadderEnabledFor("learn")).toBe(true);
  });

  it("关闭时删键（不留 '0' 残值）", () => {
    setLadderEnabledFor("review", true);
    setLadderEnabledFor("review", false);
    expect(localStorage.getItem(ladderModeStorageKey("review"))).toBeNull();
    expect(isLadderEnabledFor("review")).toBe(false);
  });

  it("坏值回落：非 '1' 的值（true/0/乱码/空串）一律按关", () => {
    for (const bad of ["true", "0", "yes", "garbage", ""]) {
      localStorage.setItem(ladderModeStorageKey("review"), bad);
      expect(isLadderEnabledFor("review"), `脏值 ${JSON.stringify(bad)} 不应开启开关`).toBe(false);
    }
  });
});
