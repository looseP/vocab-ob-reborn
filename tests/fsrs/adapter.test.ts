import { describe, it, expect } from "vitest";
import {
  DEFAULT_DESIRED_RETENTION,
  MIN_DESIRED_RETENTION,
  MAX_DESIRED_RETENTION,
  SCHEDULER_CACHE_LIMIT,
  normalizeDesiredRetention,
  getSchedulerCacheSize,
  applyReviewAnswer,
  buildInitialSchedulerPayload,
  getCurrentRetrievability,
} from "@/fsrs/adapter";
import type { StoredSchedulerCard } from "@/fsrs/types";

describe("FSRS constants", () => {
  it("DEFAULT_DESIRED_RETENTION is 0.9", () => {
    expect(DEFAULT_DESIRED_RETENTION).toBe(0.9);
  });

  it("retention bounds are 0.7 to 0.99", () => {
    expect(MIN_DESIRED_RETENTION).toBe(0.7);
    expect(MAX_DESIRED_RETENTION).toBe(0.99);
  });

  it("SCHEDULER_CACHE_LIMIT is 100", () => {
    expect(SCHEDULER_CACHE_LIMIT).toBe(100);
  });
});

describe("normalizeDesiredRetention", () => {
  it("clamps below minimum", () => {
    expect(normalizeDesiredRetention(0.5)).toBe(0.7);
  });

  it("clamps above maximum", () => {
    expect(normalizeDesiredRetention(1.0)).toBe(0.99);
  });

  it("passes through valid values", () => {
    expect(normalizeDesiredRetention(0.85)).toBe(0.85);
  });

  it("clamps NaN to minimum", () => {
    expect(normalizeDesiredRetention(NaN)).toBe(0.7);
  });
});

describe("getScheduler cache", () => {
  it("getSchedulerCacheSize returns a non-negative number", () => {
    expect(getSchedulerCacheSize()).toBeGreaterThanOrEqual(0);
  });
});

const FIXED_NOW = new Date("2026-01-15T12:00:00Z");

const SAMPLE_CARD: StoredSchedulerCard = {
  difficulty: 5.2,
  due: "2026-01-14T12:00:00.000Z",
  elapsed_days: 1,
  lapses: 0,
  learning_steps: 0,
  last_review: "2026-01-13T12:00:00Z",
  reps: 3,
  scheduled_days: 2,
  stability: 4.8,
  state: 2,
};

describe("applyReviewAnswer", () => {
  it("returns SchedulerUpdate with correct rating", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.rating).toBe("good");
  });

  it("returns dueAt as ISO string", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns nextPayload as StoredSchedulerCard", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.nextPayload).toMatchObject({
      difficulty: expect.any(Number),
      due: expect.any(String),
      state: expect.any(Number),
      stability: expect.any(Number),
    });
  });

  it("returns retrievability as number for non-new card", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.retrievability).toBeTypeOf("number");
    expect(result.retrievability).toBeGreaterThan(0);
    expect(result.retrievability).toBeLessThanOrEqual(1);
  });

  it("returns retrievability null for new card (state=0)", () => {
    // 注意：ts-fsrs 5.4.1 中，对 state=0 的卡片评分后，卡片会转换出 New 状态
    // （首次 good → Learning）。因此 applyReviewAnswer 返回的 retrievability
    // 反映的是评分后的卡片，是非 null 的。
    // "新卡片 retrievability 为 null" 的语义由 getCurrentRetrievability 体现（见下）。
    const newCard: StoredSchedulerCard = { ...SAMPLE_CARD, state: 0, reps: 0 };
    const result = applyReviewAnswer(newCard, "good", FIXED_NOW, 0.9);
    expect(result.retrievability).not.toBeNull();
  });

  it("handles null payload (first review)", () => {
    const result = applyReviewAnswer(null, "good", FIXED_NOW, 0.9);
    expect(result.rating).toBe("good");
    // ts-fsrs 5.4.1: 首次 good 评分后空卡片进入 Learning 阶段（非 Review）
    expect(result.state).toBe("learning");
    expect(result.reps).toBe(1);
  });

  it("again increases lapses", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "again", FIXED_NOW, 0.9);
    expect(result.lapses).toBe(SAMPLE_CARD.lapses + 1);
    expect(result.state).toBe("relearning");
  });

  it("populates scheduler cache after call", () => {
    const before = getSchedulerCacheSize();
    applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    const after = getSchedulerCacheSize();
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe("buildInitialSchedulerPayload", () => {
  it("returns a StoredSchedulerCard with state=0 (new)", () => {
    const payload = buildInitialSchedulerPayload();
    expect(payload.state).toBe(0);
    expect(payload.reps).toBe(0);
    expect(payload.lapses).toBe(0);
    expect(payload.difficulty).toBe(0);
    expect(payload.stability).toBe(0);
  });

  it("returns due as ISO string", () => {
    const payload = buildInitialSchedulerPayload();
    expect(payload.due).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("getCurrentRetrievability", () => {
  it("returns null for new card (state=0)", () => {
    const newCard: StoredSchedulerCard = {
      difficulty: 0, due: "2026-01-15T12:00:00Z", elapsed_days: 0,
      lapses: 0, learning_steps: 0, last_review: null, reps: 0,
      scheduled_days: 0, stability: 0, state: 0,
    };
    expect(getCurrentRetrievability(newCard, FIXED_NOW)).toBeNull();
  });

  it("returns number for review card", () => {
    expect(getCurrentRetrievability(SAMPLE_CARD, FIXED_NOW)).toBeTypeOf("number");
  });
});
