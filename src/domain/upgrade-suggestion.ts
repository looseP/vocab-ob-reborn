/**
 * 升级建议（ADR-0018 §2）—— 纯函数、零出向、零 IO、零时间依赖。
 *
 * 场景：换书重学时词在新书从 L1 重新起步，但它在历史书里可能早已掌握。
 * 本函数给"要不要把该词提前升级进 L2"的**建议档位**，仅在词于新书的
 * 首学/首复习时刻展示（ADR-0018 §2）。纯提示：不设卡、不写 FSRS、不阻断标记。
 *
 * 输入 = 当前书 L1 近期表现 + **他书** L2 掌握度。跨书学习数据只在此处合法
 * 使用：只喂建议，永不改进度（ADR-0018 §3：seed ≠ merge）。
 *
 * 档位规则（显式、可测；判定顺序 = 优先级顺序）：
 *
 *   R1 需要沉淀｜当前书出现失败证据
 *      - 最近一次 L1 评分 = again（刚答错，当前书还没上手）；或
 *      - 当前书 L1 state = relearning（本书记忆已掉过一次，先沉淀）。
 *
 *   R2 需要沉淀｜他书 L2 全无掌握证据，且存在不稳定证据
 *      - 输入不含他书 recent_ratings，故用代理信号：l2ProductionStatus='weak'
 *        （产出步自评未过）／state='relearning'／retrievability < 0.7。
 *      - "全无掌握"是必要条件：只要有一本书给出掌握证据（见 R3），本条就不成立
 *        —— seed 取跨书最佳状态（ADR-0018 §3），一本弱行不该否掉另一本强行。
 *
 *   R3 强烈推荐升级｜他书 L2 存在可复用的掌握状态
 *      - state='review' 且（retrievability ≥ 0.9 或 l2ProductionStatus='passed'）
 *        且 l2ProductionStatus ≠ 'weak'。
 *      - 当前书首答 hard 不否决本档：新书首答偏难属正常，跨书掌握才是主信号。
 *
 *   R4 推荐升级｜无他书掌握证据时，仅看当前书表现
 *      - 近期窗口（最近 3 次）非空且全 ∈ {good, easy}。
 *      - 注意首答单次 good 也会得到本档：ADR-0018 把建议定位为"建议而非门槛"，
 *        升级本身仍需用户在 agent 工作台显式发起。
 *
 *   R5 兜底 = 需要沉淀｜零证据（无评分且无他书记录）或证据不足（如只有 hard）：
 *      无证据不推荐，保守默认。
 */

/** 建议档位：强烈推荐升级 / 推荐升级 / 需要沉淀（ADR-0018 §2）。 */
export type UpgradeSuggestionLevel = "strong" | "normal" | "needs_settling";

/** 当前书 L1 表现（DB: user_word_progress 行）。 */
export interface CurrentBookL1Signal {
  /** 最近 L1 评分（时间正序，DB 侧最多 5 条）。 */
  recentRatings: string[];
  /** L1 调度状态（new / learning / review / relearning / suspended）。 */
  state: string;
}

/** 他书 L2 掌握度（DB: user_word_l2_progress 行，不含当前书）。 */
export interface OtherBookL2Signal {
  state: string;
  retrievability: number | null;
  l2ProductionStatus: string | null;
}

export interface UpgradeSuggestionInput {
  currentBookL1: CurrentBookL1Signal;
  otherBooksL2: OtherBookL2Signal[];
}

/** 只看最近 N 次 L1 评分（时间正序取尾部；与 CrossTrackService 的窗口语义一致）。 */
export const SUGGESTION_RECENT_WINDOW = 3;

/** 他书 L2 视为"已掌握"的 retrievability 下限（与 L2 desired_retention = 0.90 同水位）。 */
export const OTHER_MASTERED_RETRIEVABILITY = 0.9;

/** 他书 L2 视为"记忆已明显衰减"的 retrievability 上限（低于此值不算可复用状态）。 */
export const OTHER_WEAK_RETRIEVABILITY = 0.7;

/** L2 产出步自评标记（非 FSRS 字段，DB: l2_production_status）。 */
export const L2_PRODUCTION_PASSED = "passed";
export const L2_PRODUCTION_WEAK = "weak";

const L2_STATE_REVIEW = "review";
const RELEARNING_STATE = "relearning";
const RATING_AGAIN = "again";
const GOOD_OR_BETTER: ReadonlySet<string> = new Set(["good", "easy"]);

function recentWindow(ratings: string[]): string[] {
  return ratings.slice(-SUGGESTION_RECENT_WINDOW);
}

/** 窗口内最后一次评分；窗口为空返回 null（零证据）。 */
function lastRating(ratings: string[]): string | null {
  const window = recentWindow(ratings);
  return window.length > 0 ? window[window.length - 1] : null;
}

function allGoodOrBetter(ratings: string[]): boolean {
  const window = recentWindow(ratings);
  return window.length > 0 && window.every((rating) => GOOD_OR_BETTER.has(rating));
}

/** R3 判据：他书该行是否给出可复用的掌握状态。 */
function isMastered(l2: OtherBookL2Signal): boolean {
  if (l2.state !== L2_STATE_REVIEW) return false;
  if (l2.l2ProductionStatus === L2_PRODUCTION_WEAK) return false;
  return (
    (l2.retrievability ?? 0) >= OTHER_MASTERED_RETRIEVABILITY ||
    l2.l2ProductionStatus === L2_PRODUCTION_PASSED
  );
}

/** R2 判据：他书该行是否给出"频繁 again"的代理性不稳定证据。 */
function isStruggling(l2: OtherBookL2Signal): boolean {
  if (l2.l2ProductionStatus === L2_PRODUCTION_WEAK) return true;
  if (l2.state === RELEARNING_STATE) return true;
  return l2.retrievability !== null && l2.retrievability < OTHER_WEAK_RETRIEVABILITY;
}

/**
 * 计算升级建议档位。同输入恒同输出（无随机、无时间、无 IO）。
 */
export function computeUpgradeSuggestion(input: UpgradeSuggestionInput): UpgradeSuggestionLevel {
  const { currentBookL1, otherBooksL2 } = input;

  // R1 / R3 判据先各自算清：R2 依赖"全无掌握"这一前提。
  const currentBookStruggling =
    lastRating(currentBookL1.recentRatings) === RATING_AGAIN ||
    currentBookL1.state === RELEARNING_STATE;
  const mastered = otherBooksL2.some(isMastered);
  const otherBooksStruggling = !mastered && otherBooksL2.some(isStruggling);

  if (currentBookStruggling || otherBooksStruggling) return "needs_settling";
  if (mastered) return "strong";
  if (allGoodOrBetter(currentBookL1.recentRatings)) return "normal";
  return "needs_settling";
}
