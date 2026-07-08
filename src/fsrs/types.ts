/**
 * FSRS 核心类型 —— 自包含，不依赖 DB schema 或业务类型。
 * 从 local lib/review/types.ts 精简而来，删除所有业务类型。
 */

export type ReviewRating = "again" | "hard" | "good" | "easy";

export type ReviewState = "new" | "learning" | "review" | "relearning";

/**
 * ts-fsrs Card 的可序列化快照。
 * Date 字段转成 string（ISO），state 用 number（而非 State enum）。
 * 这是存进 DB jsonb 的格式。
 */
export interface StoredSchedulerCard {
  difficulty: number;
  due: string;
  elapsed_days: number;
  lapses: number;
  learning_steps: number;
  last_review: string | null;
  reps: number;
  scheduled_days: number;
  stability: number;
  state: number;
}

/**
 * applyReviewAnswer 的返回值。
 * 包含更新后的卡片状态（nextPayload）+ 调度元数据。
 */
export interface SchedulerUpdate {
  difficulty: number;
  dueAt: string;
  elapsedDays: number;
  lapses: number;
  logDueAt: string;
  nextPayload: StoredSchedulerCard;
  rating: ReviewRating;
  reps: number;
  retrievability: number | null;
  scheduledDays: number;
  stability: number;
  state: ReviewState;
}
