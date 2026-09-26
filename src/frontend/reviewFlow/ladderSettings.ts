/**
 * 阶梯会话模式开关（ADR-0036 决策 4）。
 *
 * v1 为纯前端偏好：localStorage 持久化，无服务端往返。默认关闭；
 * 关闭时全部阶梯新代码路径不可达（ReviewPage 现行流原样），
 * 服务端新增字段全部 optional —— 关=与 main 行为逐字段一致。
 */

const LADDER_MODE_KEY = "vocab-ladder-mode";

export function isLadderModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LADDER_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setLadderModeEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LADDER_MODE_KEY, enabled ? "on" : "off");
  } catch {
    /* quota / private mode: 静默失败，行为退化为默认关 */
  }
}
