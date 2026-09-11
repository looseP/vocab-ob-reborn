import { describe, expect, it } from "vitest";
import {
  l3SessionContextSummaryResponseSchema,
  l3SessionRenderDescriptionResponseSchema,
  l3SessionRowResponseSchema,
} from "../../src/http/l3-session-response-contract";

function session() {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    user_id: "user-123",
    type: "l3_practice" as const,
    title: null,
    plan: { version: 1, days: 1, seed: "seed-1", items: [{ day: 1, contextIds: ["ctx-1"] }] },
    version: 1,
    status: "active" as const,
    started_at: "2026-09-11T00:00:00.000Z",
    ended_at: null,
    created_at: "2026-09-11T00:00:00.000Z",
  };
}

const CONTEXT_SUMMARY = {
  id: "ctx-1",
  text: "A vivid context.",
  context_type: "sentence" as const,
  source_id: "src-1",
  source_title: "Essay",
};

describe("L3 session response contracts", () => {
  it("parses the exact session row", () => {
    const row = session();
    expect(l3SessionRowResponseSchema.parse(row)).toEqual(row);

    expect(() => l3SessionRowResponseSchema.parse({ ...row, type: "bogus" })).toThrow();
    expect(() => l3SessionRowResponseSchema.parse({ ...row, status: "bogus" })).toThrow();
    expect(() => l3SessionRowResponseSchema.parse({ ...row, version: "1" })).toThrow();
    const { plan: _plan, ...missingPlan } = row;
    expect(() => l3SessionRowResponseSchema.parse(missingPlan)).toThrow();
    expect(() => l3SessionRowResponseSchema.parse({ ...row, html: "<p/>" })).toThrow();
  });

  it("parses the exact context summary", () => {
    expect(l3SessionContextSummaryResponseSchema.parse(CONTEXT_SUMMARY)).toEqual(CONTEXT_SUMMARY);
    expect(() => l3SessionContextSummaryResponseSchema.parse({ ...CONTEXT_SUMMARY, context_type: "bogus" })).toThrow();
    const { source_title: _title, ...missingTitle } = CONTEXT_SUMMARY;
    expect(() => l3SessionContextSummaryResponseSchema.parse(missingTitle)).toThrow();
  });

  it("parses the exact render description", () => {
    const response = { session: session(), items: [{ day: 1, contexts: [CONTEXT_SUMMARY] }] };
    expect(l3SessionRenderDescriptionResponseSchema.parse(response)).toEqual(response);

    expect(() => l3SessionRenderDescriptionResponseSchema.parse({ ...response, items: [{ day: 1.5, contexts: [] }] })).toThrow();
    expect(() => l3SessionRenderDescriptionResponseSchema.parse({ ...response, items: [{ day: 1, contexts: [], extra: true }] })).toThrow();
    expect(() => l3SessionRenderDescriptionResponseSchema.parse({ render: response.items })).toThrow();
    expect(() => l3SessionRenderDescriptionResponseSchema.parse({
      ...response,
      items: [{ day: 1, contexts: [{ ...CONTEXT_SUMMARY, context_type: "bogus" }] }],
    })).toThrow();
  });
});
