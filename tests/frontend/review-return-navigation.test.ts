/**
 * reviewReturnNavigation：复习卡 ↔ L3 往返契约的纯判定。
 *
 * 不变量（写测试是为了钉住这几条，而不是为了覆盖率）：
 * - 回程标记**只认严格 true**：`state` 是路由透传的任意 JSON（刷新后来自
 *   history.state），"有个 fromReview 键"不等于"用户是往返回来的"；
 * - 自动续接必须**同时**满足「带标记 + 还在选择区 + 确实扫到可恢复会话」，
 *   误判会让用户在自己的复习页面上被静默换卡 / 静默丢进度。
 */
import { describe, expect, it } from "vitest";
import {
  REVIEW_PATH,
  isReviewReturnNavigation,
  reviewReturnState,
  shouldAutoRestoreSession,
} from "@/frontend/viewModels/reviewReturnNavigation";

describe("reviewReturnState / isReviewReturnNavigation", () => {
  it("自己造的标记能被自己识别（往返契约自洽）", () => {
    const state = reviewReturnState();
    expect(state).toEqual({ fromReview: true });
    expect(isReviewReturnNavigation(state)).toBe(true);
  });

  it("只认严格 true —— 其他一律视为普通导航", () => {
    const reject: unknown[] = [
      undefined,
      null,
      {},
      { fromReview: "true" },
      { fromReview: 1 },
      { fromReview: false },
      { fromReview: undefined },
      { other: true },
      "fromReview",
      42,
      [],
    ];
    for (const state of reject) {
      expect(isReviewReturnNavigation(state), `should reject ${JSON.stringify(state)}`).toBe(false);
    }
  });

  it("多余字段不影响识别（路由 state 可被其它来源扩展）", () => {
    expect(isReviewReturnNavigation({ fromReview: true, scrollY: 120 })).toBe(true);
  });
});

describe("shouldAutoRestoreSession", () => {
  it("三条件齐备才自动续接", () => {
    expect(shouldAutoRestoreSession({ fromReview: true, mode: "select", hasPendingRestore: true })).toBe(true);
  });

  it("任一条件缺失都不自动（交回确认条 / 正常流程）", () => {
    const cases = [
      { fromReview: false, mode: "select", hasPendingRestore: true },
      { fromReview: true, mode: "session", hasPendingRestore: true },
      { fromReview: true, mode: "select", hasPendingRestore: false },
      { fromReview: false, mode: "session", hasPendingRestore: false },
    ];
    for (const input of cases) {
      expect(shouldAutoRestoreSession(input), JSON.stringify(input)).toBe(false);
    }
  });
});

describe("REVIEW_PATH", () => {
  it("是复习页路径（两侧共用同一常量，别再各写一份字符串）", () => {
    expect(REVIEW_PATH).toBe("/review");
  });
});
