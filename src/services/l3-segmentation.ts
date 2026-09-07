// src/services/l3-segmentation.ts
/**
 * 轻量分句（历史 l3-segmentation-research 结论：句末符扫描，MVP 不引重模型）。
 * 偏移为 UTF-16 码元，与计划文档「坐标空间约定」一致。
 */

export interface SentenceSegment {
  text: string;
  start: number;
  end: number;
}

const TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "；", ";"]);
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
  "e.g", "i.e", "fig", "no", "approx", "dept", "est", "al",
]);
const TRAILERS = new Set(['"', "'", "”", "’", "）", ")", "」", "』"]);

function isLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}

/** 从 end-1 反向收集以句点连接的缩写词（如 "e.g" / "Mr"）。 */
function wordBeforeDot(text: string, dotIndex: number): string {
  let i = dotIndex - 1;
  let word = "";
  while (i >= 0 && (isLetter(text[i]) || text[i] === ".")) {
    word = text[i] + word;
    i -= 1;
    // 已越过上一个句子边界词首则停
    if (word.length > 12) break;
  }
  return word.toLowerCase();
}

export function splitSentences(text: string): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!TERMINATORS.has(ch)) continue;

    // 小数守卫：digit.digit
    if (ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
    // 缩写守卫：xxx. 且 terminator 为 "."
    if (ch === "." && ABBREVIATIONS.has(wordBeforeDot(text, i))) continue;
    // 续行守卫：句点后紧跟小写字母（如 "e.g. this" 已被缩写表覆盖，此处兜底）
    let j = i + 1;
    while (j < text.length && text[j] === " ") j += 1;
    if (ch === "." && isLetter(text[j] ?? "") && text[j] === text[j]?.toLowerCase() && !ABBREVIATIONS.has(wordBeforeDot(text, i))) {
      // 允许极少数误判：仅当句点前是完整短词且后接小写时按缩写处理
      continue;
    }
    // 携带尾随引号/括号
    let end = i + 1;
    while (end < text.length && TRAILERS.has(text[end])) end += 1;

    segments.push({ text: text.slice(start, end), start, end });
    start = end;
    i = end - 1;
  }
  if (start < text.length) {
    segments.push({ text: text.slice(start), start, end: text.length });
  }
  return segments.filter((s) => s.text.trim().length > 0);
}

/** 圈记整句分支：把选中区间 [selStart, selEnd) 扩展为包含它的句子区间。 */
export function findSentenceRange(text: string, selStart: number, selEnd: number): SentenceSegment {
  const segs = splitSentences(text);
  const hit = segs.find((s) => s.start <= selStart && s.end >= selEnd);
  if (hit) return hit;
  // 兜底：跨句选中 → 取覆盖选择起点的段落级范围（首尾句）
  const first = segs.find((s) => s.end > selStart) ?? segs[0];
  const last = [...segs].reverse().find((s) => s.start < selEnd) ?? segs[segs.length - 1];
  return { text: text.slice(first.start, last.end), start: first.start, end: last.end };
}
