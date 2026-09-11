/**
 * needs_recheck 读时派生（ADR-0021）—— 纯函数契约测试。
 *
 * 覆盖：L1 优先 / 全量降级 / 任一快照缺失不派生 / 相等不派生 / 非十六进制
 * 普通字符串（含中文）也按字符串相等比较。
 */
import { describe, expect, it } from "vitest";
import { deriveContentStaleness } from "@/domain/content-staleness";
import type { ContentStalenessInput } from "@/domain/content-staleness";

function input(overrides: Partial<ContentStalenessInput> = {}): ContentStalenessInput {
  return {
    contentHash: null,
    l1ContentHash: null,
    contentHashSnapshot: null,
    l1ContentHashSnapshot: null,
    ...overrides,
  };
}

describe("deriveContentStaleness", () => {
  describe("L1 专属对可用时优先比 L1", () => {
    it("L1 不等 → true，即使全量对相等（L2-only 变更不打扰 L1 卡）", () => {
      expect(
        deriveContentStaleness(
          input({
            l1ContentHash: "l1-v2",
            l1ContentHashSnapshot: "l1-v1",
            contentHash: "full-same",
            contentHashSnapshot: "full-same",
          }),
        ),
      ).toBe(true);
    });

    it("L1 相等 → false，即使全量对不等", () => {
      expect(
        deriveContentStaleness(
          input({
            l1ContentHash: "l1-v1",
            l1ContentHashSnapshot: "l1-v1",
            contentHash: "full-v9",
            contentHashSnapshot: "full-v1",
          }),
        ),
      ).toBe(false);
    });
  });

  describe("L1 对不可用时降级比全量对", () => {
    it("L1 hash 缺失 → 用全量对比（不等 → true）", () => {
      expect(
        deriveContentStaleness(
          input({
            l1ContentHash: null,
            l1ContentHashSnapshot: "l1-v1",
            contentHash: "full-v2",
            contentHashSnapshot: "full-v1",
          }),
        ),
      ).toBe(true);
    });

    it("L1 快照缺失 → 用全量对比（相等 → false）", () => {
      expect(
        deriveContentStaleness(
          input({
            l1ContentHash: "l1-v2",
            l1ContentHashSnapshot: null,
            contentHash: "full-v1",
            contentHashSnapshot: "full-v1",
          }),
        ),
      ).toBe(false);
    });

    it("L1 快照是空串（视为不可用）→ 仍降级比全量对", () => {
      expect(
        deriveContentStaleness(
          input({
            l1ContentHash: "l1-v2",
            l1ContentHashSnapshot: "",
            contentHash: "full-v2",
            contentHashSnapshot: "full-v1",
          }),
        ),
      ).toBe(true);
    });
  });

  describe("任一侧快照缺失 → 不派生（新卡 / 未作答）", () => {
    it("全量快照为 null → false（即使词条 hash 有值）", () => {
      expect(
        deriveContentStaleness(input({ contentHash: "full-v1", contentHashSnapshot: null })),
      ).toBe(false);
    });

    it("全量快照为 undefined → false", () => {
      expect(
        deriveContentStaleness(input({ contentHash: "full-v1" })),
      ).toBe(false);
    });

    it("词条 hash 缺失 → false", () => {
      expect(
        deriveContentStaleness(input({ contentHash: null, contentHashSnapshot: "full-v1" })),
      ).toBe(false);
    });

    it("词条 hash 为空串 → false", () => {
      expect(
        deriveContentStaleness(input({ contentHash: "", contentHashSnapshot: "" })),
      ).toBe(false);
    });

    it("两侧都缺失 → false", () => {
      expect(deriveContentStaleness(input())).toBe(false);
    });
  });

  describe("普通字符串同样按相等比较（不假设十六进制）", () => {
    it("中文内容快照变化 → true", () => {
      expect(
        deriveContentStaleness(
          input({ contentHash: "释义：维持 v2", contentHashSnapshot: "释义：维持 v1" }),
        ),
      ).toBe(true);
    });

    it("中文内容快照未变 → false", () => {
      expect(
        deriveContentStaleness(
          input({ contentHash: "释义：维持 v1", contentHashSnapshot: "释义：维持 v1" }),
        ),
      ).toBe(false);
    });
  });

  it("同输入恒同输出（纯函数、无时间依赖）", () => {
    const value = input({ contentHash: "h2", contentHashSnapshot: "h1" });
    expect(deriveContentStaleness(value)).toBe(deriveContentStaleness(value));
  });
});
