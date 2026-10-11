/**
 * 阶梯会话双通道开关（2026-10-10，ADR-0036 §4 再次修订）。
 *
 * 历史沿革 —— 这个开关来回改了三次，每次的痛点都不同：
 *  1. **v1 全局开关**（2026-09-26，键 `vocab-ladder-mode`）：一个布尔值悄悄接管
 *     「标准复习」和「快速开始」——用户无从预期自己被换了卡；开关藏在设置页 /
 *     卡片内，不可见。
 *  2. **显式第 5 模式**（2026-10-03 修订）：「不选 ⇒ 分支不可达」，预期问题解决了，
 *     但带来新痛点：阶梯被孤立成次要入口，主入口（到期复习 / 学新词）反而享受
 *     不到三轮制——而「学新词的编码强化」恰恰是阶梯的核心设计初衷（跟写 + 默写
 *     对新记忆的固化价值最大）。
 *  3. **v3 双通道开关**（本次）：回到开关形态，但按 v1 的教训做对两件事——
 *     a. **双通道独立**：`vocab-ladder-mode:review` / `vocab-ladder-mode:learn`
 *        各管各的入口。复习想速刷、学新词想走三轮制（或反过来）可以只开一个；
 *        「急的时候关闭速刷」两个开关一按即可。
 *     b. **状态就地可见**：开关渲染在两个大卡片上（非设置页），开启时卡片的
 *        徽标与描述同步变化——「被换了卡」从 v1 的「无从预期」变成「一眼可见」。
 *
 * 默认关（速刷）：阶梯是有额外时间成本的会话形态，不替用户默认开启。
 *
 * 语义边界：
 *  - 只影响「点开始进哪个会话」，不影响已进行中的会话；
 *  - 纯本地偏好（localStorage），不做服务端同步（ADR-0036 原话）。
 */

/** 阶梯开关作用的通道（与复习页两个大卡片一一对应）。 */
export type LadderChannel = "review" | "learn";

export const LADDER_MODE_KEY_PREFIX = "vocab-ladder-mode";

export function ladderModeStorageKey(channel: LadderChannel): string {
  return `${LADDER_MODE_KEY_PREFIX}:${channel}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 某通道的阶梯开关是否开启。
 *
 * 只认 `"1"` 为开：脏值（旧格式 `"true"`、乱码、空串）一律按关处理 ——
 * 与 dailyReviewLimit 的解析纪律一致，不放任坏值改变会话形态。
 */
export function isLadderEnabledFor(channel: LadderChannel): boolean {
  return safeStorage()?.getItem(ladderModeStorageKey(channel)) === "1";
}

/** 写入开关状态；关时删键（不留 `"0"` 残值，保持存储干净）。 */
export function setLadderEnabledFor(channel: LadderChannel, enabled: boolean): void {
  const storage = safeStorage();
  if (!storage) return;
  if (enabled) {
    storage.setItem(ladderModeStorageKey(channel), "1");
  } else {
    storage.removeItem(ladderModeStorageKey(channel));
  }
}
