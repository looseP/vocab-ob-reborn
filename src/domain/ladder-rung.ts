/**
 * Ladder rung domain — 阶梯起步档纯函数（ADR-0036）。
 *
 * 三档起步档（rung）：R1 再认 + 巩固 + 产出 / R2 再认（撤提示面板）+ 巩固 + 产出 /
 * R3 仅产出轮（默写即测量）。
 *
 * 纯函数模块：无 DB 访问、无副作用（与 content-staleness / review-queue 同模式）。
 * 结算职责（ADR-0036 决策 1）：ladder_rung 由服务端在 submitAnswer 后结算；
 * rating 由前端按政策 B 算好随 answer 提交。
 */

import type { ReviewRating } from "./index";

export type LadderRung = 1 | 2 | 3;

/** 结算进退映射（演示页 D 区 LADDER_STATE.shift）：good/easy +1 · hard 0 · again −1。 */
const RUNG_SHIFT: Record<ReviewRating, number> = {
  good: 1,
  easy: 1,
  hard: 0,
  again: -1,
};

function clampRung(value: number): LadderRung {
  return Math.min(3, Math.max(1, value)) as LadderRung;
}

/** 起步档进退：按结算 rating ±1（clamp 1..3；hard 原地不动）。 */
export function shiftLadderRung(rung: LadderRung, rating: ReviewRating): LadderRung {
  return clampRung(rung + RUNG_SHIFT[rating]);
}

/** 单向地板（拍板②）：S ≥ 21d ⇒ rung ≥ R2。只升不降；S 缺失时原样返回。 */
export function floorLadderRung(rung: LadderRung, stabilityDays: number | null | undefined): LadderRung {
  if (stabilityDays == null || !Number.isFinite(stabilityDays)) return rung;
  if (stabilityDays >= 21 && rung < 2) return 2;
  return rung;
}

/** 结算 = 先进退再地板（ADR-0036 决策 1：±1 + 单向地板）。 */
export function settleLadderRung(
  rung: LadderRung,
  rating: ReviewRating,
  stabilityDays: number | null | undefined,
): LadderRung {
  return floorLadderRung(shiftLadderRung(rung, rating), stabilityDays);
}

/**
 * 存量回填派生 f(S, rv)（ADR-0036 决策 1，迁移 0045 同口径）：
 * rv=0 → 1；S≥21 → 3；S≥7 → 2；其余 → 1。
 * lastRating 在枚举分支中不参与（分支完全由 S/rv 决定），保留入参位以对齐
 * 契约签名；纯函数与迁移 SQL 逐分支一致（幂等回填的可测镜像）。
 */
export function deriveLadderRung(input: {
  stabilityDays: number | null;
  reviewCount: number;
  lastRating?: ReviewRating | null;
}): LadderRung {
  if (input.reviewCount === 0) return 1;
  const stability = input.stabilityDays;
  if (stability != null && Number.isFinite(stability)) {
    if (stability >= 21) return 3;
    if (stability >= 7) return 2;
  }
  return 1;
}
