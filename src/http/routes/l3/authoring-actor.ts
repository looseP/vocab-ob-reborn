/**
 * 录题写入者身份（ADR-0037）——**唯一**从 Principal 认定 actor 的地方。
 *
 * 独立成模块（沿 `l2-shared.ts` 先例）而不是塞进 `l3/shared.ts`：后者受复杂度
 * 棘轮冻结在基线（22 行），而本函数是录题闸门的一部分，与"解析助手"不同族。
 *
 * 路由层注入、请求体不携带（四个录题 schema 一律 `.strict()` 拒越权键），service
 * 据此决定落库 lifecycle（agent → `pending`）与可改状态集合。放在独立模块是为了
 * 杜绝"某个路由手写 `{role:'agent'}`"这类绕过信任锚的写法。
 *
 * 注：agentId 缺失时**不**降级成 owner —— 宁可抛错也不让一个无法追责的写入冒充
 * owner 落库（与 ADR-0029 决策 5 的 fail-closed 同构）。
 */
import type { AuthoringActor } from "@/domain";
import type { Context } from "hono";

export function authoringActor(c: Context): AuthoringActor {
  const principal = c.get("principal");
  if (principal.role !== "agent") return { role: "owner" };
  if (!principal.agentId) {
    throw new Error("agent principal without agentId（信任锚缺失，拒绝落库）");
  }
  return { role: "agent", agentId: principal.agentId };
}
