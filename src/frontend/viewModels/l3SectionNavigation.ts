/**
 * L3 做题子空间导航契约（2026-09-26）——试卷台 / 练习 / 错题库 / 会话 的 URL 单一真源。
 *
 * 规范 URL：`/l3?section=<papers|practice|error-book|session>`
 *
 * 为什么补（这四个面此前无 URL 契约）：
 *  - 不可分享：把「去做这套题」的链接发给 agent/自己另一台设备打不开；
 *  - 不可收藏：浏览器收藏夹存不到具体面；
 *  - 返回键坏：L3 子应用只在本地 state 里切 section（L3Page `useState`），
 *    浏览器前进/后退不产生任何 section 变化。
 *
 * 边界（不越权，ADR-0025 单一代码路径纪律）：
 *  - `writing` 与 `study-notes` 另有专用契约（writingNavigation /
 *    studyNoteNavigation，携带 taskId/venue/noteId 等参数），**不在此重复定义**；
 *  - `venue` / `file` / `paper` / `sheet` / `resumeSheet` / `question` 等做题
 *    深链参数由 L3PapersPage 消费，此处不解析、不改写；
 *  - 参数非法（未知 section 值）→ 返回 null，调用方按「无 section 参数」处理，
 *    **不静默纠偏到别的面**。
 */
import type { L3ShellSection } from "./l3ShellViewModel";

/** 本模块拥有的 section → URL 参数值映射（shell id → kebab-case 参数值）。 */
const SECTION_PARAM_BY_SHELL: Partial<Record<L3ShellSection, string>> = {
  papers: "papers",
  practice: "practice",
  errorBook: "error-book",
  session: "session",
};

const SHELL_BY_PARAM = new Map<string, L3ShellSection>(
  Object.entries(SECTION_PARAM_BY_SHELL).map(([shell, param]) => [param as string, shell as L3ShellSection]),
);

/** 该 section 是否有本模块的 URL 契约（false = 不归本模块管，别写它的 URL）。 */
export function hasL3SectionUrl(section: L3ShellSection): boolean {
  return SECTION_PARAM_BY_SHELL[section] !== undefined;
}

/**
 * 解析 `?section=` → shell section。未知/空/缺省一律 null（fail-closed：
 * 调用方不得把非法参数猜成某个面）。
 */
export function parseL3SectionParam(search: URLSearchParams): L3ShellSection | null {
  const raw = search.get("section");
  if (raw == null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  return SHELL_BY_PARAM.get(value) ?? null;
}

/** 唯一构造入口：`/l3?section=<param>`（顺序稳定，便于深链复用与测试）。 */
export function buildL3SectionUrl(section: L3ShellSection): string | null {
  const param = SECTION_PARAM_BY_SHELL[section];
  if (param === undefined) return null;
  return `/l3?section=${param}`;
}
