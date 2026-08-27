import { describe, expect, it } from "vitest";
import {
  reviewAnswerResponseSchema,
  reviewDashboardStatsResponseSchema,
  reviewSimpleResponseSchema,
} from "../../src/http/review-response-contract";

describe("Review response contracts", () => {
  it("parses the exact submitAnswer response", () => {
    const response = {
      ok: true,
      reviewLogId: "11111111-1111-4111-8111-111111111111",
      nextDueAt: "2026-07-14T00:00:00.000Z",
      state: "review",
    } as const;

    expect(reviewAnswerResponseSchema.parse(response)).toEqual(response);
    expect(() => reviewAnswerResponseSchema.parse({ ...response, ok: false })).toThrow();
    expect(() => reviewAnswerResponseSchema.parse({ ...response, reviewLogId: "log-1" })).toThrow();
    expect(() => reviewAnswerResponseSchema.parse({ ...response, nextDueAt: "tomorrow" })).toThrow();
    expect(() => reviewAnswerResponseSchema.parse({ ...response, state: "Review" })).toThrow();
    const { reviewLogId: _id, ...missing } = response;
    expect(() => reviewAnswerResponseSchema.parse(missing)).toThrow();
    expect(() => reviewAnswerResponseSchema.parse({ ...response, extra: true })).toThrow();
  });

  it("parses the idempotent submitAnswer response", () => {
    const response = {
      ok: true,
      idempotent: true,
      reviewLogId: "11111111-1111-4111-8111-111111111111",
    } as const;
    expect(reviewAnswerResponseSchema.parse(response)).toEqual(response);
    expect(() => reviewAnswerResponseSchema.parse({ ...response, idempotent: false })).toThrow();
  });

  it("parses skip/suspend/undo simple responses", () => {
    const ok = { ok: true };
    const idempotent = { ok: true, idempotent: true };

    expect(reviewSimpleResponseSchema.parse(ok)).toEqual(ok);
    expect(reviewSimpleResponseSchema.parse(idempotent)).toEqual(idempotent);
    expect(() => reviewSimpleResponseSchema.parse({ ok: false })).toThrow();
    expect(() => reviewSimpleResponseSchema.parse({ ok: true, idempotent: false })).toThrow();
    expect(() => reviewSimpleResponseSchema.parse({ ok: true, extra: true })).toThrow();
    const { ok: _ok } = ok;
    expect(() => reviewSimpleResponseSchema.parse({})).toThrow();
  });

  it("parses the exact dashboard stats response", () => {
    const response = {
      totalWords: 100,
      trackedWords: 40,
      dueToday: 12,
      reviewedToday: 5,
      reviewed7d: 30,
      reviewed30d: 80,
      streakDays: 3,
      notesCount: 7,
      ratingDist: { again: 2, hard: 3, good: 20, easy: 10 },
      forecast: { dueNow: 12, due7d: 18, due14d: 24 },
    } as const;

    expect(reviewDashboardStatsResponseSchema.parse(response)).toEqual(response);
    const { streakDays: _streak, ...missingStreak } = response;
    expect(() => reviewDashboardStatsResponseSchema.parse(missingStreak)).toThrow();
    expect(() => reviewDashboardStatsResponseSchema.parse({ ...response, extra: true })).toThrow();
    expect(() => reviewDashboardStatsResponseSchema.parse({ ...response, ratingDist: { ...response.ratingDist, medium: 1 } })).toThrow();
    expect(() => reviewDashboardStatsResponseSchema.parse({ ...response, forecast: { ...response.forecast, due3d: 30 } })).toThrow();
  });
});
