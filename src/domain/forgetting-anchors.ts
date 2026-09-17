/**
 * 一键遗忘 · 锚点词候选（ADR-0020 §3）—— 纯函数、零出向、零 IO、零时间依赖。
 *
 * 三段分工（ADR-0020）：本函数只出**确定性候选** → agent 做"模拟遗忘"叙事解读
 * → 用户最终确认。agent 只叙事、不决策；本函数也只出候选、不写任何状态。
 *
 * 确定性规则（并集 ∪，任一命中即入候选）：
 *
 *   R1 稳定锚：stability ≥ 21 天（与 ADR-0002 的 L1→L2 晋升门取同一常量 ——
 *              "稳到能晋升"即"稳到值得保留"，不另造阈值）。
 *   R2 鲜活锚：retrievability ≥ 0.9（与 L2 desired_retention 同水位）——
 *              记忆此刻仍可提取，是能立刻行动的锚点。
 *   R3 助记锚：词条带 mnemonic 或 semantic_chain（有内容抓手），且最近
 *              ANCHOR_RECENT_WINDOW 次 L1 评分全为 good/easy（近期表现好）。
 *   R4 词根族锚（弱关联版）：与**已入选候选**（R1–R3 命中者，截断前）共享词根 token。
 *              第一版只用词根，同义/反义/派生图谱单独立项、不作为前置（ADR-0020 §4）。
 *              非传递：只认与 R1–R3 直接共享词根的行，不顺着链把整个家族拉进来。
 *
 * 排序与截断（确定性；无随机、无时间）：
 *   1) 规则得分 desc（R1 = 4 / R2 = 2 / R3 = 1，命中多条累加；R4 = 0）
 *   2) lapseCount asc（反复遗忘的词不是"能快速恢复行动力"的锚点）
 *   3) 输入下标 asc（同分同 lapse 时保持调用方给出的稳定顺序）
 *   上限 = min(ceil(可保留进度行数 × 20%), maxAnchors)
 *        —— 锚点是"几个能快速恢复行动力的词"，不是半本书；N 可配。
 *        分母只数**可保留**行（排除 suspended/new）：已挂起的行不该抬高上限。
 *
 * 排除：state='suspended'（已在遗忘态，无需再保留）与 state='new'（零学习痕迹，
 * 不是"能立刻行动"的锚点）。
 */

export interface AnchorProgressRow {
  wordId: string;
  stability: number | null;
  retrievability: number | null;
  state: string;
  recentRatings: string[];
  lapseCount: number;
}

export interface AnchorWordMeta {
  /** 词根串（DB: words.metadata.morphology_root，如 "pre+dict"）；按 "+" 拆 token。 */
  morphology?: string;
  /** 助记（DB: words.metadata.mnemonic）。 */
  mnemonic?: string;
  /** 语义链（DB: words.metadata.semantic_chain）。 */
  semanticChain?: string;
  /**
   * 别名（DB: words.aliases）。保留给 agent 叙事与后续词网络版本；
   * 第一版确定性规则不使用（ADR-0020 §4：弱关联版只用现有 FSRS 字段 + 词根/语义链）。
   */
  aliases?: string[];
}

export interface ComputeAnchorCandidatesInput {
  progressRows: AnchorProgressRow[];
  wordsMeta: Map<string, AnchorWordMeta>;
  /** 锚点上限 N；缺省 DEFAULT_MAX_ANCHORS。 */
  maxAnchors?: number;
}

/** 锚点上限占可保留进度行的比例。 */
export const ANCHOR_RATIO = 0.2;
/** 锚点上限的固定封顶 N（"几个"的量级，可配）。 */
export const DEFAULT_MAX_ANCHORS = 8;
/** R1 稳定锚阈值（天），与 ADR-0002 晋升门同源。 */
export const STABILITY_ANCHOR_THRESHOLD = 21;
/** R2 鲜活锚阈值，与 L2 desired_retention 同水位。 */
export const RETRIEVABILITY_ANCHOR_THRESHOLD = 0.9;
/** R3 只看最近 N 次评分。 */
export const ANCHOR_RECENT_WINDOW = 3;

const STABILITY_WEIGHT = 4;
const RETRIEVABILITY_WEIGHT = 2;
const MEMORY_HOOK_WEIGHT = 1;

const GOOD_OR_BETTER: ReadonlySet<string> = new Set(["good", "easy"]);
const INELIGIBLE_STATES: ReadonlySet<string> = new Set(["suspended", "new"]);
const EMPTY_MORPHOLOGY = "EMPTY";

/**
 * 词根 token 提取：与 PlazaService.extractRootTokens（src/services/plaza.service.ts）
 * 及前端 plazaSlugs.ts 同语义 —— 按 `+` 拆复合词根，各部分取首个连续拉丁字母串并
 * 小写化，过滤非 [a-z]{2,}（空、单字符、纯中文/符号）。domain 层零出向，不能 import
 * services，故内联同构实现（与前端同样的先例）。
 */
export function extractMorphologyRootTokens(morphology: string | undefined): string[] {
  if (!morphology || morphology === EMPTY_MORPHOLOGY) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of morphology.split("+")) {
    const match = /^[A-Za-z][A-Za-z'-]*/.exec(part.trim());
    if (!match) continue;
    const token = match[0].toLowerCase();
    if (!/^[a-z]{2,}$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

interface AnchorCandidate {
  wordId: string;
  score: number;
  lapseCount: number;
  /** 输入下标：排序最后一级，保证完全确定性。 */
  index: number;
}

function isEligible(row: AnchorProgressRow): boolean {
  return !INELIGIBLE_STATES.has(row.state);
}

function hasNonEmptyText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasMemoryHook(meta: AnchorWordMeta | undefined): boolean {
  if (meta === undefined) return false;
  return hasNonEmptyText(meta.mnemonic) || hasNonEmptyText(meta.semanticChain);
}

function recentRatingsAllGood(ratings: string[]): boolean {
  if (ratings.length === 0) return false;
  return ratings.slice(-ANCHOR_RECENT_WINDOW).every((rating) => GOOD_OR_BETTER.has(rating));
}

/** R1–R3 的规则得分；0 = 未命中任何规则。 */
function directRuleScore(row: AnchorProgressRow, meta: AnchorWordMeta | undefined): number {
  let score = 0;
  if (row.stability !== null && row.stability >= STABILITY_ANCHOR_THRESHOLD) {
    score += STABILITY_WEIGHT;
  }
  if (row.retrievability !== null && row.retrievability >= RETRIEVABILITY_ANCHOR_THRESHOLD) {
    score += RETRIEVABILITY_WEIGHT;
  }
  if (hasMemoryHook(meta) && recentRatingsAllGood(row.recentRatings)) {
    score += MEMORY_HOOK_WEIGHT;
  }
  return score;
}

function compareCandidates(a: AnchorCandidate, b: AnchorCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.lapseCount !== b.lapseCount) return a.lapseCount - b.lapseCount;
  return a.index - b.index;
}

/**
 * 计算锚点候选 wordId 列表（按优先级排序，已截断到上限）。
 * 同输入恒同输出（无随机、无时间、无 IO）。
 */
export function computeAnchorCandidates(input: ComputeAnchorCandidatesInput): string[] {
  const rows = input.progressRows;
  const wordsMeta = input.wordsMeta;

  const eligibleCount = rows.filter(isEligible).length;
  const limit = Math.min(
    Math.ceil(eligibleCount * ANCHOR_RATIO),
    input.maxAnchors ?? DEFAULT_MAX_ANCHORS,
  );
  if (limit <= 0) return [];

  // ── 阶段一：直接规则命中（R1–R3）────────────────────────────────────────
  const candidates = new Map<string, AnchorCandidate>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!isEligible(row)) continue;
    const score = directRuleScore(row, wordsMeta.get(row.wordId));
    if (score === 0) continue;
    // 同一 wordId 重复行（脏输入）：保留首次命中，索引与得分都稳定。
    if (candidates.has(row.wordId)) continue;
    candidates.set(row.wordId, {
      wordId: row.wordId,
      score,
      lapseCount: row.lapseCount,
      index,
    });
  }

  // ── 阶段二：词根族扩展（R4，基于截断前的阶段一集合，与截断顺序无关）────
  const anchoredRoots = new Set<string>();
  for (const candidate of candidates.values()) {
    for (const token of extractMorphologyRootTokens(wordsMeta.get(candidate.wordId)?.morphology)) {
      anchoredRoots.add(token);
    }
  }
  if (anchoredRoots.size > 0) {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!isEligible(row) || candidates.has(row.wordId)) continue;
      const tokens = extractMorphologyRootTokens(wordsMeta.get(row.wordId)?.morphology);
      if (!tokens.some((token) => anchoredRoots.has(token))) continue;
      candidates.set(row.wordId, {
        wordId: row.wordId,
        score: 0,
        lapseCount: row.lapseCount,
        index,
      });
    }
  }

  return [...candidates.values()]
    .sort(compareCandidates)
    .slice(0, limit)
    .map((candidate) => candidate.wordId);
}
