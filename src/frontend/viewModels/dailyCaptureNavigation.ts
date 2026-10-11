/**
 * 每日捕获导航参数模型（M2，2026-10-10）—— URL 契约单一真源。
 *
 * 规范 URL：`/l3?section=daily-capture`（M2 无附加参数：日期是视图状态，
 * 深链只负责落到子空间；日期流默认今天）。
 *
 * 纪律同 studyNoteNavigation：`section=daily-capture` 优先于旧深链（L3Page 只
 * 触发一个导航 effect）；解析严格（trim 后全等），不静默纠偏。
 */
export const DAILY_CAPTURE_SECTION = "daily-capture";

export function isDailyCaptureSection(search: URLSearchParams): boolean {
  return search.get("section")?.trim() === DAILY_CAPTURE_SECTION;
}
