/**
 * ReviewQueue 队列优先级构建器单元测试（P1）。
 *
 * 验证点：
 * - 状态分桶：recheck/learning 优先、review 居中、new 殿后
 * - 排序键：stateRank → retrievabilityRisk → overdueMs → due_at → review_count
 * - 新卡配额：每批新卡不超过 MAX_NEW_CARDS_PER_BATCH 且占比 ≤ MAX_NEW_CARD_SHARE，
 *   超额 defer 计入 deferredNewCards
 * - limit 截断 / 空输入边界
 */

import { describe, it, expect } from "vitest";
import {
  buildReviewQueueBatch,
  prioritizeReviewQueueItems,
  REVIEW_QUEUE_BATCH_LIMIT,
  MAX_NEW_CARDS_PER_BATCH,
  type ReviewQueueCandidate,
} from "@/services/review-queue";

function makeCandidate(overrides: Partial<ReviewQueueCandidate> = {}): ReviewQueueCandidate {
  return {
    state: "review",
    due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 逾期 1h
    review_count: 3,
    desired_retention: 0.9,
    scheduler_payload: null,
    needs_recheck: false,
    ...overrides,
  };
}

/** 构造一张 ts-fsrs Review 状态的 scheduler payload（state=2）。 */
function makeReviewPayload(lastReviewDaysAgo: number): unknown {
  return {
    difficulty: 5,
    due: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    elapsed_days: 1,
    lapses: 0,
    learning_steps: 0,
    last_review: new Date(Date.now() - lastReviewDaysAgo * 24 * 60 * 60 * 1000).toISOString(),
    reps: 5,
    scheduled_days: 10,
    stability: 5,
    state: 2, // ts-fsrs Review
  };
}

describe("buildReviewQueueBatch", () => {
  it("sorts by state tier: recheck/learning first, review middle, new last", () => {
    const batch = buildReviewQueueBatch([
      makeCandidate({ state: "new" }),
      makeCandidate({ state: "review" }),
      makeCandidate({ state: "learning" }),
      makeCandidate({ state: "review", needs_recheck: true }),
    ]);

    const buckets = batch.items.map(({ priority }) => priority.bucket);
    expect(buckets).toEqual(["learning", "learning", "overdue", "new"]);
    // recheck 卡提到 learning 层，且排在普通 review 卡之前
    const recheckIndex = batch.items.findIndex(({ item }) => item.needs_recheck);
    const reviewIndex = batch.items.findIndex(({ item }) => item.state === "review" && !item.needs_recheck);
    expect(recheckIndex).toBeGreaterThanOrEqual(0);
    expect(recheckIndex).toBeLessThan(reviewIndex);
  });

  it("orders mature review cards by predicted recall risk (lower retrievability first)", () => {
    const batch = buildReviewQueueBatch([
      // stability 相同，last_review 越久 → retrievability 越低 → 排越前
      makeCandidate({ scheduler_payload: makeReviewPayload(3), review_count: 3 }),
      makeCandidate({ scheduler_payload: makeReviewPayload(30), review_count: 3 }),
    ]);

    expect(batch.items[0].item.review_count).toBe(3);
    const riskA = 1 - (batch.items[0].priority.retrievability ?? 0);
    const riskB = 1 - (batch.items[1].priority.retrievability ?? 0);
    expect(riskA).toBeGreaterThan(riskB);
  });

  it("breaks overdue ties by review_count ascending", () => {
    // 固定 due_at 消除时序差异，确保走到 review_count 决胜键
    const fixedDue = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const batch = buildReviewQueueBatch([
      makeCandidate({ review_count: 9, due_at: fixedDue }),
      makeCandidate({ review_count: 2, due_at: fixedDue }),
    ]);

    expect(batch.items[0].item.review_count).toBe(2);
    expect(batch.items[1].item.review_count).toBe(9);
  });

  it("caps new cards per batch and reports deferredNewCards", () => {
    // 10 张新卡 + 10 张 review，limit=20 → 新卡配额 = ceil(20*0.4)=8
    const candidates: ReviewQueueCandidate[] = [
      ...Array.from({ length: 10 }, () => makeCandidate({ state: "new" })),
      ...Array.from({ length: 10 }, () => makeCandidate({ state: "review" })),
    ];
    const batch = buildReviewQueueBatch(candidates, new Date(), 20);

    // 10 review + 8 张配额内新卡 = 18 张入选，剩余 2 张新卡 defer
    expect(batch.items.length).toBe(10 + MAX_NEW_CARDS_PER_BATCH);
    const newCards = batch.items.filter(({ item }) => item.state === "new").length;
    expect(newCards).toBeLessThanOrEqual(MAX_NEW_CARDS_PER_BATCH);
    expect(batch.deferredNewCards).toBe(10 - newCards);
  });

  it("respects the batch limit", () => {
    const candidates = Array.from({ length: 25 }, () => makeCandidate());
    const batch = buildReviewQueueBatch(candidates, new Date(), REVIEW_QUEUE_BATCH_LIMIT);
    expect(batch.items.length).toBe(REVIEW_QUEUE_BATCH_LIMIT);
  });

  it("returns an empty batch for an empty candidate pool", () => {
    const batch = buildReviewQueueBatch([], new Date(), 20);
    expect(batch.items).toEqual([]);
    expect(batch.deferredNewCards).toBe(0);
  });
});

describe("prioritizeReviewQueueItems", () => {
  it("sorts without applying the new-card quota", () => {
    const items = prioritizeReviewQueueItems([
      makeCandidate({ state: "new" }),
      makeCandidate({ state: "review" }),
    ]);
    expect(items.map((i) => i.state)).toEqual(["review", "new"]);
  });
});
