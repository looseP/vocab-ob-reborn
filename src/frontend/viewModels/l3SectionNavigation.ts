/**
 * L3 做题子空间导航契约（2026-09-26）—— L3 各用户面的 URL 单一真源。
 *
 * 规范 URL：`/l3?section=<papers|practice|error-book|session|home|source|word|graph>`
 *
 * 为什么补（这些面此前无 URL 契约）：
 *  - 不可分享：把「去做这套题」的链接发给 agent/自己另一台设备打不开；
 *  - 不可收藏：浏览器收藏夹存不到具体面；
 *  - 返回键坏：L3 子应用只在本地 state 里切 section（L3Page `useState`），
 *    浏览器前进/后退不产生任何 section 变化。
 *
 * 覆盖范围（一个用户面一个规范 URL，声明一次）：
 *  - 本模块拥有：`home` `source` `papers` `practice` `errorBook` `session`
 *    `word` `graph` —— 它们没有别的 URL 契约。
 *  - 本模块**不**拥有：`writing` 与 `studyNotes`（各有专用契约，携带
 *    taskId/venue/noteId 等参数，契约更窄 —— 一个 URL 契约一个真源，ADR-0025）。
 *  - 故意不覆盖：`context`（语境条目 = 工程检查器，在侧栏「工程工具」折叠组内）、
 *    `import` / `manual` / `proposals` / `recommendations`（工程工具面）。
 *
 * 其它深链参数（`venue` / `file` / `paper` / `sheet` / `resumeSheet` / `question`
 * / `context`）由各消费页自己解析，此处不解析、不改写。
 */
import type { L3ShellSection } from "./l3ShellViewModel";

/** 本模块拥有的 section → URL 参数值映射（shell id → kebab-case 参数值）。 */
const SECTION_PARAM_BY_SHELL: Partial<Record<L3ShellSection, string>> = {
  home: "home",
  source: "source",
  papers: "papers",
  practice: "practice",
  errorBook: "error-book",
  session: "session",
  word: "word",
  graph: "graph",
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
