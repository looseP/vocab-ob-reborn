/**
 * FSRS 核心计算 —— 从 local lib/review/fsrs-adapter.ts 复制，清理 local 依赖。
 * 自包含：只依赖 ts-fsrs + 本目录 types。
 */
import { createEmptyCard, fsrs, Rating, State, type Card } from "ts-fsrs";
import type { ReviewRating, ReviewState, StoredSchedulerCard, SchedulerUpdate } from "@/fsrs/types";

// ── 常量 ──────────────────────────────────────────────────────────────────────

export const DEFAULT_DESIRED_RETENTION = 0.9;
export const MIN_DESIRED_RETENTION = 0.7;
export const MAX_DESIRED_RETENTION = 0.99;
export const SCHEDULER_CACHE_LIMIT = 100;

// ── 评级映射 ──────────────────────────────────────────────────────────────────

const ratingMap: Record<ReviewRating, 1 | 2 | 3 | 4> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const reviewStateMap: Record<number, ReviewState> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

// ── 工具函数 ──────────────────────────────────────────────────────────────────

export function normalizeDesiredRetention(value: number): number {
  if (Number.isNaN(value)) return MIN_DESIRED_RETENTION;
  return Math.max(MIN_DESIRED_RETENTION, Math.min(MAX_DESIRED_RETENTION, value));
}

// ── Card 转换（内部函数，不 export）──────────────────────────────────────────

function toCard(payload: StoredSchedulerCard | null | undefined): Card {
  if (!payload) return createEmptyCard();

  try {
    const state = typeof payload.state === "number" ? payload.state : 0;
    const difficulty = Number.isFinite(payload.difficulty) ? payload.difficulty : 0;
    const stability = Number.isFinite(payload.stability) ? payload.stability : 0;

    const due = new Date(payload.due);
    if (Number.isNaN(due.getTime())) return createEmptyCard();

    const lastReview = payload.last_review ? new Date(payload.last_review) : undefined;
    if (lastReview && Number.isNaN(lastReview.getTime())) return createEmptyCard();

    return {
      due,
      stability,
      difficulty,
      elapsed_days: payload.elapsed_days ?? 0,
      scheduled_days: payload.scheduled_days ?? 0,
      reps: payload.reps ?? 0,
      lapses: payload.lapses ?? 0,
      state,
      last_review: lastReview,
      learning_steps: payload.learning_steps ?? 0,
    };
  } catch {
    return createEmptyCard();
  }
}

function fromCard(card: Card): StoredSchedulerCard {
  return {
    difficulty: card.difficulty,
    due: card.due.toISOString(),
    elapsed_days: card.elapsed_days,
    lapses: card.lapses,
    learning_steps: card.learning_steps ?? 0,
    last_review: card.last_review ? card.last_review.toISOString() : null,
    reps: card.reps,
    scheduled_days: card.scheduled_days,
    stability: card.stability,
    state: card.state,
  };
}

// ── scheduler 缓存 ────────────────────────────────────────────────────────────

const schedulerCache = new Map<string, ReturnType<typeof fsrs>>();

function signWeights(weights?: readonly number[] | null): string {
  if (!weights || weights.length === 0) return "default";
  return weights.map((w) => w.toFixed(6)).join(",");
}

export function getSchedulerCacheSize(): number {
  return schedulerCache.size;
}

function getScheduler(
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights?: readonly number[] | null,
): ReturnType<typeof fsrs> {
  const normalizedRetention = normalizeDesiredRetention(desiredRetention);
  const rounded = Number(normalizedRetention.toFixed(3));
  const cacheKey = `${rounded}|${signWeights(weights)}`;
  const cached = schedulerCache.get(cacheKey);

  if (cached) {
    // LRU refresh
    schedulerCache.delete(cacheKey);
    schedulerCache.set(cacheKey, cached);
    return cached;
  }

  const scheduler = fsrs({
    maximum_interval: 36500,
    request_retention: rounded,
    ...(weights && weights.length > 0 ? { w: [...weights] } : {}),
  });

  if (schedulerCache.size >= SCHEDULER_CACHE_LIMIT) {
    const oldestKey = schedulerCache.keys().next().value;
    if (oldestKey !== undefined) {
      schedulerCache.delete(oldestKey);
    }
  }
  schedulerCache.set(cacheKey, scheduler);
  return scheduler;
}

// ── 核心函数 ──────────────────────────────────────────────────────────────────

export function applyReviewAnswer(
  payload: StoredSchedulerCard | null | undefined,
  rating: ReviewRating,
  now = new Date(),
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights?: readonly number[] | null,
): SchedulerUpdate {
  const scheduler = getScheduler(desiredRetention, weights);
  const currentCard = toCard(payload);
  const result = scheduler.next(currentCard, now, ratingMap[rating]);
  const retrievability =
    result.card.state === State.New
      ? null
      : scheduler.get_retrievability(result.card, now, false);

  return {
    difficulty: result.card.difficulty,
    dueAt: result.card.due.toISOString(),
    elapsedDays: result.log.elapsed_days,
    lapses: result.card.lapses,
    logDueAt: result.log.due.toISOString(),
    nextPayload: fromCard(result.card),
    rating,
    reps: result.card.reps,
    retrievability,
    scheduledDays: result.log.scheduled_days,
    stability: result.card.stability,
    state: reviewStateMap[result.card.state] ?? "review",
  };
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

export function buildInitialSchedulerPayload(): StoredSchedulerCard {
  const card = createEmptyCard();
  return fromCard(card);
}

export function getCurrentRetrievability(
  payload: StoredSchedulerCard | null | undefined,
  now = new Date(),
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights?: readonly number[] | null,
): number | null {
  if (!payload || payload.state === State.New) return null;
  const scheduler = getScheduler(desiredRetention, weights);
  const card = toCard(payload);
  if (card.state === State.New) return null;
  return scheduler.get_retrievability(card, now, false);
}
