/**
 * L3 会话壳 viewModel（ADR-0019 §2）——全部纯函数，浏览器安全。
 *
 * 会话 = 服务端计划（plan jsonb 只存实体 id 引用）+ 现拉现渲染描述；本模块：
 *   - 容错解析 session.plan 的引用（畸形返回空数组，绝不抛错、绝不白屏）；
 *   - 对照渲染结果计算「引用实体已被删除」的占位（ADR-0028：删除走阻塞式，
 *     但语境仍可能先被清理，plan 引用悬空时 UI 必须以占位呈现而非丢失）；
 *   - 识别服务端对未知 plan version 抛出的业务错（422 BUSINESS_RULE +
 *     "Unsupported L3 session plan version"），提示重建而不是静默降级。
 */
import type {
  Json,
  L3SessionContextSummary,
  L3SessionPlanItem,
  L3SessionRenderDescription,
  L3SessionStatus,
  L3SessionType,
} from "@/domain";
import type { NormalizedL3Error } from "@/l3/frontend/contract";

/** 会话类型中文标签（l3_sessions.type CHECK 同值）。 */
export const SESSION_TYPE_LABELS: Record<L3SessionType, string> = {
  l2_upgrade: "L2 升级工作台",
  l3_practice: "L3 练习",
  cram_pack: "攻坚包",
  knowledge: "知识梳理",
};

/** 会话状态中文标签（l3_sessions.status CHECK 同值）。 */
export const SESSION_STATUS_LABELS: Record<L3SessionStatus, string> = {
  active: "进行中",
  completed: "已完成",
  abandoned: "已放弃",
};

/** 未知 plan version 的标准提示（不静默；引导重建）。 */
export const SESSION_PLAN_VERSION_EXPIRED_COPY = "会话计划版本已过期，请重建";

/** 容错读取 plan.items 的实体引用（缺省/畸形一律空数组，供正常降级渲染）。 */
export function readSessionPlanItems(plan: Json): L3SessionPlanItem[] {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return [];
  const rawItems = (plan as Record<string, Json>).items;
  if (!Array.isArray(rawItems)) return [];
  const items: L3SessionPlanItem[] = [];
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, Json>;
    const contextIds = Array.isArray(record.contextIds)
      ? record.contextIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    items.push({ day: typeof record.day === "number" ? record.day : items.length + 1, contextIds });
  }
  return items;
}

export interface SessionDayGroup {
  day: number;
  contexts: L3SessionContextSummary[];
  /** plan 引用了、但本次现拉时已拉不到的语境 id（= 已被删除，渲染占位）。 */
  deletedContextIds: string[];
}

/**
 * 渲染分组：按天合并「plan 引用」与「本次现拉结果」。
 * 已删除的引用 = plan.items[].contextIds − 渲染结果里出现的 id。
 */
export function buildSessionDayGroups(rendered: L3SessionRenderDescription): SessionDayGroup[] {
  const planItems = readSessionPlanItems(rendered.session.plan);
  const renderedByDay = new Map<number, L3SessionContextSummary[]>(
    rendered.items.map((item) => [item.day, item.contexts]),
  );
  const planByDay = new Map<number, string[]>(planItems.map((item) => [item.day, item.contextIds]));
  const days = [...new Set<number>([...renderedByDay.keys(), ...planByDay.keys()])].sort((a, b) => a - b);

  const groups: SessionDayGroup[] = [];
  for (const day of days) {
    const contexts = renderedByDay.get(day) ?? [];
    const planIds = planByDay.get(day) ?? [];
    const presentIds = new Set(contexts.map((context) => context.id));
    const deletedContextIds = planIds.filter((id) => !presentIds.has(id));
    if (contexts.length === 0 && deletedContextIds.length === 0) continue;
    groups.push({ day, contexts, deletedContextIds });
  }
  return groups;
}

/** 会话标题（缺省回退，不显示空白）。 */
export function sessionDisplayTitle(title: string | null | undefined): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  return trimmed.length > 0 ? trimmed : "未命名会话";
}

/**
 * 未知 plan version 识别：服务层 `readSessionPlan` 对 version ≠ 1 抛
 * BusinessRuleError（422 / BUSINESS_RULE / "Unsupported L3 session plan
 * version: ..."）。前端据此提示「已过期，请重建」，其他 422 不套用此文案。
 */
export function isSessionPlanVersionError(error: NormalizedL3Error | null | undefined): boolean {
  if (!error) return false;
  return error.status === 422 && error.code === "BUSINESS_RULE" && /plan version/i.test(error.message);
}
