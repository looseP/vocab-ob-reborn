/**
 * 通道隔离的**纯函数层**测试（2026-10-10）。
 *
 * 与 tests/repositories/review-channel-isolation.test.ts 分工：
 * 仓储那层钉「SQL 谓词」，这里钉「候选池进入 buildReviewQueueBatch 后的集合切分与配额」。
 * 两层都要有 —— 只测其中一层，会漏掉「谓词对但纯函数又把它混回去」这类组合回归。
 */
import { describe, it, expect } from "vitest";
import {
  buildReviewQueueBatch,
  isInNewChannel,
  isInReviewChannel,
  matchesChannel,
} from "@/services/review-queue";
import { isNewChannelState, isReviewChannelState } from "@/domain";
import type { ReviewQueueCandidate } from "@/services/review-queue";

function card(overrides: Partial<ReviewQueueCandidate> = {}): ReviewQueueCandidate {
  return {
    state: "review",
    due_at: "2020-01-01T00:00:00.000Z",
    review_count: 3,
    desired_retention: 0.9,
    scheduler_payload: null,
    ...overrides,
  };
}

describe("通道谓词", () => {
  it("review 通道收下已作答的三个 state，不收新卡", () => {
    expect(isInReviewChannel(card({ state: "review" }))).toBe(true);
    expect(isInReviewChannel(card({ state: "learning" }))).toBe(true);
    expect(isInReviewChannel(card({ state: "relearning" }))).toBe(true);
    expect(isInReviewChannel(card({ state: "new" }))).toBe(false);
  });

  it("new 通道只收从未作答的新卡", () => {
    expect(isInNewChannel(card({ state: "new" }))).toBe(true);
    expect(isInNewChannel(card({ state: "review" }))).toBe(false);
    expect(isInNewChannel(card({ state: "learning" }))).toBe(false);
  });

  it("needs_recheck 的新卡归复习通道（内容变了要重看，不是首次学）", () => {
    // 这是最容易搞反的一格：它 state='new'，但语义上属于「已见过、需重看」。
    expect(isInReviewChannel(card({ state: "new", needs_recheck: true }))).toBe(true);
    expect(isInNewChannel(card({ state: "new", needs_recheck: true }))).toBe(false);
  });

  it("suspended 既不属于复习也不属于新词通道", () => {
    expect(isInReviewChannel(card({ state: "suspended" }))).toBe(false);
    expect(isInNewChannel(card({ state: "suspended" }))).toBe(false);
  });

  it("domain 与 services 两侧判定同口径（防两处枚举漂移）", () => {
    const states = ["new", "learning", "review", "relearning", "suspended"] as const;
    for (const state of states) {
      for (const needsRecheck of [false, true]) {
        // 候选字段是 snake_case 的 `needs_recheck`（与 DB 行同名）
        expect(isInReviewChannel(card({ state, needs_recheck: needsRecheck }))).toBe(
          isReviewChannelState(state, needsRecheck),
        );
        expect(isInNewChannel(card({ state, needs_recheck: needsRecheck }))).toBe(
          isNewChannelState(state, needsRecheck),
        );
      }
    }
  });

  it("matchesChannel 的 null = 不限（练习模式与旧调用方）", () => {
    expect(matchesChannel(card({ state: "new" }), null)).toBe(true);
    expect(matchesChannel(card({ state: "review" }), null)).toBe(true);
    expect(matchesChannel(card({ state: "new" }), "review")).toBe(false);
    expect(matchesChannel(card({ state: "new" }), "new")).toBe(true);
  });
});

describe("buildReviewQueueBatch 的通道隔离", () => {
  /** 真库实测构成（2026-10-10）：483 张新卡 + 1 张到期复习。 */
  const realisticPool: ReviewQueueCandidate[] = [
    ...Array.from({ length: 483 }, (_, i) =>
      card({ state: "new", due_at: null, review_count: 0 }),
    ),
    card({ state: "review", due_at: "2020-01-01T00:00:00.000Z", review_count: 5 }),
  ];

  it("review 通道只出复习卡——483 张新卡一张都不进来", () => {
    const batch = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "review");
    expect(batch.items).toHaveLength(1);
    expect(batch.items.every((e) => e.item.state !== "new")).toBe(true);
    expect(batch.deferredNewCards).toBe(0);
  });

  it("new 通道只出新卡——到期复习卡不与新卡争位置", () => {
    const batch = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "new");
    expect(batch.items).toHaveLength(20);
    expect(batch.items.every((e) => e.item.state === "new")).toBe(true);
    // 一批 20 张全是新卡，复习卡没被稀释进来
    expect(batch.hasMore).toBe(true);
  });

  it("**隔离前那套配额会锁死新卡**：new 通道不再受 8 张配额约束", () => {
    // 旧策略：每批新卡封顶 8 张 ⇒ 483 张要 61 批才能过完。
    // 隔离后 new 通道配额不设默认 ⇒ 一批就是整批 20 张，483 张只要 25 批。
    const batch = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "new");
    const newCardsInBatch = batch.items.filter((e) => e.item.state === "new");
    expect(newCardsInBatch.length).toBe(20);
    expect(newCardsInBatch.length).toBeGreaterThan(8);
  });

  it("new 通道分页可用（hasMore 为 true）——池不被默认配额截死", () => {
    // 回归防线：曾把 new 通道默认配额设成 20，导致 eligibleTotal 恒等于 20、
    // hasMore恒为 false ⇒分页彻底失效（连带废掉两阶段取数的池宽 2000 成果）。
    // 新词的学习量由「每日新词额度」闸门管，不该在这里截池。
    const batch = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "new");
    expect(batch.eligibleTotal).toBe(483);
    expect(batch.hasMore).toBe(true);
  });

  it("通道互斥且完备：两通道的 eligible 之和 = 各自池内总数", () => {
    const review = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "review");
    const learn = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "new");
    // review 通道池里 1 张、new 通道池里 483 张 —— 互斥且完备（无重复、无遗漏）
    expect(review.eligibleTotal).toBe(1);
    expect(learn.eligibleTotal).toBe(483);
    expect(review.eligibleTotal + learn.eligibleTotal).toBe(484);
  });

  it("null 通道保持隔离前的旧行为（新卡配额生效）", () => {
    const pool = Array.from({ length: 30 }, () => card({ state: "new", due_at: null, review_count: 0 }));
    const batch = buildReviewQueueBatch(pool, new Date(), 20, null, 0, null);
    // 旧口径：20 张批次里新卡封顶 8 张
    expect(batch.items.filter((e) => e.item.state === "new").length).toBe(8);
    expect(batch.deferredNewCards).toBe(22);
  });

  it("分页不破坏隔离：offset 之后仍只出同一通道", () => {
    // 用**逐卡唯一的 word_id** 作标识：483 张新卡的 review_count 全是 0（从未作答），
    // 拿它当主键会把不同卡认成同一张。T 上带 word_id 是为了模拟阶段一的快照行形态
    // （快照里确实有 word_id，阶段二靠它回填 word 详情）。
    type CandidateWithId = ReviewQueueCandidate & { word_id: string };
    const poolWithIds: CandidateWithId[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        ...card({ state: "new", due_at: null, review_count: 0 }),
        word_id: `w${i}`,
      })),
      { ...card({ state: "review", due_at: "2020-01-01T00:00:00.000Z" }), word_id: "w-review" },
    ];
    const first = buildReviewQueueBatch(poolWithIds, new Date(), 20, null, 0, "new");
    const second = buildReviewQueueBatch(poolWithIds, new Date(), 20, null, 20, "new");
    const firstIds = new Set(first.items.map((e) => e.item.word_id));
    expect(firstIds.size).toBe(20);
    for (const entry of second.items) {
      expect(firstIds.has(entry.item.word_id)).toBe(false);
    }
    expect(second.items.every((e) => e.item.state === "new")).toBe(true);
  });

  it("review 通道显式传 maxNewCards 也不该放进新卡（配额不能突破隔离）", () => {
    // 隔离是集合层面的，不是数量层面的：即使把配额调大，新卡也不该出现。
    const batch = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "review", 999);
    expect(batch.items.every((e) => e.item.state !== "new")).toBe(true);
  });

  it("new 通道尊重显式 maxNewCards（可用于临时缩小单次新学量）", () => {
    const batch = buildReviewQueueBatch(realisticPool, new Date(), 20, null, 0, "new", 5);
    expect(batch.items.filter((e) => e.item.state === "new").length).toBe(5);
    expect(batch.deferredNewCards).toBe(478);
  });

  it("needs_recheck 的新卡在 review 通道里优先提权（内容变更要重看）", () => {
    const pool: ReviewQueueCandidate[] = [
      card({ state: "review", due_at: "2020-01-01T00:00:00.000Z" }),
      card({ state: "new", due_at: null, needs_recheck: true }),
    ];
    const batch = buildReviewQueueBatch(pool, new Date(), 20, null, 0, "review");
    expect(batch.items).toHaveLength(2);
    // 排序键 stateRank：needs_recheck 一律 rank 0，排在普通到期卡之前
    expect(batch.items[0].item.needs_recheck).toBe(true);
  });
});