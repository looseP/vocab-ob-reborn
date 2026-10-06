/**
 * Hulu Sprint domain — 常量 + 纯函数 + 类型（ADR-0041，完备设计 §三/§四）。
 *
 * 葫芦冲刺 = 挂在 L1 词书上的阶段性多轮冲刺计划。本模块是**纯函数层**：
 * 零出向依赖（不 import db / repositories / services / zod），零 IO，零时间依赖。
 *
 * 边界（ADR-0041）：葫芦的任何代码路径零 FSRS 写入；本模块连"写入"这个概念
 * 都不持有 —— 它只做算术：风险分级、闸门判定、耗时夹取。
 *
 * 唯一常量来源：`HULU_WORDS_PER_DAY = 400` 是**初始常量**，不是测量值、不是承诺
 * （完备设计 §三）；闸门比例读计划行的 `gate_ratio` 列值，本模块不写死 0.8。
 */

// ── 常量 ────────────────────────────────────────────────────────────────
/** 冲刺期每日词量假设（初始常量；风险校验的唯一来源，不是测量值）。 */
export const HULU_WORDS_PER_DAY = 400;
/** 单轮墙钟耗时上限：7 天（秒）。超限夹取，不报错、不丢轮（R5）。 */
export const HULU_MAX_SINGLE_ROUND_SECONDS = 7 * 86400;
/** 目标轮数范围（hulu_plans.target_rounds CHECK 同值）。 */
export const HULU_MIN_ROUNDS = 2;
export const HULU_MAX_ROUNDS = 8;
/** 每页词数范围（hulu_plans.page_size CHECK 同值）。 */
export const HULU_MIN_PAGE = 5;
export const HULU_MAX_PAGE = 50;
/** 闸门比例范围（hulu_plans.gate_ratio CHECK 同值）。 */
export const HULU_MIN_GATE = 0.5;
export const HULU_MAX_GATE = 1;
/** 定格词集上限（hulu_plans.word_ids cardinality CHECK 同值）。 */
export const HULU_MAX_WORDS = 20000;
/** 默认值（hulu_plans 列默认同值；请求 schema 缺省亦同）。 */
export const HULU_DEFAULT_ROUNDS = 4;
export const HULU_DEFAULT_PAGE_SIZE = 20;
export const HULU_DEFAULT_GATE_RATIO = 0.8;

/** 计划状态（hulu_plans.status CHECK 同值）。 */
export type HuluPlanStatus = "active" | "completed" | "abandoned";

/** 风险三级：ok 放行 / warn 放行但持续显示缺口 / block 拒绝。 */
export type HuluRiskLevel = "ok" | "warn" | "block";

/** 闸门判定结果。 */
export type HuluGateDecision = "pass" | "block";

// ── 行类型（列名与 DB 一致；供 repository / service / 响应契约共用）──────
/** 计划行（hulu_plans，迁移 0050）。零 FSRS 列。 */
export interface HuluPlanRow {
  id: string;
  user_id: string;
  wordbook_id: string;
  /** 仅标签，不过滤词集（R6）。 */
  direction: string | null;
  exam_date: string;
  target_rounds: number;
  page_size: number;
  gate_ratio: number;
  word_ids: string[];
  status: HuluPlanStatus;
  suspend_review: boolean;
  /** `{wordId: 挂起前 state}`；仅开关开且已 apply 时非空。 */
  suspend_snapshot: Record<string, string> | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

/** 轮次行（hulu_rounds，迁移 0050）。`ended_at IS NULL` = 进行中（至多一个）。 */
export interface HuluRoundRow {
  id: string;
  plan_id: string;
  user_id: string;
  round_no: number;
  started_at: string;
  ended_at: string | null;
  elapsed_seconds: number | null;
  /** 页游标（R7）：页结算的条件 UPDATE 判据。 */
  pages_passed: number;
  words_passed: number;
  words_total: number;
}

/** 计划 + 轮次（GET /api/hulu/plans/:id 的载荷；缩时曲线的唯一数据源）。 */
export interface HuluPlanWithRounds {
  plan: HuluPlanRow;
  rounds: HuluRoundRow[];
}

/** 页载荷的一件词卡（只读；R4 专用端点，不复用 preview queue）。 */
export interface HuluPageWordItem {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  ipa: string | null;
  pos: string | null;
  short_definition: string | null;
  mnemonic_text: string | null;
}

/**
 * 页载荷：`items` 只含**存活**词（已删词被过滤，定格位置只缩不换）；
 * `alive = 0` 表示整页定格词已删 —— 前端跳过、服务端结算自动通过。
 */
export interface HuluPagePayload {
  pageIndex: number;
  pages: number;
  total: number;
  alive: number;
  items: HuluPageWordItem[];
}

// ── 纯函数 ──────────────────────────────────────────────────────────────

export interface HuluRiskInput {
  /** 定格词数（= cardinality(word_ids)）。 */
  wordCount: number;
  targetRounds: number;
  /** 距考试日剩余天数。 */
  leftDays: number;
  /** 每日词量假设；缺省 HULU_WORDS_PER_DAY。 */
  wordsPerDay?: number;
}

/** 风险分级结果：`need` = 所需天数，`left` = 剩余天数，`perRound` = 单轮所需天数。 */
export interface HuluRiskResult {
  perRound: number;
  need: number;
  left: number;
  level: HuluRiskLevel;
}

/**
 * 风险三级（完备设计 §三；服务端重算，不信任前端）：
 *
 *   perRound = ceil(wordCount / wordsPerDay)     单轮所需天数
 *   need     = targetRounds × perRound           计划所需天数
 *
 *   need > left × 2 → "block"（差得太多，拒绝；响应携带 { need, left, perRound }）
 *   need > left     → "warn" （放行，计划页持续显示缺口）
 *   否则            → "ok"
 *
 * 边界口径：`need === left` 是 ok（恰好赶上）；`need === left × 2` 是 warn
 * （恰好两倍是"还有救"，超过两倍才拒绝）。两处都用严格大于。
 */
export function assessHuluRisk(input: HuluRiskInput): HuluRiskResult {
  const wordsPerDay = input.wordsPerDay ?? HULU_WORDS_PER_DAY;
  const perRound = Math.ceil(input.wordCount / wordsPerDay);
  const need = input.targetRounds * perRound;
  const left = input.leftDays;
  let level: HuluRiskLevel = "ok";
  if (need > left * 2) level = "block";
  else if (need > left) level = "warn";
  return { perRound, need, left, level };
}

/**
 * 页级检索闸门（完备设计 §三）：`passed / total ≥ gateRatio` 放行。
 *
 * 比例取**计划行的列值**（不写死 0.8）；`total ≤ 0`（整页定格词已删）→ "pass"
 * —— 删空的页服务端自动通过，前端跳过。
 */
export function huluGateDecision(passed: number, total: number, gateRatio: number): HuluGateDecision {
  if (total <= 0) return "pass";
  return passed / total >= gateRatio ? "pass" : "block";
}

/**
 * 轮次耗时夹取（R5）：墙钟 `ended_at - started_at`，中断不切开；服务端夹取到
 * `[0, max]`。负数（时钟回拨）归 0，超上限归 max，不报错、不丢轮。
 */
export function clampElapsedSeconds(seconds: number, max: number = HULU_MAX_SINGLE_ROUND_SECONDS): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(Math.max(Math.floor(seconds), 0), max);
}
