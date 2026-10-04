/**
 * L3 卷面正文的空号占位解析（**单一定义源**，2026-10-04）。
 *
 * 为什么要有这个模块：`〖n〗` 是卷面**数据编码**（"第 n 空"），不是句子内容。
 * L3 阅读视图自 2026-09-16 起由 `examPassageSpans.buildPassageSpans` 正确解析，
 * 但 L1 复习卡把 `l3_contexts[].text` 直接渲染原文 ⇒ 空号原样泄漏给用户
 * （实测：`abundant` 卡背显示 `〖45〗 When pitching a new idea…`）。
 *
 * 两处必须共用同一份正则，否则解析口径又会漂移 —— 这与
 * `word-exam.parseSplitSegments`（`[]`/`｜` 编码只在契约层解析一次）是同一条纪律。
 */

/**
 * 空号占位符（卷面原文形如 `〖45〗`）。
 *
 * ⚠️ 带 `g` 标志的正则有 `lastIndex` 状态：**不要**在本模块之外直接复用同一个
 * 实例做循环匹配，请用 `segmentPassageBlanks` / `createPassageBlankRe`。
 */
export const PASSAGE_BLANK_RE = /〖(\d+)〗/g;

/** 新建一个 `g` 标志的空号正则（避免共享实例的 lastIndex 互相污染）。 */
export function createPassageBlankRe(): RegExp {
  return new RegExp(PASSAGE_BLANK_RE.source, "g");
}

export interface PassageBlankSegment {
  kind: "text" | "blank";
  /** 原文切片；`kind === "blank"` 时为占位符本身（`〖45〗`）。 */
  text: string;
  /** 仅 `kind === "blank"` 出现：空号数字。 */
  blankNo?: number;
}

/**
 * 把含 `〖n〗` 的正文切成 `text`/`blank` 交替的段序列。
 *
 * 不丢字符保证：`segments.map(s => s.text).join("") === 原文`（渲染层据此
 * 保证"解析"不会吞掉句子内容）。不含占位符时返回单个 text 段。
 */
export function segmentPassageBlanks(text: string): PassageBlankSegment[] {
  const segments: PassageBlankSegment[] = [];
  const re = createPassageBlankRe();
  let cursor = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const start = match.index;
    if (start == null) continue;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: "blank", text: match[0], blankNo: Number(match[1]) });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** 正文是否含空号占位（渲染层用来决定是否走分段路径）。 */
export function hasPassageBlank(text: string): boolean {
  return new RegExp(PASSAGE_BLANK_RE.source).test(text);
}
