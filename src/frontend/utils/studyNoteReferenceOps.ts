/**
 * Task 09A · 引用正文操作域工具（纯文本、零 IO、不依赖 React）。
 *
 * 规则（与 domain 单真源一致）：
 *  - marker `[[ref:<uuid>]]` 必须**独占顶层段落** → 插入时保证前后空行边界；
 *  - 删除/转换按「行级定位 + 相邻空行整理」执行，**只动目标 marker**；
 *  - marker 缺失时显式抛 `ReferenceContractError`（不静默成功——调用方需
 *    同步维护 references 集合，静默会制造 marker/清单分叉）；
 *  - 所有产物应能通过 `assertReferenceSet`（调用方在同一 patch 内同步 writes）。
 */
import type { ReferencePreview } from "@/domain/l3-study-notes";
import { matchReferenceMarkerText, ReferenceContractError } from "@/domain/l3-study-notes";

const markerText = (refId: string): string => `[[ref:${refId.toLowerCase()}]]`;

const isBlank = (line: string): boolean => line.trim().length === 0;

/** 找到目标 marker 所在行号（大小写归一；仅识别独占段落的标记行）。 */
function findMarkerLine(lines: readonly string[], refId: string): number {
  const target = refId.toLowerCase();
  return lines.findIndex((line) => {
    const match = matchReferenceMarkerText(line.trim());
    return match.kind === "marker" && match.refId === target;
  });
}

/**
 * 在光标处插入引用标记（独立顶层段落；前后空行规范化；不重复补空行）。
 * `cursor` 为 null 或越界时追加到文末。
 */
export function insertReferenceMarker(bodyMd: string, refId: string, cursor: number | null): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const marker = markerText(refId);
  const at =
    cursor === null || !Number.isFinite(cursor)
      ? body.length
      : Math.max(0, Math.min(body.length, cursor));
  const prefix = body.slice(0, at);
  const suffix = body.slice(at);
  if (prefix === "" && suffix === "") return marker;
  if (suffix === "") {
    if (prefix.endsWith("\n\n")) return `${prefix}${marker}`;
    return `${prefix}${prefix.endsWith("\n") ? "\n" : "\n\n"}${marker}`;
  }
  if (prefix === "") {
    if (suffix.startsWith("\n\n")) return `${marker}${suffix}`;
    return `${marker}${suffix.startsWith("\n") ? "\n" : "\n\n"}${suffix}`;
  }
  const before = prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
  const after = suffix.startsWith("\n\n") ? "" : suffix.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${before}${marker}${after}${suffix}`;
}

/**
 * 删除目标引用标记行（含相邻空行整理，保持段落整齐）；其他内容不受影响。
 * marker 不存在 → 显式报错。
 */
export function removeReferenceMarker(bodyMd: string, refId: string): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const lines = body.split("\n");
  const index = findMarkerLine(lines, refId);
  if (index < 0) {
    throw new ReferenceContractError("引用标记不存在（无法移除引用）");
  }
  const next = [...lines];
  next.splice(index, 1);
  if (index === 0) {
    while (next.length > 0 && isBlank(next[0]!)) next.shift();
  } else if (index >= next.length) {
    while (next.length > 0 && isBlank(next[next.length - 1]!)) next.pop();
  } else if (isBlank(next[index]!) && isBlank(next[index - 1]!)) {
    next.splice(index, 1);
  }
  return next.join("\n");
}

/**
 * 将目标引用标记行替换为普通摘录行（转换操作：保留独立文字摘录 + 调用方同次移除 reference）。
 * marker 不存在 → 显式报错。
 */
export function replaceMarkerWithExcerpt(bodyMd: string, refId: string, excerptLines: readonly string[]): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const lines = body.split("\n");
  const index = findMarkerLine(lines, refId);
  if (index < 0) {
    throw new ReferenceContractError("引用标记不存在（无法转为普通摘录）");
  }
  const next = [...lines];
  next.splice(index, 1, ...excerptLines);
  return next.join("\n");
}

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
