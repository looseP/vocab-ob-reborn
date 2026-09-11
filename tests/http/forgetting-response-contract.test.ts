import { describe, expect, it } from "vitest";
import {
  forgettingApplyResponseSchema,
  forgettingPreviewResponseSchema,
  forgettingRestoreResponseSchema,
} from "../../src/http/forgetting-response-contract";

describe("forgetting response contracts", () => {
  it("parses the exact preview", () => {
    const response = { anchors: ["w-1", "w-2"], suspendCount: 12 };
    expect(forgettingPreviewResponseSchema.parse(response)).toEqual(response);

    expect(() => forgettingPreviewResponseSchema.parse({ ...response, suspendCount: -1 })).toThrow();
    expect(() => forgettingPreviewResponseSchema.parse({ ...response, suspendCount: 1.5 })).toThrow();
    expect(() => forgettingPreviewResponseSchema.parse({ anchors: [1] })).toThrow();
    const { suspendCount: _suspendCount, ...missingCount } = response;
    expect(() => forgettingPreviewResponseSchema.parse(missingCount)).toThrow();
    expect(() => forgettingPreviewResponseSchema.parse({ ...response, extra: true })).toThrow();
  });

  it("parses the exact apply result", () => {
    const response = {
      batchId: "66666666-6666-4666-8666-666666666666",
      suspendedCount: 12,
      pausedCount: 3,
      anchors: ["w-1"],
    };
    expect(forgettingApplyResponseSchema.parse(response)).toEqual(response);

    expect(() => forgettingApplyResponseSchema.parse({ ...response, pausedCount: -1 })).toThrow();
    expect(() => forgettingApplyResponseSchema.parse({ ...response, batch_id: response.batchId })).toThrow();
    const { anchors: _anchors, ...missingAnchors } = response;
    expect(() => forgettingApplyResponseSchema.parse(missingAnchors)).toThrow();
  });

  it("parses the exact restore result", () => {
    const response = { restoredCount: 12, unpausedCount: 3 };
    expect(forgettingRestoreResponseSchema.parse(response)).toEqual(response);

    expect(() => forgettingRestoreResponseSchema.parse({ ...response, restoredCount: "12" })).toThrow();
    expect(() => forgettingRestoreResponseSchema.parse({ restored: 12 })).toThrow();
    expect(() => forgettingRestoreResponseSchema.parse({ ...response, extra: true })).toThrow();
  });
});
