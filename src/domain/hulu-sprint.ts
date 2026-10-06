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

/**
 * 协议版本（hulu_plans.protocol_version CHECK 同值，迁移 0051）。
 * `'v2'` 新计划 / `'legacy'` 存量回填。决定入池范围解释、轮次序列形状、曲线基准口径。
 */
export type HuluProtocolVersion = "v2" | "legacy";

/**
 * 轮次语义标签（hulu_rounds.kind CHECK 同值，迁移 0051）。
 *
 *   - `'exposure'` 曝光轮（第 0 轮）：使命是**让每个词至少被看见一次**，不是逼回忆。
 *     交互 = 逐卡直接展示卡面（无遮答、无自认、无闸门）；页结算语义 = 本页已曝光
 *     计数（`passed = total = 本页存活词数`，恒过闸）。**不计入** `target_rounds`。
 *   - `'recall'` 复习轮：现行的遮答→回忆→翻开→自认→页闸门流程。
 *   - `'legacy'` 存量回填：R9–R11 时期写下的轮，参与曲线但**永不作为基准轮**。
 */
export type HuluRoundKind = "exposure" | "recall" | "legacy";

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
  /** 协议版本（迁移 0051）：'v2' 新计划 / 'legacy' 存量。 */
  protocol_version: HuluProtocolVersion;
  /** 「包含还没复习过的词」（默认 false = 先学后刷）；v2 计划是否需要曝光轮由它决定。 */
  include_new_words: boolean;
  suspend_review: boolean;
  /** `{wordId: 挂起前 state}`；仅开关开且已 apply 时非空。 */
  suspend_snapshot: Record<string, string> | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

/** 轮次行（hulu_rounds，迁移 0050/0051）。`ended_at IS NULL` = 进行中（至多一个）。 */
export interface HuluRoundRow {
  id: string;
  plan_id: string;
  user_id: string;
  round_no: number;
  started_at: string;
  ended_at: string | null;
  elapsed_seconds: number | null;
  /** 轮次语义标签（迁移 0051）：曝光轮 / 复习轮 / 存量回填。 */
  kind: HuluRoundKind;
  /**
   * 本轮**实际结算词集**的指纹（R13）：收尾时按已结算页切片推导（页级近似）、
   * 排序后 SHA-256 取 hex 前 16 位。`null` = 未收尾或存量行（不回填）。
   */
  word_set_fingerprint: string | null;
  /** 页游标（R7）：页结算的条件 UPDATE 判据。 */
  pages_passed: number;
  words_passed: number;
  words_total: number;
}

/**
 * 计划**出参**载荷（P1 裁剪）：不再出参全量 `word_ids` / `suspend_snapshot`，
 * 只给计数。理由：P1 起前端不需要全量 id —— 页载荷走 `.../pages/:no`、
 * 曲线走 rounds；把 20000 个 uuid 塞进每次计划读的响应里是纯负担。
 * 出参类型与行类型分离后，`word_ids` 仍可自由增删（定格语义不变）。
 */
export interface HuluPlanSummary {
  id: string;
  user_id: string;
  wordbook_id: string;
  /** 仅标签，不过滤词集（R6）。 */
  direction: string | null;
  exam_date: string;
  target_rounds: number;
  page_size: number;
  gate_ratio: number;
  /** 定格词数 = cardinality(word_ids)；页数由 huluPageCount 推出。 */
  word_count: number;
  status: HuluPlanStatus;
  /** 协议版本（迁移 0051）：'v2' 新计划 / 'legacy' 存量。 */
  protocol_version: HuluProtocolVersion;
  /** 「包含还没复习过的词」；v2 计划是否需要曝光轮由它决定。 */
  include_new_words: boolean;
  suspend_review: boolean;
  /** 快照条目数（未 apply 或已恢复时为 0）。 */
  suspended_count: number;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

/** 计划 + 轮次（GET /api/hulu/plans/:id 的载荷；缩时曲线的唯一数据源）。 */
export interface HuluPlanWithRounds {
  plan: HuluPlanSummary;
  rounds: HuluRoundRow[];
}

/**
 * 页载荷的一件词卡（只读；R4 专用端点，不复用 preview queue）。
 *
 * 字段清单（R10 / 修订轮 D-B「卡面精致化」）：五层披露所需的一切都在这里，
 * 随**页载荷**批量带下 —— 单卡路径因此零请求（禁 `useWordDetail`）。
 *   - Tier0 主行：`short_definition`
 *   - 义项层：`core_definitions`（入库时已按 priority 排序，序即重要程度）
 *   - 助记锚：`mnemonic_text` + `mnemonic_type`
 *   - 例句：`examples`（前 1–2 条，防御性渲染）
 *   - Tier2：`semantic_chain`（默认折叠）+ `prototype_text`
 * `definition_md` 是 `core_definitions` 为空时的降级路径（与 L1 卡背同一判据）。
 */
export interface HuluPageWordItem {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  ipa: string | null;
  pos: string | null;
  cefr: string | null;
  short_definition: string | null;
  /** 结构化义项（`words.core_definitions`；空数组 = 走 definition_md 降级）。 */
  core_definitions: CoreSense[];
  definition_md: string;
  /** 例句 JSONB（形状由导入器决定，前端逐项窄化、缺字段安静降级）。 */
  examples: unknown[];
  prototype_text: string | null;
  mnemonic_text: string | null;
  mnemonic_type: string | null;
  semantic_chain: string | null;
}

/**
 * 页载荷取词的行类型（`HuluRepository.findHuluPageWords` 的返回；
 * 与 `HuluPageWordItem` 同形，但 jsonb 列在仓库层尚未窄化）。
 */
export type HuluPageWordRow = HuluPageWordItem;

/**
 * 结构化义项。与 `SenseList` 的 `CoreSense` **同形**——两边都描述
 * `words.core_definitions` 的一个元素；此处复制字段定义而非 import 前端组件，
 * 是为了守住 domain 的零出向依赖（domain 不 import frontend）。
 * 契约测试锁两者同形（tests/domain/hulu-sprint.test.ts）。
 */
export interface CoreSense {
  sense: string;
  en: string | null;
  priority: number | null;
  tags: string[];
}

/**
 * 页载荷：`items` 只含**存活**词（已删词被过滤，定格位置只缩不换）；
 * `total` = 本页定格词数（切片长度），`alive` = 存活词数（= items.length）；
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
 *
 * **曝光轮恒过闸**（R12）：曝光轮的页结算复用同一管道，但 `passed` 的语义是
 * 「本页已曝光词数」= 本页存活词数（曝光无自认），于是 `passed / total === 1`
 * 恒 ≥ 任何合法 gateRatio —— 闸门函数本身**不改**，恒过是调用方口径的自然结果。
 * 前端在曝光轮不发与闸门相关的 UI（无「通过率」徽标，显示「已曝光 n/n」）。
 */
export function huluGateDecision(passed: number, total: number, gateRatio: number): HuluGateDecision {
  if (total <= 0) return "pass";
  return passed / total >= gateRatio ? "pass" : "block";
}

/**
 * 两条轮次是否为**可比较轮**（R13）：结算词集指纹一致。
 *
 * 判据是**指纹相等**，不是词数相等 —— `words_total` 恒等于定格词数、不随删词变化，
 * 「两轮 24 词」完全可能是 24 个不同的词。指纹为 `null`（未收尾 / 存量行）或空串
 * （脏数据，不是合法指纹）时不比较：两边都得是**非空**指纹且相同才算可比较。
 *
 * 本函数是纯比较：指纹**计算**在 service 层（`node:crypto` 是出向依赖，domain
 * 零出向红线不容 import —— 见 ADR-0041 Amendment 2 第 2 条）。
 */
export function huluSameWordSet(fpA: string | null, fpB: string | null): boolean {
  if (fpA === null || fpB === null) return false;
  if (fpA.length === 0 || fpB.length === 0) return false;
  return fpA === fpB;
}

/**
 * 轮次耗时夹取（R5）：墙钟 `ended_at - started_at`，中断不切开；服务端夹取到
 * `[0, max]`。负数（时钟回拨）归 0，超上限归 max，不报错、不丢轮。
 */
export function clampElapsedSeconds(seconds: number, max: number = HULU_MAX_SINGLE_ROUND_SECONDS): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(Math.max(Math.floor(seconds), 0), max);
}

/**
 * 页数 = `ceil(定格词数 / page_size)`（R4/§七）。
 *
 * 只依**定格**词数，与词书当前的增删无关（词被删只让页内的存活词变少，
 * 不让页数变少 —— 否则「只缩不换」的定格语义会被页边界漂移破坏）。
 * 定格词数为 0 时返回 0（创建时已拒绝空词书，此处是防御性口径）。
 */
export function huluPageCount(wordCount: number, pageSize: number): number {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return 0;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 0;
  return Math.ceil(wordCount / pageSize);
}

/**
 * 本页的定格切片（左闭右开）：`slice(no * pageSize, (no + 1) * pageSize)`。
 *
 * 越界（no < 0 或 no ≥ 页数）返回空数组 —— 服务层据此抛 404（越界页不是
 * 「空页」，是「不存在的页」）。切片只依定格数组，与词是否被删无关。
 */
export function huluPageSlice(wordIds: readonly string[], pageSize: number, pageIndex: number): string[] {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return [];
  if (!Number.isFinite(pageSize) || pageSize <= 0) return [];
  if (pageIndex >= huluPageCount(wordIds.length, pageSize)) return [];
  return wordIds.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
}

/**
 * 计划行 → 出参摘要（P1 裁剪）：全量 `word_ids` / `suspend_snapshot` 折叠成计数。
 *
 * 与页载荷的 `total` 同源（都用定格 `word_ids`）—— 前端用 `word_count` + `page_size`
 * 算进度指示，不需要全量 id。
 */
export function toHuluPlanSummary(plan: HuluPlanRow): HuluPlanSummary {
  return {
    id: plan.id,
    user_id: plan.user_id,
    wordbook_id: plan.wordbook_id,
    direction: plan.direction,
    exam_date: plan.exam_date,
    target_rounds: plan.target_rounds,
    page_size: plan.page_size,
    gate_ratio: plan.gate_ratio,
    word_count: plan.word_ids.length,
    status: plan.status,
    protocol_version: plan.protocol_version,
    include_new_words: plan.include_new_words,
    suspend_review: plan.suspend_review,
    suspended_count: plan.suspend_snapshot ? Object.keys(plan.suspend_snapshot).length : 0,
    started_at: plan.started_at,
    ended_at: plan.ended_at,
    created_at: plan.created_at,
  };
}
