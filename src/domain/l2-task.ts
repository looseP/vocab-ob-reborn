/**
 * L2 辨析训练任务生成器（l2-drill spec §五）——纯函数、零出向依赖。
 *
 * 数据源：words 表 L2 JSONB 缓存列（corpus_items / synonym_items /
 * antonym_items），零跨词查询，干扰项全部来自本词条内容。
 * 种子 = sha256(sessionId:wordId:step_index) → mulberry32：同输入永远同题
 * （幂等重放安全），随机性只在词间/步间生效。
 */

import { createHash } from "node:crypto";
import type { ContextSource, ContextSnippet } from "./context-source";

export type L2TaskType = "cloze_mcq" | "synonym_discrimination" | "production";

export interface L2TaskPayload {
  taskId: string;
  taskType: L2TaskType;
  prompt: string;
  /** cloze 附带的中文线索 */
  translation?: string;
  options?: [string, string, string, string];
  answerIndex?: 0 | 1 | 2 | 3;
  /** 产出的中文提示（short_definition） */
  hintTranslation?: string;
  /** 语料参照例句（作答后对照展示） */
  referenceExample?: string;
  /**
   * P3-8：L3 来源元数据。仅产出步在拉到 L3 语境时填充。
   * 前端用 sourceTitle 渲染来源徽标，contextId 渲染"查看原文"跳转。
   * l2TaskPayloadSchema 用 .passthrough()，无需在 schema 显式声明。
   */
  sourceTitle?: string;
  contextId?: string;
  /**
   * H4 修复：任务所属步索引（队列预生成恒为 0；产出步为 1）。
   * 响应契约 l2TaskPayloadSchema 要求此字段必填，之前 domain 接口缺该字段
   * 导致 OpenAPI 文档与前端 L2DrillTask 类型契约失真（实际响应 undefined）。
   */
  stepIndex: number;
}

export interface L2TaskWordInput {
  lemma: string;
  short_definition: string | null;
  corpus_items: unknown;
  synonym_items: unknown;
  antonym_items: unknown;
}

export interface GenerateL2DiscriminationInput {
  sessionId: string;
  wordId: string;
  /** 任务所属步（队列预生成恒为 0；产出步为 1）。进入种子与 taskId。 */
  stepIndex?: number;
  word: L2TaskWordInput;
  /**
   * L3 语境挂载点（spec §五/D7'）：默认 noop，FR-12 接线前不参与任何行为。
   * 仅引用类型以固化红线边界。
   *
   * 注意：domain 层是纯函数零出向依赖，task generator 不会调用此对象。
   * service 层（L2DrillService）负责调用 contextSource.getContextSnippets
   * 获取语境片段，然后通过 contextSnippets 字段传入本生成器。
   */
  contextSource?: ContextSource;
  /**
   * FR-12 接线2：L3 语境片段（已由 service 层通过 contextSource 查询获得）。
   * task generator 用它丰富产出步的 referenceExample（参照例句）。
   * 空数组或缺省 = 无可用 L3 语境，回退到 corpus_items[0].text。
   *
   * P3-8 扩展：类型由 string[] 调整为 ContextSnippet[]，携带 contextId /
   * sourceId / sourceTitle 元数据，让产出步 payload 能渲染来源徽标 + 跳转。
   */
  contextSnippets?: ContextSnippet[];
}

/** 确定性 taskId：同会话同词同步重放永远同一 id。 */
function deterministicTaskId(taskType: string, sessionId: string, wordId: string, stepIndex: number): string {
  const hash = createHash("sha256").update(`${sessionId}:${wordId}:${stepIndex}`).digest("hex").slice(0, 16);
  return `${taskType}:${hash}`;
}

// ── 结构守卫（duck-typing；域层不依赖 zod 合同以保持零出向）────────────────

interface CorpusEntry {
  text: string;
  translation?: string;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(item: unknown, key: string): string | null {
  if (item == null || typeof item !== "object") return null;
  const v = (item as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function corpusEntries(raw: unknown): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const item of asArray(raw)) {
    const text = pickString(item, "text");
    if (!text) continue;
    const translation = pickString(item, "translation");
    out.push({ text, translation: translation ?? undefined });
  }
  return out;
}

/** synonym_items{word,semanticDiff} / antonym_items{word} 共用的词池抽取。 */
function distractorWords(raw: unknown): string[] {
  return asArray(raw)
    .map((item) => pickString(item, "word"))
    .filter((w): w is string => w !== null);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── PRNG ─────────────────────────────────────────────────────────────────────

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

export function taskPrng(sessionId: string, wordId: string, stepIndex: number): () => number {
  const digest = createHash("sha256").update(`${sessionId}:${wordId}:${stepIndex}`).digest();
  return mulberry32(digest.subarray(0, 8));
}

// ── 干扰项词池 ────────────────────────────────────────────────────────────────

/**
 * 从 synonym ∪ antonym 词条收集干扰项：大小写不敏感去重、排除目标词、
 * 运行期卫生检查（非空、长度≤40 —— l2-drill spec §十五）。
 */
export function collectDistractorPool(
  input: L2TaskWordInput,
  excludeLower: Set<string>,
): string[] {
  const pool = new Map<string, string>();
  for (const raw of distractorWords(input.synonym_items).concat(distractorWords(input.antonym_items))) {
    const lower = raw.toLowerCase();
    if (lower.length === 0 || lower.length > 40) continue;
    if (excludeLower.has(lower) || pool.has(lower)) continue;
    pool.set(lower, raw);
  }
  return [...pool.values()];
}

function sampleN<T>(items: T[], n: number, rnd: () => number): T[] {
  const copy = [...items];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    out.push(...copy.splice(Math.floor(rnd() * copy.length), 1));
  }
  return out;
}

// ── 题型一：语境填空 cloze_mcq ───────────────────────────────────────────────

function buildClozeMcq(input: GenerateL2DiscriminationInput, rnd: () => number): L2TaskPayload | null {
  const entries = corpusEntries(input.word.corpus_items);
  if (entries.length === 0) return null;
  // 词边界匹配（大小写不敏感），避免 "art" 命中 "party"。
  const boundaryRe = new RegExp(`(?<![a-zA-Z])${escapeRegExp(input.word.lemma)}(?![a-zA-Z])`, "i");
  const hits = entries.filter((e) => boundaryRe.test(e.text));
  if (hits.length === 0) return null;

  const chosen = hits[Math.floor(rnd() * hits.length)]!;
  // H1 修复：用带 g 标志的新正则做 replaceAll，替换原句中所有 lemma 出现，
  // 避免 lemma 复现时只换第一处导致答案泄漏。boundaryRe 自身仍保持非全局，
  // 不影响 L150 的 .test() 调用（全局正则的 lastIndex 会让 filter 串行 test 出错）。
  const prompt = chosen.text.replaceAll(new RegExp(boundaryRe.source, "gi"), "____");
  const answer = input.word.lemma;

  const exclude = new Set([answer.toLowerCase()]);
  const distractors = sampleN(collectDistractorPool(input.word, exclude), 3, rnd);
  if (distractors.length < 3) return null;

  const answerIndex = Math.floor(rnd() * 4) as 0 | 1 | 2 | 3;
  const options: [string, string, string, string] = ["", "", "", ""];
  let slot = 0;
  for (let i = 0; i < 4; i++) {
    if (i === answerIndex) {
      options[i] = answer;
    } else {
      options[i] = distractors[slot++]!;
    }
  }

  return {
    taskId: deterministicTaskId("cloze_mcq", input.sessionId, input.wordId, input.stepIndex ?? 0),
    taskType: "cloze_mcq",
    prompt,
    translation: chosen.translation,
    options,
    answerIndex,
    // H4 修复：与响应契约 l2TaskPayloadSchema 的 stepIndex 必填字段对齐
    stepIndex: input.stepIndex ?? 0,
  };
}

// ── 题型二：近义辨析 synonym_discrimination ─────────────────────────────────

interface SynonymEntry {
  word: string;
  semanticDiff: string;
}

function synonymEntries(raw: unknown): SynonymEntry[] {
  return asArray(raw)
    .map((item) => {
      const word = pickString(item, "word");
      const semanticDiff = pickString(item, "semanticDiff");
      return word && semanticDiff ? { word, semanticDiff } : null;
    })
    .filter((e): e is SynonymEntry => e !== null);
}

function buildSynonymDiscrimination(
  input: GenerateL2DiscriminationInput,
  rnd: () => number,
): L2TaskPayload | null {
  // H2 修复：过滤掉 word === lemma 的自指脏数据，避免 chosen 与 fillers[0]
  // 字面相同导致 options 出现重复且 judgeL2TaskChoice 判分歧义（答相同字符串
  // 的不同槽位得到不同判定）。dirty 数据不应进入候选池。
  const lemmaLower = input.word.lemma.toLowerCase();
  const entries = synonymEntries(input.word.synonym_items).filter(
    (e) => e.word.toLowerCase() !== lemmaLower,
  );
  if (entries.length === 0) return null;

  const chosen = entries[Math.floor(rnd() * entries.length)]!;
  const exclude = new Set([chosen.word.toLowerCase(), input.word.lemma.toLowerCase()]);
  const others = sampleN(collectDistractorPool(input.word, exclude), 2, rnd);
  if (others.length < 2) return null;

  // 答案（贴合差异描述的同义词）随机落位，其余槽位依次填入
  // 目标词 + 两个干扰项 —— 与 cloze 构建器同一布局法，保证四项互异。
  const fillers = [input.word.lemma, others[0]!, others[1]!];
  const answerIndex = Math.floor(rnd() * 4) as 0 | 1 | 2 | 3;
  const options: [string, string, string, string] = ["", "", "", ""];
  let slot = 0;
  for (let i = 0; i < 4; i++) {
    if (i === answerIndex) {
      options[i] = chosen.word;
    } else {
      options[i] = fillers[slot++]!;
    }
  }

  return {
    taskId: deterministicTaskId("synonym_discrimination", input.sessionId, input.wordId, input.stepIndex ?? 0),
    taskType: "synonym_discrimination",
    prompt: `关于 ${input.word.lemma} 的近义辨析：哪个词贴合以下差异描述？「${chosen.semanticDiff}」`,
    options,
    answerIndex,
    // H4 修复：与响应契约 l2TaskPayloadSchema 的 stepIndex 必填字段对齐
    stepIndex: input.stepIndex ?? 0,
  };
}

// ── 对外主入口 ───────────────────────────────────────────────────────────────

/**
 * 生成一道辨析题；两种题型按 PRNG 决定尝试顺序，都不可行返回 null
 * （调用方降级为单步产出会话，l2-drill spec §一分支矩阵）。
 */
export function generateL2DiscriminationTask(input: GenerateL2DiscriminationInput): L2TaskPayload | null {
  const stepIndex = input.stepIndex ?? 0;
  const rnd = taskPrng(input.sessionId, input.wordId, stepIndex);
  const builders = [buildClozeMcq, buildSynonymDiscrimination];
  const order = rnd() < 0.5 ? builders : [...builders].reverse();
  for (const build of order) {
    const task = build(input, rnd);
    if (task) return task;
  }
  return null;
}

/** 产出任务永远可行（只需词条本身），无不可行判定。 */
export function buildL2ProductionTask(input: {
  sessionId: string;
  wordId: string;
  stepIndex?: number;
  word: L2TaskWordInput;
  /**
   * FR-12 接线2：L3 语境片段。如果提供，优先取第一条作为 referenceExample，
   * 让用户在造句时看到目标词在真实 L3 语境中的用法。回退到 corpus_items[0]。
   *
   * P3-8 扩展：类型为 ContextSnippet[]，携带 source 元数据。若首条片段带
   * contextId / sourceTitle，会一并写入 payload 供前端渲染来源徽标 + 跳转。
   */
  contextSnippets?: ContextSnippet[];
}): L2TaskPayload {
  const stepIndex = input.stepIndex ?? 1;
  // FR-12 接线2：优先取 L3 语境片段作为参照例句；无则回退到 corpus_items[0]
  const l3Snippet = input.contextSnippets?.[0];
  const corpusReference = corpusEntries(input.word.corpus_items)[0];
  const reference = l3Snippet?.text ?? corpusReference?.text;
  // P3-8：若 referenceExample 来自 L3，附带写入 source 元数据用于前端跳转
  const sourceTitle = l3Snippet?.sourceTitle;
  const contextId = l3Snippet?.contextId;
  return {
    taskId: deterministicTaskId("production", input.sessionId, input.wordId, stepIndex),
    taskType: "production",
    prompt: `用「${input.word.lemma}」造一个句子`,
    hintTranslation: input.word.short_definition ?? undefined,
    referenceExample: reference,
    ...(sourceTitle !== undefined ? { sourceTitle } : {}),
    ...(contextId !== undefined ? { contextId } : {}),
    // H4 修复：与响应契约 l2TaskPayloadSchema 的 stepIndex 必填字段对齐
    stepIndex,
  };
}

/** 判分：仅辨析题有答案字段。 */
export function judgeL2TaskChoice(payload: unknown, choiceIndex: number): boolean {
  if (payload == null || typeof payload !== "object") return false;
  const answerIndex = (payload as Record<string, unknown>).answerIndex;
  return answerIndex === choiceIndex;
}

/**
 * API 出参剥离（spec §五）：answerIndex 绝不出现在任何响应。
 * 参照例句保留——它本身不是答案。
 */
export function stripAnswer<T extends L2TaskPayload>(payload: T): Omit<T, "answerIndex"> {
  const { answerIndex: _omitted, ...rest } = payload;
  return rest;
}
