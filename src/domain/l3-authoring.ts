/**
 * 录题授权面纯函数（ADR-0037，2026-09-26）。
 *
 * 本模块只做**判定**，不碰 IO：角色 → 落库 lifecycle、可改状态集合、能力自述枚举。
 * 放在 domain 层是因为这三件事必须只有一处实现 —— service 与 HTTP 路由都要用，
 * 复制即漂移（同 ADR-0025 单一代码路径纪律、ADR-0029 决策 8③「数字从常量导出」）。
 *
 * 为什么是闸门而不是新信任级：录题产物是**判断内容**（答案键 + 证据锚点）。一道
 * 答案键有误的 active 题，只要被作答过一次就**永久不可改**（PATCH 409，答案历史
 * 不可改写），而作答记录 / 题级错题库 / 评卷分析全建在它上面。闸门把这个不可撤销
 * 的判定挡在「被作答之前」，代价是每批一次 owner 采纳。
 */

/** 写入者身份：由服务端从已解析的 Principal 认定，请求体**不携带**（strict 拒越权键）。 */
export type AuthoringActor =
  | { role: "owner" }
  /** agentId 必填：没有可追责的 agentId 就不该落库（ADR-0029 决策 5 信任锚）。 */
  | { role: "agent"; agentId: string };

export type L3QuestionStatus = "pending" | "active" | "rejected";

/** 落库 lifecycle：status + created_by（服务端认定，非调用方自报）。 */
export type AuthoringLifecycle = { status: L3QuestionStatus; createdBy: string };

/**
 * 角色 → lifecycle。owner 直写 active；agent 一律 pending。
 * `created_by` = 'owner' 或 agentId。
 */
export function resolveAuthoringLifecycle(actor: AuthoringActor): AuthoringLifecycle {
  if (actor.role === "owner") return { status: "active", createdBy: "owner" };
  return { status: "pending", createdBy: actor.agentId };
}

/**
 * 某角色**可改**的题状态集合（改题面）。
 *
 * - owner：`active` 与 `pending` 都可改 —— 待录题必须能改，否则 owner 看见错答案键
 *   只能驳回、不能修，白白逼用户回到手录。`rejected` 不可改（终态）。
 * - agent：**只** `pending`。绝不能让它改 `active`：那等于绕过采纳闸门静默改掉
 *   用户已认定的题。
 */
export function editableQuestionStatuses(actor: AuthoringActor): readonly L3QuestionStatus[] {
  return actor.role === "owner" ? ["active", "pending"] : ["pending"];
}

/** 是否可被 agent 触碰（owner 路径恒 true；本函数只服务 agent-only 断言）。 */
export function agentMayWrite(actor: AuthoringActor): boolean {
  return actor.role === "agent";
}

/**
 * agent 录题能力自述（`GET /api/l3/capabilities` 的 `authoring` 字段真源）。
 * 枚举值**只在这里**定义一次，路由与测试都从这里取 —— 文档与常量分家就会腐化。
 */
export const L3_AUTHORING_CAPABILITIES = {
  agentCanCreate: "pending",
  agentCanEdit: "pending_only",
  agentCanDelete: false,
  accept: "owner_only",
  /** agent 建卷存在且立即 active，但**卷内题强制 pending**（闸门落在题上，见 ADR-0037 补记）。 */
  paperGate: "questions_pending",
} as const;
