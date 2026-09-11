import { describe, expect, it } from "vitest";
import {
  l3PracticeAttemptPageResponseSchema,
  l3PracticeAttemptRowResponseSchema,
} from "../../src/http/l3-practice-response-contract";

function attempt() {
  return {
    id: "attempt-1",
    user_id: "user-123",
    context_id: "00000000-0000-4000-8000-000000000002",
    occurrence_id: null,
    session_id: null,
    practice_type: "context_quiz" as const,
    outcome: "correct" as const,
    payload: { taskId: "context_quiz:abc123", hidden: true, nested: [1, "two", null] },
    created_at: "2026-09-11T00:00:00.000Z",
  };
}

describe("L3 practice response contracts", () => {
  it("parses the exact attempt row shape", () => {
    const row = attempt();
    expect(l3PracticeAttemptRowResponseSchema.parse(row)).toEqual(row);

    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, practice_type: "bogus" })).toThrow();
    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, outcome: "bogus" })).toThrow();
    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, occurrence_id: 7 })).toThrow();
    const { payload: _payload, ...missingPayload } = row;
    expect(() => l3PracticeAttemptRowResponseSchema.parse(missingPayload)).toThrow();
    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, extra: true })).toThrow();
  });

  it("keeps FSRS out of the attempt contract", () => {
    const row = attempt();
    // "L3 有记录、无调度"：任何 FSRS 字段都必须被 .strict() 拒绝。
    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, stability: 3.5 })).toThrow();
    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, due: "2026-10-01T00:00:00.000Z" })).toThrow();
    expect(() => l3PracticeAttemptRowResponseSchema.parse({ ...row, retrievability: 0.9 })).toThrow();
  });

  it("parses the exact offset page", () => {
    const response = { items: [attempt()], total: 1, limit: 20, offset: 0 };
    expect(l3PracticeAttemptPageResponseSchema.parse(response)).toEqual(response);

    expect(() => l3PracticeAttemptPageResponseSchema.parse({ ...response, total: -1 })).toThrow();
    expect(() => l3PracticeAttemptPageResponseSchema.parse({ ...response, limit: 0 })).toThrow();
    expect(() => l3PracticeAttemptPageResponseSchema.parse({ ...response, offset: -1 })).toThrow();
    expect(() => l3PracticeAttemptPageResponseSchema.parse({ ...response, limit: 1.5 })).toThrow();
    expect(() => l3PracticeAttemptPageResponseSchema.parse({ ...response, hasMore: false })).toThrow();
  });
});
