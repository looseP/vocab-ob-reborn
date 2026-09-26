/**
 * 卷面文栏三通道分片纯函数（批次一，2026-09-16）。
 *
 * 把 content（含〖n〗空位占位）切成不重叠的连续 span 序列，四个标注通道：
 *   - blank：〖n〗 空位角标（仅展示 + 跳题，不可划词）
 *   - evidence：官方标准答案锚点，仅解析模式渲染（实心底）
 *   - mark：用户「划重点」轻痕迹（v2 §4.6，纯底色，无角标无交互消费）
 *   - annotation：用户做题注记锚点（下划线/描边，全程可见）
 * 坐标一律为 content 字符串的 UTF-16 偏移（含〖n〗占位字符），与
 * l3_questions.evidence / l3_question_annotations 锚点同一坐标系。
 * 重叠优先级：blank > evidence > mark > annotation；越界/倒挂锚点直接丢弃。
 * （mark 高于 annotation：marks 无角标等旁路出口，被吞等于不可见；注记另有
 *   题卡角标与原文分析列表兜底。evidence 高于 mark：解析模式官方定位优先。）
 */

export const PASSAGE_BLANK_RE = /〖(\d+)〗/g;

export type PassageSpanKind = "text" | "blank" | "evidence" | "mark" | "annotation";

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
  /** v2 §4.6：passage 划重点标记（纯底色通道）。 */
  marks?: ReadonlyArray<{ start: number; end: number }>;
  /** 官方 evidence 仅在解析（核对答案）模式显示。 */
  showEvidence?: boolean;
  /** 是否解析 〖n〗 空位（题干等非材料文本传 false，保持原样文本）。 */
  parseBlanks?: boolean;
}

interface Owner {
  priority: number;
  kind: PassageSpanKind;
  blankNo?: number;
  annotationId?: string;
}

const PRIORITY = { annotation: 1, mark: 2, evidence: 3, blank: 4 } as const;

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

  if (options.parseBlanks !== false) {
    for (const match of content.matchAll(new RegExp(PASSAGE_BLANK_RE.source, "g"))) {
      const start = match.index;
      if (start == null) continue;
      const end = start + match[0].length;
      paint(start, end, { priority: PRIORITY.blank, kind: "blank", blankNo: Number(match[1]) });
    }
  }

  if (options.showEvidence) {
    for (const marker of options.evidence ?? []) {
      paint(marker.start, marker.end, { priority: PRIORITY.evidence, kind: "evidence" });
    }
  }

  for (const mark of options.marks ?? []) {
    paint(mark.start, mark.end, { priority: PRIORITY.mark, kind: "mark" });
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
 * 取包含 [start,end) 选区的**最小句段范围**（2026-09-26）。
 * 向两侧扩展到最近句读/换行；右侧把句读标点一并纳入。找不到边界时退化为选区本身。
 *
 * 为什么要有 range 版：`enclosingSentence` 只给文本，而「官方证据」锚点要的是
 * **content 的 UTF-16 区间**。两件事共用同一套扩展逻辑 —— 拆成两个实现必然漂移
 * （圈词入笔记取到的句子与证据锚点标到的句子会不一致）。
 * 返回的区间已 trim 过（不含首尾空白），因此可直接作为 evidence.start/end。
 */
export function enclosingSentenceRange(
  content: string,
  start: number,
  end: number,
): { start: number; end: number } {
  if (start < 0 || end > content.length || end <= start) {
    const s = Math.max(0, Math.min(start, content.length));
    const e = Math.max(s, Math.min(end, content.length));
    return { start: s, end: e };
  }
  let s = start;
  while (s > 0 && !SENTENCE_BOUNDARY_RE.test(content[s - 1]!)) s -= 1;
  let e = end;
  while (e < content.length && !SENTENCE_BOUNDARY_RE.test(content[e]!)) e += 1;
  if (e < content.length && /[。！？!?]/.test(content[e]!)) e += 1;
  // trim：把句段首尾空白排除在锚点外（否则锚点会带上换行/缩进，标注高亮会溢出到行首）
  const raw = content.slice(s, e);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { start, end };
  return { start: s + leading, end: s + raw.length - trailing };
}

/**
 * 取包含 [start,end) 选区的最小句段文本（圈词入笔记 capture 的 text 字段）。
 * 语义 = `enclosingSentenceRange` 的区间切片（单一实现，见上）。
 */
export function enclosingSentence(content: string, start: number, end: number): string {
  const range = enclosingSentenceRange(content, start, end);
  return content.slice(range.start, range.end) || content.slice(start, end);
}

/** 段内渲染片段：坐标仍是 content 全局 UTF-16 偏移（换行符不属于任何 run）。 */
export interface PassageRun {
  start: number;
  end: number;
  kind: PassageSpanKind;
  text: string;
  blankNo?: number;
  annotationId?: string;
}

export interface PassageParagraph {
  /** 该段全部片段（空位角标为无文本 run；其余 run.text 不含换行符）。 */
  runs: PassageRun[];
  /** 空段（对应 \n\n 之间的空行，渲染为占位高度以保留段落间距）。 */
  blank: boolean;
}

/**
 * 把连续 span 序列按 content 中的 \n 切成段落组。
 * 换行符不生成文本 run——每个 run 携带全局 content 偏移，因此拆段不影响
 * 选区偏移映射；跨段标注（mark 内含 \n）被切成同 annotationId 的多个 run。
 */
export function groupSpansIntoParagraphs(spans: readonly PassageSpan[], content: string): PassageParagraph[] {
  const paragraphs: PassageParagraph[] = [];
  let runs: PassageRun[] = [];
  const breakParagraph = () => {
    paragraphs.push({ runs, blank: runs.length === 0 });
    runs = [];
  };

  for (const span of spans) {
    if (span.kind === "blank") {
      runs.push({ start: span.start, end: span.end, kind: "blank", text: "", blankNo: span.blankNo });
      continue;
    }
    const raw = content.slice(span.start, span.end);
    let cursor = span.start;
    const lines = raw.split("\n");
    lines.forEach((line, index) => {
      if (line.length > 0) {
        const run: PassageRun = { start: cursor, end: cursor + line.length, kind: span.kind, text: line };
        if (span.annotationId) run.annotationId = span.annotationId;
        runs.push(run);
      }
      cursor += line.length;
      if (index < lines.length - 1) {
        breakParagraph();
        cursor += 1; // 消费该段末尾的 \n（其偏移不属于任何 run）
      }
    });
  }
  breakParagraph();
  return paragraphs;
}
