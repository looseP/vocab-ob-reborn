/**
 * L3 练习任务生成器（ADR-0019 §3 第一梯队题型）—— 纯函数、零出向、零 IO、零时间依赖。
 *
 * 只在内存里出题：不写 attempts、不碰调度（记录归 T06 的 l3_practice_attempts 服务；
 * "L3 有记录、无调度" 是红线 —— ADR-0004 §6 / ADR-0019 §1）。
 *
 * 题型：
 *   essay_dictation 作文句默写 —— 从 context 原句生成
 *     · cloze（默认）：目标词挖空；目标词定位来自 occurrence.surface，未命中退到 lemma
 *     · full        ：全句默写；无 occurrence 也能出，给"句中需用到 X"类提示
 *   context_quiz    语境义自测（记录版）—— 原句 + 隐藏 bound sense（判定数据即答案本身）
 *
 * 确定性与种子（参照 src/domain/l2-task.ts 的 deterministicTaskId / mulberry32 模式）：
 *   seed   = l3PracticeSeed(sessionId, contextId, attemptIndex)
 *   taskId = deterministicTaskId(practiceType, seed) = sha256(seed) 前 16 位（题型前缀）
 *   多出现位置时"挖哪一处"由 mulberry32(seed) 决定 —— 同种子恒同题，可幂等重放。
 *
 * 不可出题时返回 null（调用方跳过该 context；与 generateL2DiscriminationTask 的约定一致）：
 *   · context.text 为空/纯空白；
 *   · cloze 模式：无 occurrence，或 surface/lemma 在句中都定位不到（anchor drift）；
 *   · context_quiz：occurrence.boundSense 缺失或纯空白（见下方回退规则）。
 *
 * 回退规则（occurrence 无 boundSense）：CONTEXT.md 规定"空 bound sense 回退到词条当前
 * short_definition，且 UI 不做区分"。short_definition 不在本函数的入参里（生成器只认
 * context/occurrence 最小结构），所以回退由**装配层**负责：service 拉数据时先把
 * short_definition 作为 boundSense 传入；若仍为空，生成器视为"无判定数据"返回 null，
 * 不产出没有答案的伪题目（不静默损坏）。
 *
 * 展示文本上限：超长素材（长难句 / paragraph·excerpt 类 context）只保留目标词周围
 * MAX_PROMPT_TEXT_LENGTH 字符的窗口（截断处加 "…" 标记），避免"句子默写"退化成
 * "段落抄写"；窗口的 prompt 与 answer 严格同源，判分不会因截断失真。
 *
 * 出题阶段剥离：answer 是判定数据，HTTP 契约在作答前应剥离（参照 l2-task 的
 * stripAnswer 先例，由 http/契约层处理，本生成器不做传输层裁剪）。
 */

import { createHash } from "node:crypto";

/** L3 练习题型（ADR-0019 §3）。 */
export type L3PracticeType = "essay_dictation" | "context_quiz";

/** 作文句默写的两种模式（参数定）。 */
export type DictationMode = "cloze" | "full";

/** 默写判分规则标识（生成器只声明规则，判分在记录侧按同一规则执行）。 */
export type DictationNormalization = "nfkc_collapse_ws_lowercase";

/** 展示文本上限（字符数）；超出即窗口化。 */
export const MAX_PROMPT_TEXT_LENGTH = 160;

/** cloze 空位占位串（与 l2-task 的 cloze 标记一致）。 */
export const DICTATION_BLANK_MARKER = "____";

/** 默写判分规则标识值：NFKC 归一 → 折叠空白 → 去首尾 → 小写。 */
export const DICTATION_NORMALIZATION: DictationNormalization = "nfkc_collapse_ws_lowercase";

export interface L3PracticePrompt {
  /** 展示文本：cloze 已挖空；full / context_quiz 为原句（超长已窗口化）。 */
  text: string;
  /** 目标词面（cloze 的答案词 / context_quiz 的高亮锚点）；无 occurrence 时为 null。 */
  target: string | null;
  /** 空位在 text 中的字符下标（cloze 专用；其余为 null）。 */
  blankIndex: number | null;
  /** text 是否因超长被截断为窗口。 */
  truncated: boolean;
}

export interface L3PracticeAnswer {
  /** 参考答案：cloze/full = 期望文本（窗口内的原句）；context_quiz = 语境义快照。 */
  text: string;
  /** cloze 期望填入串（按原句大小写取匹配片段）；其余为 null。 */
  blankText: string | null;
  /** true = 默认隐藏、点击揭示（context_quiz 的 bound sense）。 */
  hidden: boolean;
  /** 判分归一规则（essay_dictation）；context_quiz 为 null（自评，无文本比对）。 */
  normalization: DictationNormalization | null;
}

/** 出题结果（判定数据在 answer；传输层作答前应剥离）。 */
export interface L3PracticeTask {
  taskId: string;
  practiceType: L3PracticeType;
  contextId: string;
  /** 目标 occurrence（essay_dictation 的全句模式可缺省；context_quiz 恒有）。 */
  occurrenceId?: string;
  prompt: L3PracticePrompt;
  answer: L3PracticeAnswer;
  /** 可按需展示的提示（作答前使用；不进入判定）。 */
  hints?: string[];
}

/** 生成器入参：只认最小结构，不依赖 db schema 类型。 */
export interface L3ContextInput {
  id: string;
  text: string;
}

export interface L3OccurrenceInput {
  id: string;
  /** 圈记时的词面（可能带屈折；优先用它定位）。 */
  surface: string;
  /** 词元（surface 在句中定位不到时的回退目标）。 */
  lemma?: string | null;
  /** 语境义快照（context_quiz 的判定数据；缺失时由装配层兜底，见文件头注释）。 */
  boundSense?: string | null;
}

export interface BuildEssayDictationInput {
  context: L3ContextInput;
  occurrence?: L3OccurrenceInput;
  /** 缺省：有 occurrence → cloze，无 occurrence → full。 */
  mode?: DictationMode;
  seed: string;
}

export interface BuildContextQuizInput {
  context: L3ContextInput;
  occurrence: L3OccurrenceInput;
  seed: string;
}

// ── 种子 / 确定性 ────────────────────────────────────────────────────────────

/** 组合确定性种子三元组：sessionId × contextId × attemptIndex。 */
export function l3PracticeSeed(sessionId: string, contextId: string, attemptIndex: number): string {
  return `${sessionId}:${contextId}:${attemptIndex}`;
}

/** 确定性 taskId：同种子恒同 id（sha256 前 16 位 + 题型前缀）。 */
export function deterministicTaskId(practiceType: L3PracticeType, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `${practiceType}:${hash}`;
}

function mulberry32(seed: Uint8Array): () => number {
  let a = 0;
  for (let i = 0; i < 4; i++) a = (a << 8) | seed[i]!;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 种子 PRNG（与 l2-task.taskPrng 同构）：同种子恒同序列。 */
export function l3PracticePrng(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  return mulberry32(digest.subarray(0, 8));
}

// ── 文本定位 / 窗口 ─────────────────────────────────────────────────────────

/** 与 L3 导入解析器（src/l3/import/parser.ts）一致的目标词边界字符。 */
const WORD_BOUNDARY_CHARS = /[\p{L}\p{N}_-]/u;

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !WORD_BOUNDARY_CHARS.test(text[index]);
}

interface MatchSpan {
  start: number;
  end: number;
  /** 句中的实际片段（保留原句大小写/屈折，即 cloze 的期望填入串）。 */
  text: string;
}

/** 目标串在句中的所有出现（大小写不敏感 + 词边界，避免 art 命中 party）。 */
function findMatches(text: string, target: string): MatchSpan[] {
  const matcher = new RegExp(escapeRegExp(target), "giu");
  const spans: MatchSpan[] = [];
  for (const match of text.matchAll(matcher)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isBoundary(text, start - 1) || !isBoundary(text, end)) continue;
    spans.push({ start, end, text: match[0] });
  }
  return spans;
}

interface LocatedTarget {
  /** 展示/挖空用的目标串（surface 优先；未命中退 lemma；都没有 = null）。 */
  value: string | null;
  /** 该串在句中的出现（空 = anchor drift：可出 full，不可出 cloze）。 */
  matches: MatchSpan[];
}

function locateTarget(text: string, occurrence: L3OccurrenceInput | undefined): LocatedTarget {
  if (!occurrence) return { value: null, matches: [] };
  const surface = nonEmpty(occurrence.surface);
  if (surface !== null) {
    const matches = findMatches(text, surface);
    if (matches.length > 0) return { value: surface, matches };
  }
  const lemma = nonEmpty(occurrence.lemma);
  if (lemma !== null) {
    const matches = findMatches(text, lemma);
    if (matches.length > 0) return { value: lemma, matches };
  }
  return { value: surface ?? lemma, matches: [] };
}

interface TextWindow {
  text: string;
  truncated: boolean;
  /** 窗口在原句中的起点（用于下标换算）。 */
  start: number;
  /** 前缀省略号长度（"…" = 1）。 */
  prefixLength: number;
}

/**
 * 超长文本窗口化：以目标词为中心取 MAX_PROMPT_TEXT_LENGTH 字符，
 * 保证目标词完整落在窗口内；两端有截断时加 "…"。
 */
function windowAround(text: string, focusStart: number, focusEnd: number): TextWindow {
  if (text.length <= MAX_PROMPT_TEXT_LENGTH) {
    return { text, truncated: false, start: 0, prefixLength: 0 };
  }
  const targetLength = focusEnd - focusStart;
  // 居中：目标词比窗口还长时（病态输入）左边界不外扩，右边界外扩，
  // 保证目标词完整落在窗口内（start ≤ focusStart < focusEnd ≤ end）。
  let start = Math.min(
    focusStart - Math.floor((MAX_PROMPT_TEXT_LENGTH - targetLength) / 2),
    focusStart,
  );
  if (start < 0) start = 0;
  const maxStart = text.length - MAX_PROMPT_TEXT_LENGTH;
  if (start > maxStart) start = maxStart;
  const end = Math.max(start + MAX_PROMPT_TEXT_LENGTH, focusEnd);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    // truncated = 真的有内容被切掉（病态长目标串可能恰好覆盖整段）。
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    truncated: prefix.length > 0 || suffix.length > 0,
    start,
    prefixLength: prefix.length,
  };
}

// ── 题型构建 ────────────────────────────────────────────────────────────────

/** 多出现位置 → 由种子 PRNG 选定挖空位；单次出现恒选它；无出现 = null。 */
function pickMatch(spans: MatchSpan[], seed: string): MatchSpan | null {
  if (spans.length === 0) return null;
  if (spans.length === 1) return spans[0];
  const rnd = l3PracticePrng(seed);
  return spans[Math.floor(rnd() * spans.length)];
}

/**
 * cloze 词形提示：保留每个词的首字母，其余字母替换为 _（空格原样保留）。
 * 入参恒为已 trim 的非空词面，split 后不会出现空 token。
 */
function surfaceHint(surface: string): string {
  return surface
    .split(/\s+/)
    .map((token) => `${token[0]}${"_".repeat(token.length - 1)}`)
    .join(" ");
}

/**
 * 作文句默写。
 * mode='cloze' 时把选定出现位置换成 DICTATION_BLANK_MARKER，answer.blankText 给出
 * 期望填入串；mode='full' 时不给空位、answer.text 即整句。
 */
export function buildEssayDictationTask(input: BuildEssayDictationInput): L3PracticeTask | null {
  const text = input.context.text;
  if (nonEmpty(text) === null) return null;

  const located = locateTarget(text, input.occurrence);
  const mode: DictationMode = input.mode ?? (located.value !== null ? "cloze" : "full");
  if (mode === "cloze" && located.value === null) return null;

  const chosen = mode === "cloze" ? pickMatch(located.matches, input.seed) : null;
  if (mode === "cloze" && chosen === null) return null;

  const window = windowAround(text, chosen?.start ?? 0, chosen?.end ?? 0);
  const common = {
    taskId: deterministicTaskId("essay_dictation", input.seed),
    practiceType: "essay_dictation",
    contextId: input.context.id,
    occurrenceId: input.occurrence?.id,
  } as const;

  if (chosen !== null) {
    // cloze：把选定出现位置整段换成空位标记（下标按窗口换算）。
    const blankIndex = window.prefixLength + chosen.start - window.start;
    return {
      ...common,
      prompt: {
        text: `${window.text.slice(0, blankIndex)}${DICTATION_BLANK_MARKER}${window.text.slice(blankIndex + chosen.text.length)}`,
        target: located.value,
        blankIndex,
        truncated: window.truncated,
      },
      answer: {
        text: window.text,
        blankText: chosen.text,
        hidden: false,
        normalization: DICTATION_NORMALIZATION,
      },
      hints: [`词形提示：${surfaceHint(chosen.text)}`],
    };
  }

  // full：全句默写（无空位；target 仅作提醒）。
  return {
    ...common,
    prompt: {
      text: window.text,
      target: located.value,
      blankIndex: null,
      truncated: window.truncated,
    },
    answer: {
      text: window.text,
      blankText: null,
      hidden: false,
      normalization: DICTATION_NORMALIZATION,
    },
    hints: located.value !== null ? [`句中需用到目标词：${located.value}`] : undefined,
  };
}

/**
 * 语境义自测（记录版）：原句（目标词供前端高亮）+ 默认隐藏的 bound sense。
 * 判定数据 = answer.text（boundSense 快照）；无快照不出题（回退规则见文件头注释）。
 * 本题型无随机分支：窗口锚点取目标词首次出现，内容完全由入参决定。
 */
export function buildContextQuizTask(input: BuildContextQuizInput): L3PracticeTask | null {
  const text = input.context.text;
  if (nonEmpty(text) === null) return null;

  const sense = nonEmpty(input.occurrence.boundSense);
  if (sense === null) return null;

  const located = locateTarget(text, input.occurrence);
  const focus = located.matches[0];
  const window = windowAround(text, focus?.start ?? 0, focus?.end ?? 0);

  return {
    taskId: deterministicTaskId("context_quiz", input.seed),
    practiceType: "context_quiz",
    contextId: input.context.id,
    occurrenceId: input.occurrence.id,
    prompt: {
      text: window.text,
      target: located.value,
      blankIndex: null,
      truncated: window.truncated,
    },
    answer: {
      text: sense,
      blankText: null,
      hidden: true,
      normalization: null,
    },
  };
}

/**
 * 默写判分归一规则（生成器只声明规则；记录侧判分时对期望文本与用户输入各跑一遍）：
 *   1) NFKC 归一（全角→半角、兼容字符统一）
 *   2) 连续空白折叠为单个半角空格（含全角空格）
 *   3) 去首尾空白
 *   4) 小写化（大小写不敏感）
 * 标点不做宽容：默写要还原原句标点。
 */
export function normalizeDictationText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
