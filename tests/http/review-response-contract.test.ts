import { describe, expect, it } from "vitest";
import {
  reviewAnswerResponseSchema,
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
});
