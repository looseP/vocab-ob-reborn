/**
 * L3 练习台 / 错题库 viewModel（ADR-0019 §1/§3）——全部纯函数，浏览器安全。
 *
 * 边界守卫（tests/l3-frontend-shell.test.ts）：前端文件不得 import node:* /
 * server 层，不得出现本地 fetch 与 API 路径字样 —— 本文件只做计算。
 *
 * 任务身份（幂等键）：与 T04 `src/domain/l3-practice-task.ts` 的
 * `deterministicTaskId` 同算法（sha256(seed) 十六进制前 16 位 + 题型前缀），
 * seed = `runId:contextId:attemptIndex`。domain 模块 import node:crypto（浏览器
 * 运行时不可用），L2 先例（useL2Drill）是「前端不生成 taskId、用浏览器内置
 * crypto 做幂等键」；L3 无任务下发端点且契约冻结，故这里用浏览器内置 Web
 * Crypto 复刻同一算法，并由 tests/frontend/l3-practice-task-id.test.ts 与
 * domain 实现输出对拍锁定等价（node 测试环境可直接跑 domain 版本）。
 *
 * 练习反馈只写 attempts（服务端零 FSRS）；本文件不触碰任何 L1/L2 概念。
 */
import type {
  Json,
  L3OccurrenceListItem,
  L3PracticeErrorBookItem,
  L3PracticeOutcome,
  L3PracticeType,
} from "@/domain";

/** cloze 空位占位串（与 T04 的 DICTATION_BLANK_MARKER 一致）。 */
export const L3_DICTATION_BLANK_MARKER = "____";

/** 练习素材每次拉取条数（服务端 limit 上限 100）。 */
export const L3_PRACTICE_MATERIAL_LIMIT = 20;

export interface PracticeMaterialTask {
  practiceType: L3PracticeType;
  occurrenceId: string;
  contextId: string;
  /** 完整原句（context.text，不截断；展示层负责行数限制）。 */
  text: string;
  /** 目标词面（occurrence.surface 优先、回退 lemma）。 */
  target: string;
  /** 默写：挖空后的展示文本；语境自测：原句。 */
  promptText: string;
  /** 默写：期望填入的原句片段；语境自测为 null。 */
  blankText: string | null;
  /** 语境自测：绑定释义（判定数据）；默写为 null。 */
  boundSense: string | null;
  /** 来源标题（展示用）。 */
  sourceTitle: string;
  /** 词条标题（展示用）。 */
  wordTitle: string;
}

export interface PracticeTaskBuildResult {
  tasks: PracticeMaterialTask[];
  /** 无法出题被跳过的素材数（缺目标词 / 目标词定位不到 / 缺绑定释义）。 */
  skipped: number;
}

/** 与 T04 一致的词边界字符集（避免 art 命中 party）。 */
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

interface TargetMatch {
  start: number;
  end: number;
  /** 句中的实际片段（保留原句大小写，即默写期望填入串）。 */
  text: string;
}

/** 目标串在句中的首次出现（大小写不敏感 + 词边界，与 T04 findMatches 同规则）。 */
export function findFirstTargetMatch(text: string, target: string): TargetMatch | null {
  const matcher = new RegExp(escapeRegExp(target), "giu");
  for (const match of text.matchAll(matcher)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isBoundary(text, start - 1) || !isBoundary(text, end)) continue;
    return { start, end, text: match[0] };
  }
  return null;
}

/** 目标定位（与 T04 locateTarget 同规则）：surface 优先，未命中回退 lemma。 */
function locateTarget(
  text: string,
  occurrence: { surface: string | null; lemma: string | null },
): { value: string; match: TargetMatch } | null {
  const surface = nonEmpty(occurrence.surface);
  if (surface !== null) {
    const match = findFirstTargetMatch(text, surface);
    if (match !== null) return { value: surface, match };
  }
  const lemma = nonEmpty(occurrence.lemma);
  if (lemma !== null) {
    const match = findFirstTargetMatch(text, lemma);
    if (match !== null) return { value: lemma, match };
  }
  return null;
}

/** 单条素材 → 可作答任务；不可出题返回 null（调用方计数跳过）。 */
function buildSingleTask(item: L3OccurrenceListItem, practiceType: L3PracticeType): PracticeMaterialTask | null {
  const text = item.context.text;
  if (nonEmpty(text) === null) return null;

  const located = locateTarget(text, item.occurrence);
  if (located === null) return null; // anchor drift：surface/lemma 都定位不到，跳过
  const { value: target, match } = located;

  const base = {
    practiceType,
    occurrenceId: item.occurrence.id,
    contextId: item.context.id,
    text,
    target,
    sourceTitle: item.source.title,
    wordTitle: item.word.title,
  } as const;

  if (practiceType === "context_quiz") {
    const sense = nonEmpty(item.occurrence.bound_sense);
    if (sense === null) return null; // 无绑定释义 = 无判定数据，不产出伪题目
    return { ...base, promptText: text, blankText: null, boundSense: sense };
  }

  return {
    ...base,
    promptText: `${text.slice(0, match.start)}${L3_DICTATION_BLANK_MARKER}${text.slice(match.end)}`,
    blankText: match.text,
    boundSense: null,
  };
}

/** 从 occurrence 列表构建可作答任务（跳过不可出题项，与 T04 的 null 约定一致）。 */
export function buildPracticeTasks(items: L3OccurrenceListItem[], practiceType: L3PracticeType): PracticeTaskBuildResult {
  const tasks: PracticeMaterialTask[] = [];
  let skipped = 0;
  for (const item of items) {
    const task = buildSingleTask(item, practiceType);
    if (task) tasks.push(task);
    else skipped += 1;
  }
  return { tasks, skipped };
}

// ── 默写判分（与 T04 normalizeDictationText 同规则） ─────────────────────

/**
 * 归一化：NFKC → 连续空白折叠 → 去首尾 → 小写。
 * 与 src/domain/l3-practice-task.ts 的 normalizeDictationText 逐分支一致
 * （tests/frontend/l3-practice-task-id.test.ts 对拍锁定）。
 */
export function normalizeDictationText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 默写判定：用户输入与期望片段各跑一遍归一化后比对。 */
export function judgeDictation(input: string, expected: string): boolean {
  return normalizeDictationText(input) === normalizeDictationText(expected);
}

// ── 任务身份（幂等键） ───────────────────────────────────────────────────

/** 确定性种子（与 T04 l3PracticeSeed 同公式；runId 即会话/演练身份）。 */
export function buildPracticeSeed(runId: string, contextId: string, attemptIndex: number): string {
  return `${runId}:${contextId}:${attemptIndex}`;
}

/** Web Crypto 的最小结构（避免依赖 DOM / node 的 SubtleCrypto 类型名）。 */
export interface DigestCapable {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * 确定性 taskId：`<practiceType>:<sha256(seed).hex 前 16 位>`。
 * 与 T04 deterministicTaskId 输出逐字节一致（对拍测试锁定）。
 */
export async function computePracticeTaskId(
  practiceType: L3PracticeType,
  seed: string,
  digestImpl?: DigestCapable,
): Promise<string> {
  const impl = digestImpl ?? (globalThis.crypto?.subtle as unknown as DigestCapable | undefined);
  if (!impl) {
    throw new Error("Web Crypto (crypto.subtle) is unavailable; cannot derive the practice task id.");
  }
  const digest = await impl.digest("SHA-256", new TextEncoder().encode(seed));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${practiceType}:${hex.slice(0, 16)}`;
}

/** 一次练习演练的身份（页面加载一批素材时生成；重进页面即新演练）。 */
export function newPracticeRunId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

// ── 作答快照（存进 attempt.payload 供错题库回看） ─────────────────────────

export interface PracticeSnapshot {
  text: string | null;
  target: string | null;
}

/** 从 attempt.payload 读展示快照（缺省/畸形一律 null，不抛错）。 */
export function readPracticeSnapshot(payload: Json): PracticeSnapshot {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { text: null, target: null };
  }
  const record = payload as Record<string, Json>;
  return {
    text: typeof record.text === "string" && record.text.trim().length > 0 ? record.text : null,
    target: typeof record.target === "string" && record.target.trim().length > 0 ? record.target : null,
  };
}

/** 作答快照：原句 + 目标词 + 题面 + 用户输入（全部字符串，Json 安全）。 */
export function buildPracticeSnapshot(input: {
  task: PracticeMaterialTask;
  userInput?: string | null;
}): Record<string, string | null> {
  return {
    text: input.task.text,
    target: input.task.target,
    prompt: input.task.promptText,
    expected: input.task.blankText,
    input: input.userInput ?? null,
  };
}

// ── 错题库展示行（聚合口径：服务端） ─────────────────────────────────────

export interface ErrorBookDisplayRow {
  contextId: string;
  text: string;
  target: string;
  /** 该语境全量错误次数（服务端聚合，跨分页窗口）。 */
  wrongCount: number;
  /** 该语境最近一次作答结果（服务端聚合，含已答对的语境）。 */
  latestOutcome: L3PracticeOutcome;
  /** 与该 latestOutcome 同源的最近作答时间（服务端聚合）。 */
  latestAt: string;
}

/**
 * 错题库条目 → 展示行：每个语境一行（同语境多条 wrong 行时取列表首条 =
 * 最近一条 wrong 行；聚合字段由服务端给出，同语境各行取值一致）。
 * 计数与最近结果不再依赖前端 ≤100 条回看窗口。
 */
export function buildErrorBookRows(items: L3PracticeErrorBookItem[]): ErrorBookDisplayRow[] {
  const rows: ErrorBookDisplayRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.context_id)) continue;
    seen.add(item.context_id);
    const snapshot = readPracticeSnapshot(item.payload);
    rows.push({
      contextId: item.context_id,
      text: snapshot.text ?? "",
      target: snapshot.target ?? "",
      wrongCount: item.wrongCount,
      latestOutcome: item.latestOutcome,
      latestAt: item.latestAt,
    });
  }
  return rows;
}

const OUTCOME_LABELS: Record<L3PracticeOutcome, string> = {
  correct: "正确",
  wrong: "错误",
  skip: "跳过",
};

/** 结果标签（中文，供错题库/练习反馈展示）。 */
export function outcomeLabel(outcome: L3PracticeOutcome | null | undefined): string {
  return outcome ? OUTCOME_LABELS[outcome] : "—";
}

const PRACTICE_TYPE_LABELS: Record<L3PracticeType, string> = {
  essay_dictation: "作文句默写",
  context_quiz: "语境义自测",
};

/** 题型标签（中文）。 */
export function practiceTypeLabel(practiceType: L3PracticeType): string {
  return PRACTICE_TYPE_LABELS[practiceType];
}
