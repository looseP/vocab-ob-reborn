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
  /** A1：来源导航上下文（解析失败为 null）。 */
  origin: WritingOrigin | null;
  /** A1：origin 参数存在但被拒绝（用于「来源不可用」提示；不阻塞其余参数）。 */
  originInvalid: boolean;
}

export function parseWritingSearch(search: URLSearchParams): WritingLocation {
  const trimmed = (value: string | null): string | null => {
    if (value == null) return null;
    const next = value.trim();
    return next.length > 0 ? next : null;
  };
  const originRaw = trimmed(search.get(WRITING_ORIGIN_PARAM));
  const origin = originRaw !== null ? decodeWritingOrigin(originRaw) : null;
  return {
    section: trimmed(search.get("section")),
    taskId: trimmed(search.get("writingTaskId")),
    sheetId: trimmed(search.get("sheet")),
    compareTo: trimmed(search.get("compareTo")),
    origin,
    originInvalid: originRaw !== null && origin === null,
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
  origin?: WritingOrigin | null;
}): string {
  const search = new URLSearchParams();
  search.set("section", WRITING_SECTION);
  if (parts.taskId) search.set("writingTaskId", parts.taskId);
  if (parts.sheetId) search.set("sheet", parts.sheetId);
  if (parts.compareTo) search.set("compareTo", parts.compareTo);
  const encodedOrigin = parts.origin ? encodeWritingOrigin(parts.origin) : null;
  if (encodedOrigin !== null) search.set(WRITING_ORIGIN_PARAM, encodedOrigin);
  return `/l3?${search.toString()}`;
}

// ── A1/I1：来源导航上下文（origin v1——版本化判别联合，严格解析，限长）────────
//
// origin 只描述"本次从哪里进入"，服务端授权与数据关系另行校验（参数不推断权限）：
//   file  → 题型空间文件（fileKey 型或 source 型；至少其一）；paper → 试卷。
// 禁止任意 returnUrl / history.back / 仅内存 location.state；返回一律由
// buildWritingOriginReturnUrl 依来源生成站内 URL（消费方按 resumeSheet 读面）。

export const WRITING_ORIGIN_PARAM = "origin";
export const WRITING_ORIGIN_VERSION = 1;
export const WRITING_ORIGIN_MAX_LENGTH = 1024;
export const WRITING_ORIGIN_QUESTION_TYPES = ["short_essay", "long_essay"] as const;
export type WritingOriginQuestionType = (typeof WRITING_ORIGIN_QUESTION_TYPES)[number];

export type WritingOrigin =
  | {
      v: 1;
      kind: "file";
      questionId: string;
      questionType: WritingOriginQuestionType;
      fileKey: string | null;
      sourceId: string | null;
      /** 进入时所在的原卷/file 题纸（draft 恢复可编辑 / sealed 只读；可选）。 */
      sheetId: string | null;
    }
  | {
      v: 1;
      kind: "paper";
      questionId: string;
      questionType: WritingOriginQuestionType;
      paperId: string;
      sheetId: string | null;
    };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FILE_KEY_MAX_LENGTH = 200;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isOriginQuestionType(value: unknown): value is WritingOriginQuestionType {
  return typeof value === "string" && (WRITING_ORIGIN_QUESTION_TYPES as readonly string[]).includes(value);
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): string | null {
  try {
    const padded = token.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((token.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** origin → URL 参数值；结构不满足 v1 契约时返回 null（调用方不得传递半合法对象）。 */
export function encodeWritingOrigin(origin: WritingOrigin): string | null {
  if (origin.v !== WRITING_ORIGIN_VERSION) return null;
  if (!isUuid(origin.questionId) || !isOriginQuestionType(origin.questionType)) return null;
  const payload: Record<string, unknown> = {
    v: WRITING_ORIGIN_VERSION,
    k: origin.kind,
    q: origin.questionId,
    t: origin.questionType,
  };
  if (origin.kind === "file") {
    const fileKey = origin.fileKey;
    if (fileKey !== null && (typeof fileKey !== "string" || fileKey.length === 0 || fileKey.length > FILE_KEY_MAX_LENGTH)) return null;
    if (origin.sourceId !== null && !isUuid(origin.sourceId)) return null;
    if (fileKey === null && origin.sourceId === null) return null;
    if (fileKey !== null) payload.f = fileKey;
    if (origin.sourceId !== null) payload.s = origin.sourceId;
  } else {
    if (!isUuid(origin.paperId)) return null;
    payload.p = origin.paperId;
  }
  if (origin.sheetId !== null && !isUuid(origin.sheetId)) return null;
  if (origin.sheetId !== null) payload.sh = origin.sheetId;
  const encoded = toBase64Url(JSON.stringify(payload));
  return encoded.length <= WRITING_ORIGIN_MAX_LENGTH ? encoded : null;
}

/** URL 参数值 → origin（strict：限长、base64url 字符集、逐键白名单、UUID/枚举校验）。 */
export function decodeWritingOrigin(raw: string | null | undefined): WritingOrigin | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (token.length === 0 || token.length > WRITING_ORIGIN_MAX_LENGTH) return null;
  if (!BASE64URL_PATTERN.test(token)) return null;
  const json = fromBase64Url(token);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["v", "k", "q", "t", "f", "s", "p", "sh"]);
  for (const key of Object.keys(record)) if (!allowedKeys.has(key)) return null;
  if (record.v !== WRITING_ORIGIN_VERSION) return null;
  if (record.k !== "file" && record.k !== "paper") return null;
  if (!isUuid(record.q) || !isOriginQuestionType(record.t)) return null;
  const sheetId = record.sh === undefined ? null : record.sh;
  if (sheetId !== null && !isUuid(sheetId)) return null;
  if (record.k === "file") {
    if (record.p !== undefined) return null;
    const fileKey = record.f === undefined ? null : record.f;
    const sourceId = record.s === undefined ? null : record.s;
    if (fileKey !== null && (typeof fileKey !== "string" || fileKey.length === 0 || fileKey.length > FILE_KEY_MAX_LENGTH)) return null;
    if (sourceId !== null && !isUuid(sourceId)) return null;
    if (fileKey === null && sourceId === null) return null;
    return {
      v: 1,
      kind: "file",
      questionId: record.q,
      questionType: record.t,
      fileKey: fileKey as string | null,
      sourceId: sourceId as string | null,
      sheetId: sheetId as string | null,
    };
  }
  if (record.f !== undefined || record.s !== undefined) return null;
  if (!isUuid(record.p)) return null;
  return {
    v: 1,
    kind: "paper",
    questionId: record.q,
    questionType: record.t,
    paperId: record.p,
    sheetId: sheetId as string | null,
  };
}

/**
 * 返回原题 URL（按来源生成，禁止任意 returnUrl）：
 *  - file：/l3?venue=<题型>[&file=<fileKey>][&source=<sourceId>]
 *  - paper：/l3?paper=<paperId>
 *  附 `question=<questionId>` 供定位原题；进入时若有原 sheet → `resumeSheet=<sheetId>`
 *  （消费方按 ID 读面：draft 可编辑恢复 / sealed 只读；不得经 openSheet 另开新纸）。
 */
export function buildWritingOriginReturnUrl(origin: WritingOrigin): string {
  const search = new URLSearchParams();
  if (origin.kind === "file") {
    search.set("venue", origin.questionType);
    if (origin.fileKey) search.set("file", origin.fileKey);
    if (origin.sourceId) search.set("source", origin.sourceId);
  } else {
    search.set("paper", origin.paperId);
  }
  search.set("question", origin.questionId);
  if (origin.sheetId) search.set("resumeSheet", origin.sheetId);
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
