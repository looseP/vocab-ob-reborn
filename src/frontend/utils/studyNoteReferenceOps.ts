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
import { GRADING_VERDICT_LABELS } from "@/domain/l3-grading";
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

// ── 解析坐标 → 原文坐标（单真源容器/区间规则）──────────────────────────────

/**
 * 正文的行分隔符模式：LF-only / CRLF-only / 混合（持久化正文不保证 LF-only）。
 * 仅用于**识别**，不用于把整篇正文归一化——归一化会改写非目标正文（逐字保留是硬约束）。
 */
function newlineMode(text: string): "lf" | "crlf" | "mixed" {
  const hasCrlf = text.includes("\r\n");
  if (!hasCrlf) return "lf";
  // 去掉所有 CRLF 后仍有 `\n`（或仍有裸 `\r`）→ 混合换行。
  const rest = text.split("\r\n").join("");
  return rest.includes("\n") || rest.includes("\r") ? "mixed" : "crlf";
}

/** 追加时使用的换行（保持既有产物风格：LF-only 文档用 LF，CRLF-only 文档用 CRLF）。 */
function insertionNewline(text: string): string {
  return newlineMode(text) === "crlf" ? "\r\n" : "\n";
}

/**
 * 顶层 token 的**原文区间**（半开区间）。marked 的 raw 是解析坐标，两个端点都映射回
 * 原文后长度可能不等（CRLF 正文每行多 1 个字符）。
 */
interface TokenExtent {
  token: Token;
  /** 原文坐标下的起始偏移（inclusive）。 */
  start: number;
  /** 原文坐标下的结束偏移（exclusive）。 */
  end: number;
}

/**
 * 把 lexer 的 token 流映射回**原文坐标**：每个顶层 token 得到其原文起止偏移
 * （`start` 含 inclusive，`end` 为 exclusive；原文长度可大于 `token.raw.length`）。
 *
 * marked 会把 `\r\n`/`\r` 归一为 `\n` 再产出 `token.raw`，因此 `token.raw.length`
 * 不是原文推进量（CRLF 正文里每行少算 1 个字符）——旧实现按 raw 长度累加，导致
 * CRLF 正文中的顶层 marker 永远定位不到。此处改为**逐行对齐**：
 * - `token.raw` 与原文按行一一对应，行分隔符形态不同不算不匹配（CRLF/CR/LF 等价）；
 * - 行内容不同 → 拒绝该容器（返回 null），退化为「不识别该容器」，绝不猜偏移；
 * - 映射量超出原文（词法层消费量超过文本）→ 拒绝。
 */
function mapTokensToSource(body: string, tokens: readonly Token[]): TokenExtent[] | null {
  const mapped: TokenExtent[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (raw.length === 0) continue;
    const start = cursor;
    if (body.slice(cursor, cursor + raw.length) === raw) {
      // 快路径：字面量逐字相等 → 原文区间就是该长度。
      cursor += raw.length;
    } else {
      // 逐行对齐：行内容必须逐行相等，仅行分隔符形态可不同。
      const rawLines = raw.split("\n");
      for (let index = 0; index < rawLines.length; index += 1) {
        const line = rawLines[index];
        if (line.length > 0 && !body.startsWith(line, cursor)) return null;
        cursor += line.length;
        if (index < rawLines.length - 1) {
          if (body.startsWith("\r\n", cursor)) cursor += 2;
          else if (body.startsWith("\n", cursor) || body.startsWith("\r", cursor)) cursor += 1;
          else return null;
        }
      }
    }
    mapped.push({ token, start, end: cursor });
  }
  return cursor <= body.length ? mapped : null;
}

// ── 顶层 marker 定位（单真源语义）────────────────────────────────────────────

/** 偏移是否落在行的起点（文首，或行分隔符 `\n`/`\r` 之后）。 */
function isAtLineStart(body: string, offset: number): boolean {
  return offset === 0 || body[offset - 1] === "\n" || body[offset - 1] === "\r";
}

/** 顶层段落且 text 完全等于合法 marker → 命中（与 parseReferenceIds 同一判定）。 */
function matchTopLevelMarker(token: Token, refId: string): boolean {
  if (token.type !== "paragraph") return false;
  const text = (token as { text?: unknown }).text;
  if (typeof text !== "string") return false;
  const match = matchReferenceMarkerText(text);
  return match.kind === "marker" && match.refId === refId.toLowerCase();
}

/**
 * 真实顶层 marker 的原始区间：先按序映射到原文坐标，再返回该 token 的原文区间
 * （不用 indexOf 猜，避免同名文本出现在代码块里时定位到错误的字符偏移）。
 * 无法逐字对齐（词法层与原文不一致）时返回 null。
 */
function locateMarkerRange(body: string, refId: string): { start: number; end: number } | null {
  const mapped = mapTokensToSource(body, lexer(body));
  if (!mapped) return null;
  for (const current of mapped) {
    if (!matchTopLevelMarker(current.token, refId)) continue;
    // 标记段落必须同时是独立行：起点只能是文首或行分隔符（\n / \r）之后，否则说明
    // 该「标记段落」实际上是上一行（如前一行是链接定义时 marked 会把定义行吞进 raw）。
    if (!isAtLineStart(body, current.start)) continue;
    return { start: current.start, end: current.end };
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
 *
 * 与删除/转换**共用同一套容器位置规则**（`mapTokensToSource` 的原文区间 + 半开
 * `(start, end]` 的「尾部换行归属前一个 token」口径），因此 CRLF/CR/混合换行的
 * 正文里容器判定同样准确。
 */
export function insertReferenceMarker(bodyMd: string, refId: string, cursor: number | null): string {
  const body = typeof bodyMd === "string" ? bodyMd : "";
  const marker = markerText(refId);
  const at = cursor === null || !Number.isFinite(cursor) ? body.length : Math.max(0, Math.min(body.length, cursor));

  const mapped = mapTokensToSource(body, lexer(body));
  if (!mapped) {
    throw new ReferenceMarkerPositionError(
      "无法解析当前正文的块结构，已在原处取消插入（正文未改动）。请检查正文中的换行。",
    );
  }

  // 找到覆盖光标的顶层 token（与删除/转换**同一套原文区间规则**：区间为
  // `(start, end]`，即每个 token 的原文区间含其尾随换行；光标落在块间空行上时
  // 归前一个 token，与旧实现的光标语义一致，但坐标来自原文映射而非 raw 长度）。
  let covering: TokenExtent | null = null;
  for (let index = 0; index < mapped.length; index += 1) {
    const current = mapped[index];
    const end = index + 1 < mapped.length ? mapped[index + 1].start : body.length;
    if (at > current.start && at <= end) {
      covering = current;
      break;
    }
  }

  if (covering && CONTAINER_TOKEN_TYPES.has(covering.token.type)) {
    const described = describeTokenType(covering.token.type);
    throw new ReferenceMarkerPositionError(
      `无法在${described}内部插入引用：引用标记必须是独立段落。请把光标移到正文段落中，或移到该${described}之外。`,
    );
  }
  if (covering && isMarkerParagraph(covering.token)) {
    throw new ReferenceMarkerPositionError(
      "无法在已有引用标记内部插入新引用：引用标记必须独占段落。请把光标放到其他正文段落。",
    );
  }

  const prefix = body.slice(0, at);
  const suffix = body.slice(at);
  if (prefix === "" && suffix === "") return marker;
  const newline = insertionNewline(body);
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
  // 换行按「整行分隔符」消费：CRLF 正文里吞掉 `\r` 会留下孤立 `\n`（正文被改写）。
  const isLineBreak = (ch: string): boolean => ch === "\n" || ch === "\r";
  const eatLineBreak = (offset: number): number => {
    if (body.startsWith("\r\n", offset)) return offset + 2;
    return isLineBreak(body[offset]) ? offset + 1 : offset;
  };
  while (end < body.length && isLineBreak(body[end])) end = eatLineBreak(end); // 先试：消费标记后的换行
  let afterTrimmed = end;
  while (afterTrimmed < body.length && isLineBreak(body[afterTrimmed])) afterTrimmed = eatLineBreak(afterTrimmed);
  if (afterTrimmed >= body.length) {
    // 文末标记：后面已无内容 → 改为消费标记前的换行（保持段落整齐）
    let beforeTrimmed = start;
    while (beforeTrimmed > 0 && isLineBreak(body[beforeTrimmed - 1])) {
      beforeTrimmed -= body[beforeTrimmed - 1] === "\n" && beforeTrimmed > 1 && body[beforeTrimmed - 2] === "\r" ? 2 : 1;
    }
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
/**
 * verdict 中文短标签（fail-closed）：快照里的 `verdict` 是**冻结数据**，类型是
 * `string` 而非枚举 —— 契约漂移时宁可回显原始值，也不让一个未知判定被硬套成
 * 某个已知标签（那是把「读不懂」伪装成「读得懂」）。
 */
function verdictLabel(verdict: string): string {
  return GRADING_VERDICT_LABELS[verdict as keyof typeof GRADING_VERDICT_LABELS] ?? verdict;
}

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
    // N2：评析转普通摘录——落的是引用当时的摘录（快照不可变，D3-2）。
    case "assessment":
      return [
        ...blockLines(snapshot.excerpt),
        `> —— 评析（${snapshot.questionType}）${sourceSuffix(snapshot.sourceTitle)}`,
      ];
    // N2 第二条链：笔记互链转普通摘录——只落标题与引用当时摘录，不递归展开。
    case "note":
      return [...blockLines(snapshot.excerpt), `> —— 笔记「${snapshot.title}」`];
    // N2 第三条链：稿次转普通摘录——只落 scope + 小结摘录（不含 answers / 评卷）。
    case "sheet":
      return [...blockLines(snapshot.summaryExcerpt), `> —— 题纸稿次（${snapshot.scope}）`];
    // N2 第三条链：作答转普通摘录——只落 venue + 作答摘录。
    case "attempt":
      return [...blockLines(snapshot.answerExcerpt), `> —— 作答记录（${snapshot.venue}）`];
    // N2 第四条链（ADR-0039 决策 4/5）：带归属事实（谁在何时判的），且 verdict 用中文
    // 标签而非裸枚举值 —— 裸 "correct/partial/wrong" 出现在笔记里要读者自己翻译。
    case "grading":
      return [
        ...blockLines(snapshot.analysisExcerpt || `判定：${verdictLabel(snapshot.verdict)}`),
        `> —— 评卷（${verdictLabel(snapshot.verdict)}）${sourceSuffix(snapshot.sourceTitle)}`,
        `> ${snapshot.gradedBy} 评于 ${snapshot.gradedAt}`,
      ];
  }
}

// ── 导出 schema 版本选择（N2 / P4）───────────────────────────────────────────

/** N1 冻结的五种引用型（与服务端 `N1_REFERENCE_KINDS` 同口径）。 */
const N1_REFERENCE_KINDS = new Set<string>([
  "source", "source_quote", "question", "stem_quote", "option_quote",
]);

/**
 * 导出 schema 版本：**调用方显式选择**——服务端不做内容驱动的隐式升级。
 *
 * - 全是 N1 引用型 → `1`（v1 冻结面，旧客户端兼容）；
 * - 出现任何 N1 之外的引用型（N2+，当前为评析）→ `2`：v1 冻结面不接受，会被 422 拒绝。
 *   按「非白名单即 v2」判定，后续新增引用型无需再改这里。
 *
 * 判据取自引用**快照的 kind**（`displaySnapshot.kind`）——它与引用型一一对应，
 * 且是 UI 已在用的字段；不看 status（目标是否可用与协议版本无关）。
 */
export function exportSchemaVersionForReferences(references: readonly ReferencePreview[]): 1 | 2 {
  const hasN2 = references.some(
    (reference) => !N1_REFERENCE_KINDS.has(reference.displaySnapshot.kind),
  );
  return hasN2 ? 2 : 1;
}
