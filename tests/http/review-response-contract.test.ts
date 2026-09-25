import { describe, expect, it } from "vitest";
import {
  reviewAnswerResponseSchema,
  reviewDashboardStatsResponseSchema,
  reviewQueueResponseSchema,
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
      l2: { promoted: 6, dueNow: 4, weakSignal: 1, reviewedToday: 4 },
    } as const;

    expect(reviewDashboardStatsResponseSchema.parse(response)).toEqual(response);
    const { streakDays: _streak, ...missingStreak } = response;
    expect(() => reviewDashboardStatsResponseSchema.parse(missingStreak)).toThrow();
    expect(() => reviewDashboardStatsResponseSchema.parse({ ...response, extra: true })).toThrow();
    expect(() => reviewDashboardStatsResponseSchema.parse({ ...response, ratingDist: { ...response.ratingDist, medium: 1 } })).toThrow();
    expect(() => reviewDashboardStatsResponseSchema.parse({ ...response, forecast: { ...response.forecast, due3d: 30 } })).toThrow();
  });

  it("parses the queue response with hint ladder word fields (T3, 2026-09-25)", () => {
    const response = {
      items: [{
        progressId: "p1",
        word: {
          id: "w1", slug: "alleviate", title: "Alleviate", lemma: "alleviate",
          short_definition: "减轻", ipa: null, pos: "verb", cefr: "C1",
          examples: [{ text: "The drug alleviates the pain." }],
          prototype_text: "alleviate = 一只手把重物缓缓放下的画面",
          mnemonic_text: "al+lev（举）+iate → 把负担举走",
          mnemonic_type: "etymology",
          semantic_chain: "lev轻->relieve缓解->alleviate减轻",
        },
        state: "review",
        dueAt: null,
        lastRating: "good",
        reviewCount: 3,
        stability: null,
        note_entries: [],
        l3_contexts: [],
      }],
      session: { id: "s1", mode: "review", cardsSeen: 0 },
      stats: { total: 1, remaining: 1 },
      hasMore: false,
    } as const;

    expect(reviewQueueResponseSchema.parse(response)).toEqual(response);

    // strict：word 缺 hint 字段（旧响应形态）→ 拒绝
    const { examples: _ex, prototype_text: _pt, mnemonic_text: _mt, mnemonic_type: _mty, semantic_chain: _sc, ...legacyWord } = response.items[0].word;
    expect(() => reviewQueueResponseSchema.parse({
      ...response,
      items: [{ ...response.items[0], word: legacyWord }],
    })).toThrow();

    // examples 非数组 → 拒绝
    expect(() => reviewQueueResponseSchema.parse({
      ...response,
      items: [{ ...response.items[0], word: { ...response.items[0].word, examples: "not-array" } }],
    })).toThrow();
  });
});
