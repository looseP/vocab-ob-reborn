/**
 * 作文子空间导航参数模型（W7，ADR《writing-workspace》§7——URL 契约单一真源）。
 *
 * 规范 URL：/l3?section=writing&writingTaskId=<uuid>[&sheet=<uuid>][&compareTo=<sealedSheetId>]
 * `section=writing` 优先选择作文宿主；纯 `?sheet=`（无 section）由 L3Page 只读分流：
 * GET 判 scope——file/paper 沿用 F-1，writing 解析 taskId 后 replace 到本规范 URL。
 */
export const WRITING_SECTION = "writing";

export interface WritingLocation {
  /** section 参数（未显式给出为 null）。 */
  section: string | null;
  taskId: string | null;
  sheetId: string | null;
  /** 对照目标（sealed sheetId；与当前 sheet 同 task）。 */
  compareTo: string | null;
}

export function parseWritingSearch(search: URLSearchParams): WritingLocation {
  const trimmed = (value: string | null): string | null => {
    if (value == null) return null;
    const next = value.trim();
    return next.length > 0 ? next : null;
  };
  return {
    section: trimmed(search.get("section")),
    taskId: trimmed(search.get("writingTaskId")),
    sheetId: trimmed(search.get("sheet")),
    compareTo: trimmed(search.get("compareTo")),
  };
}

export function isWritingSection(search: URLSearchParams): boolean {
  return parseWritingSearch(search).section === WRITING_SECTION;
}

/** 构造作文规范 URL（只输出非空参数；顺序稳定便于测试与深链复用）。 */
export function buildWritingUrl(parts: {
  taskId?: string | null;
  sheetId?: string | null;
  compareTo?: string | null;
}): string {
  const search = new URLSearchParams();
  search.set("section", WRITING_SECTION);
  if (parts.taskId) search.set("writingTaskId", parts.taskId);
  if (parts.sheetId) search.set("sheet", parts.sheetId);
  if (parts.compareTo) search.set("compareTo", parts.compareTo);
  return `/l3?${search.toString()}`;
}

/** 形式/方向展示标签（列表与编辑页共用；中文文案单一真源）。 */
export const WRITING_KIND_LABELS: Record<string, string> = {
  whole: "整篇写作",
  paragraph: "段落专项",
  free: "自由写作",
};

export function writingKindLabel(kind: string): string {
  return WRITING_KIND_LABELS[kind] ?? kind;
}

/** 编辑器 textarea 的稳定 DOM id（反馈面板定位跳转与编辑器共用，防漂移）。 */
export const WRITING_TEXTAREA_ID = "writing-draft-textarea";

/** 保存状态 → 用户文案（六态诚实显示；W2 体验锚点）。 */
export const SAVE_STATE_LABELS: Record<string, string> = {  clean: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  retrying: "保存中…（自动重试）",
  error: "保存失败",
  conflict: "版本冲突",
};

export function saveStateLabel(state: string): string {
  return SAVE_STATE_LABELS[state] ?? state;
}

/** 稿次展示标签（第 n 稿 / 草稿 / 已丢弃草稿）。 */
export function revisionLabel(sheet: { status: string; revisionNo: number | null }): string {
  if (sheet.status === "sealed" && sheet.revisionNo != null) return `第 ${sheet.revisionNo} 稿`;
  if (sheet.status === "discarded") return "已丢弃草稿";
  return "草稿";
}
