/**
 * 复习卡 ↔ L3 语境阅读视图的**往返契约**（FR-12 接线1 回程，2026-10-04）。
 *
 * 背景：`/review` 与 `/l3` 是同级路由，从复习卡跳去 L3 时 ReviewPage 会卸载、
 * `mode` 局部状态丢失，回来只能靠 localStorage 会话缓存复原（含 `currentIndex`）。
 * 缓存复原本来要用户再点一次「继续上次」——而这次跳转是**用户主动往返**，
 * 不是"上次没关掉的会话"，那一次点击就是链路断点。
 *
 * 本模块只做判定（纯函数，零 DOM/路由依赖），两侧引用同一份：
 * - L3 侧：读 `location.state` 决定是否显示「← 返回复习」；
 * - 复习侧：读同一标记决定是否**自动续接**缓存会话（跳过确认条）。
 *
 * ⚠️ 只认**严格** `true`：`state` 是路由透传的任意 JSON（刷新后来自 history.state），
 * 不能因为"有个 fromReview 键"就放行 —— 误判会让用户在自己的复习页面上被静默换卡。
 */

/** 回程标记的载荷形状（`<Link state={...}>` / `navigate(..., { state })` 用同一份）。 */
export interface ReviewReturnState {
  fromReview: true;
}

/** 打回程标记的载荷（L3ContextsFold 的深链与「← 返回复习」共用）。 */
export function reviewReturnState(): ReviewReturnState {
  return { fromReview: true };
}

/** 该路由 state 是否表示"从复习卡过来的往返"。 */
export function isReviewReturnNavigation(state: unknown): boolean {
  if (state === null || typeof state !== "object") return false;
  return (state as { fromReview?: unknown }).fromReview === true;
}

/**
 * 是否应当**自动**续接缓存会话（跳过「继续上次 / 重新开始」确认条）。
 *
 * 三个条件全部满足才自动：
 * 1. 本次导航带回程标记（用户是主动往返，不是冷启动）；
 * 2. 当前还停在模式选择区（已经在会话里就不要再动状态）；
 * 3. 确实扫到了可恢复的会话（没有缓存可恢复时自动续接无从谈起，交给正常流程）。
 */
export function shouldAutoRestoreSession(input: {
  fromReview: boolean;
  mode: "select" | "session" | string;
  hasPendingRestore: boolean;
}): boolean {
  return input.fromReview && input.mode === "select" && input.hasPendingRestore;
}

/** 回程目标路径（单一常量，避免两侧各写一份字符串）。 */
export const REVIEW_PATH = "/review";
