/**
 * `/api/*` 最小角色查找（ADR-0029 决策 1/2，任务 T13a §B）。
 *
 * 设计约束（A4，fail-closed）：
 *   查找表查不到的 `/api/*` 路由**一律按 owner 处理**（宁可误 403，不可漏放）。
 *   这是实现层的安全默认，不只是测试期望——见文件末尾 `FAIL_CLOSED_MIN_ROLE`。
 *
 * 为什么不用 Hono 内部状态：
 *   中间件阶段 `c.req.routePath` 不可靠（尚未完成路由匹配），因此这里在模块加载时
 *   把注册表 `apiOperations` 的 path template 编译成 `method + RegExp` 查找表，
 *   解析逻辑完全脱离 HTTP，可单独单测（B2）。注册表是唯一真源：`minRole` 只在这里被读。
 *
 * 匹配顺序：
 *   先按"静态段更多者优先"排序（`/api/words/suggest` 必须胜过 `/api/words/:slug`），
 *   同级再按注册表声明顺序，保证确定性。
 */
import { apiOperations, type ApiMinRole } from "../operations";

/** 查不到时的 fail-closed 角色（A4）。 */
export const FAIL_CLOSED_MIN_ROLE: ApiMinRole = "owner";

interface CompiledRule {
  readonly method: string;
  readonly pattern: RegExp;
  readonly minRole: ApiMinRole;
  readonly specificity: number;
  readonly order: number;
}

function escapeLiteral(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把 `/api/words/:slug` 编译为 `^/api/words/[^/]+$`；仅静态段做正则转义。 */
export function compilePathTemplate(template: string): RegExp {
  const source = template
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : escapeLiteral(segment)))
    .join("/");
  return new RegExp(`^${source}$`);
}

function staticSegmentCount(template: string): number {
  return template.split("/").filter((segment) => segment !== "" && !segment.startsWith(":")).length;
}

/**
 * 编译 `/api/*` 查找表。非 `/api/*` 的 operation（healthz、metrics…）不进表：
 * 它们各有独立挂载点/独立 bearer，不应由本查找表判定。
 */
const API_RULES: readonly CompiledRule[] = apiOperations
  .filter((operation) => operation.path.startsWith("/api/"))
  .map((operation, order): CompiledRule => ({
    method: operation.method.toUpperCase(),
    pattern: compilePathTemplate(operation.path),
    minRole: operation.minRole,
    specificity: staticSegmentCount(operation.path),
    order,
  }))
  .sort((left, right) => right.specificity - left.specificity || left.order - right.order);

/**
 * 解析某次请求的 `/api/*` 最小角色。`method` 大小写不敏感，`path` 必须不含 query。
 */
export function resolveMinRole(method: string, path: string): ApiMinRole {
  const upperMethod = method.toUpperCase();
  for (const rule of API_RULES) {
    if (rule.method === upperMethod && rule.pattern.test(path)) return rule.minRole;
  }
  // fail-closed：未知 /api/* 路由按 owner 处理。
  return FAIL_CLOSED_MIN_ROLE;
}
