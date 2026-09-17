import { describe, expect, it } from "vitest";
import {
  upgradeWorkOrderCompleteResponseSchema,
  upgradeWorkOrderListItemResponseSchema,
  upgradeWorkOrderListResponseSchema,
  upgradeWorkOrderMarkResponseSchema,
  upgradeWorkOrderRowResponseSchema,
} from "../../src/http/upgrade-work-order-response-contract";

function workOrder() {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    user_id: "user-123",
    word_id: "44444444-4444-4444-8444-444444444444",
    wordbook_id: "33333333-3333-4333-8333-333333333333",
    direction: "通用" as const,
    status: "标记中" as const,
    suggestion_snapshot: { level: "normal", capturedAt: "2026-09-11T00:00:00.000Z" },
    created_at: "2026-09-11T00:00:00.000Z",
    updated_at: "2026-09-11T00:00:00.000Z",
    completed_at: null,
  };
}

const SNAPSHOT = {
  level: "normal" as const,
  currentBookL1: { recentRatings: ["good", "easy"], state: "review" },
  otherBooksL2: [{ state: "review", retrievability: 0.93, l2ProductionStatus: "passed" }],
  capturedAt: "2026-09-11T00:00:00.000Z",
};

describe("upgrade work order response contracts", () => {
  it("parses the exact row shape", () => {
    const row = workOrder();
    expect(upgradeWorkOrderRowResponseSchema.parse(row)).toEqual(row);

    const { completed_at: _completedAt, ...missingCompletedAt } = row;
    expect(() => upgradeWorkOrderRowResponseSchema.parse(missingCompletedAt)).toThrow();
    expect(() => upgradeWorkOrderRowResponseSchema.parse({ ...row, extra: true })).toThrow();
    expect(() => upgradeWorkOrderRowResponseSchema.parse({ ...row, created_at: 1 })).toThrow();
    expect(() => upgradeWorkOrderRowResponseSchema.parse({ ...row, direction: "bogus" })).toThrow();
    expect(() => upgradeWorkOrderRowResponseSchema.parse({ ...row, status: "bogus" })).toThrow();
    expect(() => upgradeWorkOrderRowResponseSchema.parse({ ...row, suggestion_snapshot: undefined })).toThrow();
    expect(upgradeWorkOrderRowResponseSchema.parse({ ...row, suggestion_snapshot: null })).toEqual({
      ...row,
      suggestion_snapshot: null,
    });
  });

  it("parses the exact mark response", () => {
    const response = { workOrder: workOrder(), suggestion: "normal" as const, suggestionSnapshot: SNAPSHOT };
    expect(upgradeWorkOrderMarkResponseSchema.parse(response)).toEqual(response);

    expect(() => upgradeWorkOrderMarkResponseSchema.parse({ ...response, suggestion: "bogus" })).toThrow();
    expect(() => upgradeWorkOrderMarkResponseSchema.parse({ ...response, suggestion_snapshot: SNAPSHOT })).toThrow();
    const { suggestionSnapshot: _snapshot, ...missingSnapshot } = response;
    expect(() => upgradeWorkOrderMarkResponseSchema.parse(missingSnapshot)).toThrow();
  });

  it("parses the exact list envelope with word surface and suggestion", () => {
    const item = {
      ...workOrder(),
      word: { slug: "comprehend", text: "comprehend" },
      suggestion: "normal" as const,
    };
    const response = { items: [item] };
    expect(upgradeWorkOrderListResponseSchema.parse(response)).toEqual(response);
    expect(upgradeWorkOrderListItemResponseSchema.parse(item)).toEqual(item);
    expect(() => upgradeWorkOrderListResponseSchema.parse({ ...response, total: 1 })).toThrow();
    expect(() => upgradeWorkOrderListResponseSchema.parse({ rows: response.items })).toThrow();
    // 词面如实为 nullable（LEFT JOIN 语义），且是必填键而非可选。
    const nullWord = { ...item, word: { slug: null, text: null } };
    expect(upgradeWorkOrderListItemResponseSchema.parse(nullWord)).toEqual(nullWord);
    expect(() => upgradeWorkOrderListItemResponseSchema.parse({ ...item, suggestion: "bogus" })).toThrow();
    expect(() => upgradeWorkOrderListItemResponseSchema.parse({ ...item, word: undefined })).toThrow();
    // 行契约不受 list 扩展影响（mark/start/cancel/complete 仍返回纯行）。
    expect(upgradeWorkOrderRowResponseSchema.parse(workOrder())).toEqual(workOrder());
    expect(() => upgradeWorkOrderRowResponseSchema.parse({ ...workOrder(), word: item.word })).toThrow();
  });

  it("parses the exact complete response", () => {
    const response = {
      workOrder: { ...workOrder(), status: "已完成" as const },
      alreadyPromoted: false,
      l2DueAt: "2026-10-01T00:00:00.000Z",
      seeded: true,
    };
    expect(upgradeWorkOrderCompleteResponseSchema.parse(response)).toEqual(response);
    expect(upgradeWorkOrderCompleteResponseSchema.parse({ ...response, l2DueAt: null })).toEqual({
      ...response,
      l2DueAt: null,
    });
    expect(() => upgradeWorkOrderCompleteResponseSchema.parse({ ...response, seeded: "yes" })).toThrow();
    const { seeded: _seeded, ...missingSeeded } = response;
    expect(() => upgradeWorkOrderCompleteResponseSchema.parse(missingSeeded)).toThrow();
  });
});
