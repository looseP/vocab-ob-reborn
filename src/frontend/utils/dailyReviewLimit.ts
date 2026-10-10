/**
 * 每日复习上限（2026-10-10 接线）。
 *
 * 此前这个设置是**纯摆设**：设置页能拖滑块、能保存进 localStorage，但全仓库
 * 没有任何代码读它 —— 拖到 10 与拖到 200 的行为完全一样，「每日复习上限」从未
 * 拦过任何一张卡。本模块把它接成真正的「续载闸门」：
 *
 *  - 复习会话在**今日累计评分**达到上限后，停止**自动续卡**（不再自动拉下一页）；
 *  - 复习页给出提示与两条出路：继续复习（本次会话内冲刺越过）/ 去设置调整上限。
 *
 * 语义边界（刻意为之）：
 *  - 它是**软上限**：已加载进队列的卡照常复习完，绝不打断当前这张；
 *    拦的只是「自动加载下一页」。
 *  - 冲刺是明示动作：点「继续复习（冲刺）」即在本次会话内越过上限，不必改设置。
 *  - `0` = 不限（给长期冲刺档留的常驻值，设置页设为「不限」时写入 0）。
 *  - 计数按**本地日历日**累计（存储键带日期）。多设备/清缓存会漂移 —— 这是本地
 *    偏好；权威的「今日已复习」在服务端（仪表盘 reviewedToday），两者允许不一致。
 */
export const DAILY_REVIEW_LIMIT_KEY = "vocab-daily-limit";
export const DAILY_REVIEWED_KEY_PREFIX = "vocab-daily-reviewed";
export const DEFAULT_DAILY_REVIEW_LIMIT = 200;
/** 设置页滑块上限：冲刺期上千张的需求（上限 200 的时代在这里被打破）。 */
export const MAX_DAILY_REVIEW_LIMIT = 2000;

/**
 * 新词通道的每日上限（2026-10-10 隔离）。
 *
 * 与复习上限**独立设置、独立计数** —— 学新词不该消耗复习额度，反之亦然。
 * 默认 20：一次学 20 个新词是认知负荷的上限（远超这个量，第二天多半忘了大半）。
 * `0` = 不限（冲刺期可临时放开）。
 */
export const DAILY_NEW_WORD_LIMIT_KEY = "vocab-daily-new-word-limit";
export const DEFAULT_DAILY_NEW_WORD_LIMIT = 20;
export const MAX_DAILY_NEW_WORD_LIMIT = 200;

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 解析设置值。规则：
 *  - null / 非数字 / 负数 → 默认 200（不放任脏数据把闸门关掉）
 *  - 0 → 不限（唯一表示「不限」的值）
 *  - 其他 → 向下取整，封顶 MAX_DAILY_REVIEW_LIMIT
 */
export function parseDailyReviewLimit(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DAILY_REVIEW_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DAILY_REVIEW_LIMIT;
  return Math.min(Math.floor(parsed), MAX_DAILY_REVIEW_LIMIT);
}

export function readDailyReviewLimit(): number {
  return parseDailyReviewLimit(safeStorage()?.getItem(DAILY_REVIEW_LIMIT_KEY));
}

/**
 * 解析新词通道上限。与复习上限同纪律：脏数据一律回落默认 200→20，
 * 不放任一个坏值把闸门永久关死。
 */
export function parseDailyNewWordLimit(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DAILY_NEW_WORD_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DAILY_NEW_WORD_LIMIT;
  return Math.min(Math.floor(parsed), MAX_DAILY_NEW_WORD_LIMIT);
}

export function readDailyNewWordLimit(): number {
  return parseDailyNewWordLimit(safeStorage()?.getItem(DAILY_NEW_WORD_LIMIT_KEY));
}

export function writeDailyNewWordLimit(value: number): void {
  safeStorage()?.setItem(DAILY_NEW_WORD_LIMIT_KEY, String(parseDailyNewWordLimit(String(value))));
}

export function writeDailyReviewLimit(value: number): void {
  safeStorage()?.setItem(DAILY_REVIEW_LIMIT_KEY, String(parseDailyReviewLimit(String(value))));
}

/** 本地日历日键（"2026-10-10"）—— 计数按此分桶，跨日自动归零。 */
export function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 计数桶（2026-10-10 通道隔离）。
 *
 * **为什么必须分桶**：通道隔离的整个前提是「新学与复习互不挤占」。若两者仍共用一个
 * 计数器，那么学 483 张新词就会把复习额度一并耗尽 —— 早上点开先学了新词，白天再想
 * 复习就被闸门拦住。这正是隔离前那套混流逻辑的病根在限额上的复现。
 *
 * 键形如 `vocab-daily-reviewed:2026-10-10:review` / `:learn`。
 */
export type DailyCountBucket = "review" | "learn";

function countKey(bucket: DailyCountBucket, now: Date): string {
  return `${DAILY_REVIEWED_KEY_PREFIX}:${localDateKey(now)}:${bucket}`;
}

/** 今日某通道已复习张数（本设备口径；跨日或读到旧格式键都视为 0）。 */
export function readDailyReviewedCount(
  now: Date = new Date(),
  bucket: DailyCountBucket = "review",
): number {
  const storage = safeStorage();
  if (!storage) return 0;
  const raw = storage.getItem(countKey(bucket, now));
  const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // 迁移兜底（2026-10-10 分桶时引入）：分桶前的键是 `prefix:<date>`（无桶后缀），
  // 里面装的是**复习**计数。升级当天的用户若不清零，就会「今日已复习 N 张」被读成 0
  // ⇒ 闸门重新打开，今天已经超载也拦不住。读桶键缺失时回落到旧键。
  if (bucket === "review") {
    const legacyRaw = storage.getItem(`${DAILY_REVIEWED_KEY_PREFIX}:${localDateKey(now)}`);
    const legacy = legacyRaw == null ? Number.NaN : Number.parseInt(legacyRaw, 10);
    if (Number.isFinite(legacy) && legacy > 0) return legacy;
  }
  return 0;
}

/** 累加今日某通道已复习张数并返回新值（撤销评分时应传负数回退）。 */
export function addDailyReviewedCount(
  delta: number,
  now: Date = new Date(),
  bucket: DailyCountBucket = "review",
): number {
  // 基底必须走 readDailyReviewedCount（含旧键回落）—— 直接读桶键会让迁移当天的
  // 用户「在旧计数上继续累加」而非接续，等于把旧键的历史丢掉。
  const next = Math.max(0, readDailyReviewedCount(now, bucket) + delta);
  safeStorage()?.setItem(countKey(bucket, now), String(next));
  return next;
}

/** 是否已达上限（0 = 不限，永不达限）。 */
export function isDailyLimitReached(limit: number, reviewedToday: number): boolean {
  return limit > 0 && reviewedToday >= limit;
}

/** 上限文案（设置页与复习页提示共用，避免两处各说各话）。 */
export function formatDailyLimitLabel(limit: number): string {
  return limit > 0 ? `${limit} 张/天` : "不限";
}
