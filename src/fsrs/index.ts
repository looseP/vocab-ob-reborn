/**
 * FSRS 核心模块 barrel —— 自包含的间隔重复调度计算。
 *
 * 只依赖 ts-fsrs + 本目录类型，不依赖 DB/business/local。
 * 从 local lib/review/fsrs-adapter.ts 复制并清理依赖而来。
 */
export type {
  ReviewRating,
  ReviewState,
  StoredSchedulerCard,
  SchedulerUpdate,
} from "./types";

export {
  DEFAULT_DESIRED_RETENTION,
  MIN_DESIRED_RETENTION,
  MAX_DESIRED_RETENTION,
  SCHEDULER_CACHE_LIMIT,
  getSchedulerCacheSize,
  normalizeDesiredRetention,
  buildInitialSchedulerPayload,
  getCurrentRetrievability,
  applyReviewAnswer,
} from "./adapter";
