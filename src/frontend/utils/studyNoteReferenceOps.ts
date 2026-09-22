/**
 * Task 09A · 引用正文操作域工具（纯文本、零 IO、不依赖 React）。
 *
 * 定位语义（与 domain `parseReferenceIds` **同一真源**）：marker `[[ref:<uuid>]]` 必须
 * **独占顶层 paragraph token**。删除/替换作用于该 token 的**原始区间**（`token.raw`），
 * 因此围栏代码 / 缩进代码 / 列表 / 引用块 / 行内同形文本一律不被波及；非目标正文逐字保留。
 *
 * - 插入：在光标处拆段并补齐段边界空行；随后用真实 lexer 复核候选正文里新 marker
 *   确实是独立顶层段落。光标落在无法安全插入的容器（代码块/列表/引用块/表格/HTML/标题）
 *   内 → 显式抛 `ReferenceMarkerPositionError`，调用方给出可见反馈且**本地状态完全不变**；
 * - 删除/转换：顶层 marker 不存在时显式抛 `ReferenceContractError`——调用方需同步维护
 *   references 集合，静默成功会制造 marker/清单分叉；
 * - 所有产物应能通过 `assertReferenceSet`（调用方在同一 patch 内同步 writes）。
 */
import { lexer, type Token } from "marked";
import type { ReferencePreview } from "@/domain/l3-study-notes";
import { matchReferenceMarkerText, ReferenceContractError } from "@/domain/l3-study-notes";

const markerText = (refId: string): string => `[[ref:${refId.toLowerCase()}]]`;

/**
 * 插入位置不安全（光标落在代码块/列表/引用块等容器内，或落在既有引用标记段落内）。
 * **不降级为「先写入再等预检报错」**：拒绝时不产生任何正文变更。
 */
export class ReferenceMarkerPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceMarkerPositionError";
  }
}

// ── 顶层 marker 定位（单真源语义）────────────────────────────────────────────

/** 顶层段落且 text 完全等于合法 marker → 命中（与 parseReferenceIds 同一判定）。 */
function matchTopLevelMarker(token: Token, refId: string): boolean {
  if (token.type !== "paragraph") return false;
  const text = (token as { text?: unknown }).text;
  if (typeof text !== "string") return false;
  const match = matchReferenceMarkerText(text);
  return match.kind === "marker" && match.refId === refId.toLowerCase();
}

/**
 * 真实顶层 marker 的原始区间：用 token.raw 在原文中**按序**推进定位（不用 indexOf 猜，
 * 避免同名文本出现在代码块里时定位到错误的字符偏移）。
 */
function locateMarkerRange(body: string, refId: string): { start: number; end: number } | null {
  let cursor = 0;
  for (const token of lexer(body)) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (raw.length === 0) continue;
    if (raw === body.slice(cursor, cursor + raw.length) && matchTopLevelMarker(token, refId)) {
      return { start: cursor, end: cursor + raw.length };
    }
    cursor += raw.length;
  }
  return null;
}

// ── 插入 ────────────────────────────────────────────────────────────────────

/** 不可安全插入的顶层 token（容器内部：插入会被容器吞掉或破坏文档结构）。 */
const CONTAINER_TOKEN_TYPES = new Set(["code", "list", "blockquote", "table", "html", "heading", "hr"]);

function describeTokenType(type: string): string {
  switch (type) {
    case "code":
      return "代码块";
    case "list":
      return "列表";
    case "blockquote":
      return "引用块";
    case "table":
      return "表格";
    case "html":
      return "HTML 块";
    case "heading":
      return "标题";
    default:
      return "该区块";
  }
}

/** 顶层段落是否为（合法或非法形状的）引用标记段落。 */
function isMarkerParagraph(token: Token): boolean {
  if (token.type !== "paragraph") return false;
  const text = (token as { text?: unknown }).text;
  if (typeof text !== "string") return false;
  return matchReferenceMarkerText(text).kind !== "none";
}

/**
 * 候选正文中 refId 是否恰为**独立顶层段落**（真实 lexer 复核，不做逐行/形状猜测）。
 *
 * 仅凭「存在一个 paragraph 的 text 等于标记」不足：marked 会把同一段落中的两枚标记
 * 合并为一个 paragraph（其 text 含换行，形状匹配即失败）。因此同时要求：全文中恰有
 * 一个该 refId 的独立段落，且任何包含该标记字面量的段落都必须是合法独立标记。
 */
function isStandaloneTopLevelMarker(body: string, refId: string): boolean {
  const shape = markerText(refId);
  let hits = 0;
  for (const token of lexer(body)) {
    if (token.type !== "paragraph") continue;
    const text = (token as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    if (matchTopLevelMarker(token, refId)) hits += 1;
    if (text.includes(shape) && matchReferenceMarkerText(text).kind !== "marker") return false;
  }
  return hits === 1;
}

/**
 * 计算「光标处插入独立顶层 marker」的结果。
 *
 * 规则（保持既有光标语义：在光标处切开正文，仅补齐段边界空行）：
 * - 光标落在**顶层段落**文本内 → 就地拆段（前后各补空行），得到独立顶层 marker；
 * - 光标落在不可安全插入的容器（代码块/列表/引用块/表格/HTML 块/标题）内 → 抛
 *   `ReferenceMarkerPositionError`（调用方给出可见反馈并保持正文完全不变）；
 * - 光标落在既有引用标记段落内部 → 抛错（标记必须独占段落）；
 * - 结果无法构成「独立顶层段落」（如与相邻标记连成同一段落）→ 抛错。
 */
export function insertReferenceMarker(bodyMd: string, refId: string, cursor: number | null): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const marker = markerText(refId);
  const at = cursor === null || !Number.isFinite(cursor) ? body.length : Math.max(0, Math.min(body.length, cursor));

  // 找到覆盖光标的顶层 token（raw 区间含尾随换行）。
  let offset = 0;
  let covering: Token | null = null;
  for (const token of lexer(body)) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    const start = offset;
    const end = offset + raw.length;
    offset = end;
    if (at > start && at <= end) {
      covering = token;
      break;
    }
  }

  if (covering && CONTAINER_TOKEN_TYPES.has(covering.type)) {
    throw new ReferenceMarkerPositionError(
      `无法在${describeTokenType(covering.type)}内部插入引用：引用标记必须是独立段落。请把光标移到正文段落中，或移到该${describeTokenType(covering.type)}之外。`,
    );
  }
  if (covering && isMarkerParagraph(covering)) {
    throw new ReferenceMarkerPositionError(
      "无法在已有引用标记内部插入新引用：引用标记必须独占段落。请把光标放到其他正文段落。",
    );
  }

  const prefix = body.slice(0, at);
  const suffix = body.slice(at);
  if (prefix === "" && suffix === "") return marker;
  const newline = "\n";
  const gap = newline + newline;
  const before = prefix === "" || prefix.endsWith(gap) ? "" : prefix.endsWith(newline) ? newline : gap;
  const after = suffix === "" || suffix.startsWith(gap) ? "" : suffix.startsWith(newline) ? newline : gap;
  const candidate = prefix + before + marker + after + suffix;

  // 真实语义复核：候选里新 marker 必须恰为独立顶层段落（不满足则拒绝，不改动任何状态）。
  if (!isStandaloneTopLevelMarker(candidate, refId)) {
    throw new ReferenceMarkerPositionError(
      "无法在此处插入引用标记：插入后会与相邻的引用标记落在同一段落。请把光标放到其他正文段落。",
    );
  }
  return candidate;
}

// ── 删除 / 转换 ─────────────────────────────────────────────────────────────

/**
 * 删除目标引用标记（仅其顶层段落原始区间）；其他正文逐字保留。
 *
 * 空行整理（与既有交付行为一致）：标记独占段落时，删除它会留下两段之间的空行；
 * 只清理**一侧**——优先删标记后的空行（文首/中间），文末则删标记前的空行——
 * 不吞掉两侧空行（那会把相邻块粘连成一个段落）。
 *
 * 顶层 marker 不存在 → 显式报错。
 */
export function removeReferenceMarker(bodyMd: string, refId: string): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const range = locateMarkerRange(body, refId);
  if (!range) throw new ReferenceContractError("引用标记不存在（无法移除引用）");

  let start = range.start;
  let end = range.end;
  while (end < body.length && body[end] === "\n") end += 1; // 先试：消费标记后的换行
  let afterTrimmed = end;
  while (afterTrimmed < body.length && body[afterTrimmed] === "\n") afterTrimmed += 1;
  if (afterTrimmed >= body.length) {
    // 文末标记：后面已无内容 → 改为消费标记前的换行（保持段落整齐）
    let beforeTrimmed = start;
    while (beforeTrimmed > 0 && body[beforeTrimmed - 1] === "\n") beforeTrimmed -= 1;
    start = beforeTrimmed;
    end = range.end;
  }
  return body.slice(0, start) + body.slice(end);
}

/**
 * 将目标引用标记替换为普通摘录行（转换：保留独立摘录 + 调用方同次移除 reference）。
 * 仅替换其顶层段落原始区间；顶层 marker 不存在 → 显式报错。
 */
export function replaceMarkerWithExcerpt(bodyMd: string, refId: string, excerptLines: readonly string[]): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const range = locateMarkerRange(body, refId);
  if (!range) throw new ReferenceContractError("引用标记不存在（无法转为普通摘录）");
  return body.slice(0, range.start) + excerptLines.join("\n") + body.slice(range.end);
}

// ── 摘录文案 ────────────────────────────────────────────────────────────────

/** 多行文本 → Markdown 引用块行（首行「、末行」包裹）。 */
function quoteBlockLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length === 1) return [`> 「${parts[0]}」`];
  return parts.map((line, index) => {
    if (index === 0) return `> 「${line}`;
    if (index === parts.length - 1) return `> ${line}」`;
    return `> ${line}`;
  });
}

/** 题干等多行纯文本 → 引用块行（无引号包裹）。 */
function blockLines(text: string): string[] {
  return text.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">"));
}

/**
 * 从引用元数据生成「普通摘录」行（转换操作使用）。
 * 口径：文本行 + 出处行（题型/选项号/来源标题等来源描述）。
 */
export function excerptLinesFromSnapshot(meta: ReferencePreview): string[] {
  const snapshot = meta.displaySnapshot;
  const sourceSuffix = (sourceTitle: string | null): string => (sourceTitle ? `· ${sourceTitle}` : "");
  switch (snapshot.kind) {
    case "source":
      return [`> 「${snapshot.title}」`, "> —— 来源"];
    case "source_quote":
      return [...quoteBlockLines(snapshot.quote), `> —— ${snapshot.title}`];
    case "question":
      return [...blockLines(snapshot.stem), `> —— 题目（${snapshot.questionType}）${sourceSuffix(snapshot.sourceTitle)}`];
    case "stem_quote":
      return [
        ...quoteBlockLines(snapshot.quote),
        `> —— 题干摘录（${snapshot.questionType}）${sourceSuffix(snapshot.sourceTitle)}`,
      ];
    case "option_quote":
      return [
        ...quoteBlockLines(snapshot.quote),
        `> —— 选项 ${snapshot.optionKey}（${snapshot.questionType}）${sourceSuffix(snapshot.sourceTitle)}`,
      ];
  }
}
