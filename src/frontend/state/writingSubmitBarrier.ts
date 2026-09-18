/**
 * 提交屏障决策（W10 修复，S§4）：flush 回执 vs 权威读面的核对函数——纯函数单一真源。
 *
 * 纪律（本轮验收条款）：
 * - GET 只用于**核对**权威状态，绝不盲目采用"最新 version"绕过冲突；
 * - 提交正文必须等于本次用户确认提交的正文（receipt.text）且版本未被他人推进
 *   （receipt.version）；任一不符 → 冲突/刷新路径，**不提交、不自动重试**。
 */

/** flush 回执（= controller.WritingSaveFlushReceipt，结构对齐）。 */
export interface SubmitReceipt {
  text: string;
  version: number;
}

/** 权威读面（getSheet 的核对子集）。 */
export interface AuthoritativeDraftState {
  status: string;
  text: string | null;
  draftVersion: number;
}

export type SubmitPrecheck =
  | { ok: true; expectedVersion: number }
  | { ok: false; reason: "not-draft" | "text-mismatch" | "version-mismatch" };

export function evaluateSubmitPrecheck(
  receipt: SubmitReceipt,
  latest: AuthoritativeDraftState,
): SubmitPrecheck {
  // 已被其他标签页提交：非冲突而是"已提交"——上层刷新进入只读。
  if (latest.status !== "draft") return { ok: false, reason: "not-draft" };
  // 正文不一致：服务器上是别人的修订，绝不能当作本次提交。
  if ((latest.text ?? "") !== receipt.text) return { ok: false, reason: "text-mismatch" };
  // 版本被推进（即使正文同形）：不采用最新 version，按冲突处理。
  if (latest.draftVersion !== receipt.version) return { ok: false, reason: "version-mismatch" };
  return { ok: true, expectedVersion: receipt.version };
}
