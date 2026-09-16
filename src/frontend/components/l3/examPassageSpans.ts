/**
 * 卷面文栏三通道分片纯函数（批次一，2026-09-16）。
 *
 * 把 content（含〖n〗空位占位）切成不重叠的连续 span 序列，三个标注通道：
 *   - blank：〖n〗 空位角标（仅展示 + 跳题，不可划词）
 *   - evidence：官方标准答案锚点，仅解析模式渲染（实心底）
 *   - annotation：用户做题注记锚点（下划线/描边，全程可见）
 * 坐标一律为 content 字符串的 UTF-16 偏移（含〖n〗占位字符），与
 * l3_questions.evidence / l3_question_annotations 锚点同一坐标系。
 * 重叠优先级：blank > evidence > annotation；越界/倒挂锚点直接丢弃。
 */

export const PASSAGE_BLANK_RE = /〖(\d+)〗/g;

export type PassageSpanKind = "text" | "blank" | "evidence" | "annotation";

export interface PassageSpan {
  start: number;
  end: number;
  kind: PassageSpanKind;
  blankNo?: number;
  annotationId?: string;
}

export interface PassageAnnotationMarker {
  id: string;
  anchorStart: number | null;
  anchorEnd: number | null;
}

export interface PassageMarkerOptions {
  evidence?: ReadonlyArray<{ start: number; end: number }>;
  annotations?: ReadonlyArray<PassageAnnotationMarker>;
  /** 官方 evidence 仅在解析（核对答案）模式显示。 */
  showEvidence?: boolean;
}

interface Owner {
  priority: number;
  kind: PassageSpanKind;
  blankNo?: number;
  annotationId?: string;
}

const PRIORITY = { annotation: 1, evidence: 2, blank: 3 } as const;

function validRange(start: number, end: number, length: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= length;
}

export function buildPassageSpans(content: string, options: PassageMarkerOptions): PassageSpan[] {
  const length = content.length;
  const owners = new Array<Owner | null>(length).fill(null);

  const paint = (start: number, end: number, owner: Owner) => {
    if (!validRange(start, end, length)) return;
    for (let i = start; i < end; i += 1) {
      const current = owners[i];
      if (!current || owner.priority > current.priority) owners[i] = owner;
    }
  };

  for (const match of content.matchAll(new RegExp(PASSAGE_BLANK_RE.source, "g"))) {
    const start = match.index;
    if (start == null) continue;
    const end = start + match[0].length;
    paint(start, end, { priority: PRIORITY.blank, kind: "blank", blankNo: Number(match[1]) });
  }

  if (options.showEvidence) {
    for (const marker of options.evidence ?? []) {
      paint(marker.start, marker.end, { priority: PRIORITY.evidence, kind: "evidence" });
    }
  }

  for (const marker of options.annotations ?? []) {
    if (marker.anchorStart == null || marker.anchorEnd == null) continue;
    paint(marker.anchorStart, marker.anchorEnd, {
      priority: PRIORITY.annotation,
      kind: "annotation",
      annotationId: marker.id,
    });
  }

  // run-length 压缩：同 owner（同一标注实体）的相邻字符合并为一个 span。
  const spans: PassageSpan[] = [];
  let cursor = 0;
  while (cursor < length) {
    const owner = owners[cursor];
    if (!owner) {
      let end = cursor + 1;
      while (end < length && owners[end] === null) end += 1;
      spans.push({ start: cursor, end, kind: "text" });
      cursor = end;
      continue;
    }
    let end = cursor + 1;
    while (end < length && owners[end] === owner) end += 1;
    const span: PassageSpan = { start: cursor, end, kind: owner.kind };
    if (owner.blankNo != null) span.blankNo = owner.blankNo;
    if (owner.annotationId) span.annotationId = owner.annotationId;
    spans.push(span);
    cursor = end;
  }
  return spans;
}

const SENTENCE_BOUNDARY_RE = /[。！？!?\n]/;

/**
 * 取包含 [start,end) 选区的最小句段（圈词入笔记 capture 的 text 字段）：
 * 向两侧扩展到最近句读/换行；右侧把句读标点一并纳入。找不到任何边界时退化为选区本身。
 */
export function enclosingSentence(content: string, start: number, end: number): string {
  if (start < 0 || end > content.length || end <= start) return content.slice(start, end);
  let s = start;
  while (s > 0 && !SENTENCE_BOUNDARY_RE.test(content[s - 1]!)) s -= 1;
  let e = end;
  while (e < content.length && !SENTENCE_BOUNDARY_RE.test(content[e]!)) e += 1;
  if (e < content.length && /[。！？!?]/.test(content[e]!)) e += 1;
  return content.slice(s, e).trim() || content.slice(start, end);
}
