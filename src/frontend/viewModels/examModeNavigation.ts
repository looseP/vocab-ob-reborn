/**
 * 卷面三模式的 URL 层（纯逻辑，2026-09-27）——「模式住 URL」的解析与构造。
 *
 * 规格来自 `docs/plan/l3-subspace-venue-design-card-2026-09-16.md` §2.4
 * （`?mode=pure|practice|review`）与执行文档
 * `docs/plan/l3-exam-mode-engine-execution-2026-09-27.md` §3.4。
 *
 * **为什么住 URL**：`?file=` 深链已有先例（`L3PapersPage.tsx` 的 `deepLinkFile`），
 * ADR-0025 要求 URL 契约单一真源，而现状（`revealAll` 纯内存布尔）在刷新 / 分享 /
 * 后退时全部丢失 —— 位置不可复现。
 *
 * **为什么不住库**：模式是**视图状态**，不是用户偏好。存了就会出现「上次停在解析
 * 模式，这次打开直接看到全部答案」的意外剧透。
 *
 * 口径沿 `l3SectionNavigation.ts` 的 fail-closed 纪律：
 * - 非法值（未知词、**大小写不符**）→ 返回 `null`，**由调用方**回落默认；本模块
 *   **不改写**用户输入，也不抛错 —— URL 是用户可以随便敲的地方。
 * - 两端空白**容忍**（同 `parseL3SectionParam` 先例：它也 trim）：`?mode= review `
 *   是手滑不是敌意，为它整页失败不合理。真正不可容忍的是**大小写**（`Practice` 与
 *   `practice` 语义不同就是不同，真要区分大小写就该另立一档而不是靠大小写蒙）。
 * - 缺省（参数缺失）与「显式写了默认档」是**不同的 URL**：显式写会保留，缺省不落参数。
 *   这样「深链里带 mode=」可以与「从列表点进来」区分开。
 */

/** 三模式（语义见设计卡 §2.4）。 */
export const EXAM_MODES = ["pure", "practice", "review"] as const;
export type ExamMode = (typeof EXAM_MODES)[number];

/** 缺省档：等价于本仓今天 `revealAll === false` 的行为。 */
export const EXAM_MODE_DEFAULT: ExamMode = "practice";

/** 模式参数名（与 `venue` / `file` / `paper` / `sheet` 同级）。 */
export const EXAM_MODE_PARAM = "mode";

/**
 * 解析 `?mode=` 原始值。
 *
 * - 缺失 / 空串 / 全空白 → `null`（= 缺省，不是非法）
 * - 不在三档内、或大小写不严格匹配 → `null`（= 非法，同样交给调用方回落）
 * - 两端空白容忍（见本文件头「为什么容忍空白」，同 `parseL3SectionParam`）
 *
 * 两种 `null` 都不报错：URL 是用户可随手输入的面，报错会让「敲错一个字符」变成
 * 整页失败。调用方统一用 `resolveExamMode()` 拿最终值。
 */
export function parseExamMode(raw: string | null | undefined): ExamMode | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  return (EXAM_MODES as readonly string[]).includes(value) ? (value as ExamMode) : null;
}

/**
 * 最终模式：解析 + 回落。
 *
 * 调用点的**唯一**入口 —— 组件里不允许出现 `parseExamMode(...) ?? "practice"`
 * 这种就地回落（散落的回落会各自漂移，且某一处漏回落就是裸的答案泄漏）。
 */
export function resolveExamMode(raw: string | null | undefined): ExamMode {
  return parseExamMode(raw) ?? EXAM_MODE_DEFAULT;
}

/**
 * 在既有 href 上设置/清除 `mode`，**保留**其余全部参数。
 *
 * - `mode = null` → 清除参数（缺省档不落 URL，见本文件头「缺省与显式写不同」）
 * - 保留 `venue` / `file` / `paper` / `sheet` / `question` / `section` 等 —— 深链切换
 *   模式时不得丢掉定位信息，那会让「切模式」变成「跳回列表」。
 * - 参数顺序稳定（沿 `l3SectionNavigation.ts` 注释的同款纪律：便于深链复用与测试）。
 */
export function buildExamModeUrl(href: string, mode: ExamMode | null): string {
  const url = new URL(href, "http://l3.local");
  if (mode === null) {
    url.searchParams.delete(EXAM_MODE_PARAM);
  } else {
    url.searchParams.set(EXAM_MODE_PARAM, mode);
  }
  // URLSearchParams 保留插入序；这里按 key 排序，让同一次构造的输出与传入参数顺序无关。
  url.searchParams.sort();
  const search = url.searchParams.toString();
  return `${url.pathname}${search.length > 0 ? `?${search}` : ""}${url.hash}`;
}
