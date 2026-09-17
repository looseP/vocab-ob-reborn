import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRepositories, UpgradeWorkOrderPendingRow } from "@/repositories/interfaces";
import type { UpgradeWorkOrderRow, UserWordL2ProgressRow, UserWordProgressRow } from "@/domain";
import type { OtherBookL2Signal } from "@/domain/upgrade-suggestion";
import { BusinessRuleError, NotFoundError, ValidationError } from "@/errors";

// Mock transaction + repository factory: the service never touches a real DB.
const mockRepos: Partial<IRepositories> = {};
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

import { UpgradeWorkOrderService } from "@/services/upgrade-work-order.service";

const USER = "user-1";
const WB = "wb-1";
const WORD = "word-1";

function l1Row(overrides: Partial<UserWordProgressRow> = {}): UserWordProgressRow {
  return {
    id: "l1-1",
    user_id: USER,
    word_id: WORD,
    wordbook_id: WB,
    state: "review",
    stability: 30,
    difficulty: 5,
    retrievability: 0.9,
    desired_retention: 0.9,
    due_at: null,
    last_reviewed_at: null,
    last_rating: "good",
    review_count: 6,
    lapse_count: 0,
    again_count: 0,
    hard_count: 0,
    good_count: 6,
    easy_count: 0,
    interval_days: null,
    scheduler_payload: {},
    content_hash_snapshot: null,
    l1_content_hash_snapshot: null,
    skip_count: 0,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    recent_ratings: ["good", "easy"],
    l1_weak_signal: false,
    ...overrides,
  };
}

function order(overrides: Partial<UpgradeWorkOrderRow> = {}): UpgradeWorkOrderRow {
  return {
    id: "wo-1",
    user_id: USER,
    word_id: WORD,
    wordbook_id: WB,
    direction: "通用",
    status: "标记中",
    suggestion_snapshot: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

/** 待升级清单行：工单行 + LEFT JOIN words 的词面。 */
function pendingOrder(overrides: Partial<UpgradeWorkOrderPendingRow> = {}): UpgradeWorkOrderPendingRow {
  return {
    ...order(),
    word_slug: "comprehend",
    word_text: "comprehend",
    ...overrides,
  };
}

function seedRow(): UserWordL2ProgressRow {
  return {
    id: "old-l2",
    user_id: USER,
    word_id: WORD,
    wordbook_id: "wb-old",
    l2_stability: 40,
    l2_difficulty: 4.5,
    l2_scheduler_payload: { reps: 3, stability: 40, difficulty: 4.5 },
  } as unknown as UserWordL2ProgressRow;
}

function setup(options: { l1?: UserWordProgressRow | null } = {}) {
  const upgradeWorkOrders = {
    insert: vi.fn(async (data: Record<string, unknown>) => order({ ...data } as Partial<UpgradeWorkOrderRow>)),
    updateSuggestion: vi.fn(async () => order()),
    findActiveByScope: vi.fn(async (): Promise<UpgradeWorkOrderRow | null> => null),
    findByIdForUser: vi.fn(async (): Promise<UpgradeWorkOrderRow | null> => order()),
    listPending: vi.fn(async () => [pendingOrder()]),
    updateStatus: vi.fn(async (_u: string, _id: string, status: string, opts?: { completed?: boolean }) =>
      order({ status: status as UpgradeWorkOrderRow["status"], completed_at: opts?.completed ? "2026-09-11T00:00:00.000Z" : null })),
  };
  const reviews = {
    findByUserWordbookWord: vi.fn(async () => (options.l1 === undefined ? l1Row() : options.l1)),
  };
  const l2Progress = {
    findOtherBookSignals: vi.fn(async (): Promise<OtherBookL2Signal[]> => []),
    findBestByWordAndUser: vi.fn(async (): Promise<UserWordL2ProgressRow | null> => null),
  };
  mockRepos.upgradeWorkOrders = upgradeWorkOrders as never;
  mockRepos.reviews = reviews as never;
  mockRepos.l2Progress = l2Progress as never;

  const l2Transition = {
    promoteWithSeed: vi.fn(async () => ({
      alreadyPromoted: false,
      l2DueAt: "2026-09-20T00:00:00.000Z",
      seeded: false,
    })),
  };
  const service = new UpgradeWorkOrderService({ l2Transition });
  return { service, upgradeWorkOrders, reviews, l2Progress, l2Transition };
}

beforeEach(() => {
  Object.keys(mockRepos).forEach((key) => delete (mockRepos as Record<string, unknown>)[key]);
});

describe("UpgradeWorkOrderService.mark", () => {
  it("inserts a 标记中 work order with a three-tier suggestion snapshot (zero FSRS writes)", async () => {
    const { service, upgradeWorkOrders } = setup();

    const result = await service.mark(USER, WB, WORD);

    expect(result.suggestion).toBe("normal");
    expect(result.workOrder.status).toBe("标记中");
    const inserted = upgradeWorkOrders.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      user_id: USER,
      word_id: WORD,
      wordbook_id: WB,
      direction: "通用",
    });
    const snapshot = inserted.suggestion_snapshot as Record<string, unknown>;
    expect(snapshot.level).toBe("normal");
    expect(snapshot.currentBookL1).toEqual({ recentRatings: ["good", "easy"], state: "review" });
    expect(snapshot.otherBooksL2).toEqual([]);
    expect(typeof snapshot.capturedAt).toBe("string");
    // 纯提示：只读建议信号，绝不写 L2 进度
    expect(upgradeWorkOrders.updateStatus).not.toHaveBeenCalled();
  });

  it("computes 'strong' from a mastered other-book L2 signal", async () => {
    const { service, l2Progress } = setup();
    l2Progress.findOtherBookSignals.mockResolvedValueOnce([
      { state: "review", retrievability: 0.95, l2ProductionStatus: "passed" },
    ]);

    const result = await service.mark(USER, WB, WORD);

    expect(result.suggestion).toBe("strong");
    expect(result.suggestionSnapshot.otherBooksL2).toHaveLength(1);
  });

  it("forwards an explicit direction and defaults to 通用", async () => {
    const explicit = setup();
    await explicit.service.mark(USER, WB, WORD, "考研");
    expect((explicit.upgradeWorkOrders.insert.mock.calls[0]![0] as Record<string, unknown>).direction).toBe("考研");

    const fallback = setup();
    await fallback.service.mark(USER, WB, WORD);
    expect((fallback.upgradeWorkOrders.insert.mock.calls[0]![0] as Record<string, unknown>).direction).toBe("通用");
  });

  it("re-marking an active order refreshes the snapshot instead of creating a second order", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findActiveByScope.mockResolvedValueOnce(order({ id: "wo-existing" }));
    upgradeWorkOrders.updateSuggestion.mockResolvedValueOnce(order({ id: "wo-existing" }));

    const result = await service.mark(USER, WB, WORD, "雅思");

    expect(result.workOrder.id).toBe("wo-existing");
    expect(upgradeWorkOrders.insert).not.toHaveBeenCalled();
    expect(upgradeWorkOrders.updateSuggestion).toHaveBeenCalledWith(
      USER,
      "wo-existing",
      "雅思",
      expect.objectContaining({ level: "normal" }),
    );
  });

  it("recovers from a 23505 insert race by reusing the concurrent active order", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findActiveByScope
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(order({ id: "wo-raced" }));
    upgradeWorkOrders.insert.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    upgradeWorkOrders.updateSuggestion.mockResolvedValueOnce(order({ id: "wo-raced" }));

    const result = await service.mark(USER, WB, WORD);

    expect(result.workOrder.id).toBe("wo-raced");
    expect(upgradeWorkOrders.updateSuggestion).toHaveBeenCalled();
  });

  it("rethrows the original 23505 when the raced order cannot be re-read", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findActiveByScope.mockResolvedValue(null);
    upgradeWorkOrders.insert.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));

    await expect(service.mark(USER, WB, WORD)).rejects.toThrow("dup");
  });

  it("rejects an empty userId before touching the database", async () => {
    const { service, upgradeWorkOrders } = setup();

    await expect(service.mark("", WB, WORD)).rejects.toThrow(ValidationError);
    expect(upgradeWorkOrders.insert).not.toHaveBeenCalled();
  });

  it("rejects an unknown direction", async () => {
    const { service, upgradeWorkOrders } = setup();

    await expect(service.mark(USER, WB, WORD, "法语" as never)).rejects.toThrow(ValidationError);
    expect(upgradeWorkOrders.insert).not.toHaveBeenCalled();
  });
});

describe("UpgradeWorkOrderService.list", () => {
  it("returns pending orders with a bounded limit", async () => {
    const { service, upgradeWorkOrders } = setup();

    await service.list(USER, WB, 999);

    expect(upgradeWorkOrders.listPending).toHaveBeenCalledWith(USER, WB, 200);
  });

  it("falls back to the default limit for a non-positive limit", async () => {
    const { service, upgradeWorkOrders } = setup();

    await service.list(USER, WB, 0);

    expect(upgradeWorkOrders.listPending).toHaveBeenCalledWith(USER, WB, 50);
  });

  it("falls back to the default limit for a non-finite limit", async () => {
    const { service, upgradeWorkOrders } = setup();

    await service.list(USER, WB, Number.NaN);

    expect(upgradeWorkOrders.listPending).toHaveBeenCalledWith(USER, WB, 50);
  });

  it("enriches pending orders with the word surface and snapshot level", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.listPending.mockResolvedValueOnce([
      pendingOrder({ suggestion_snapshot: { level: "strong" } }),
    ]);

    const items = await service.list(USER, WB);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "wo-1",
      wordSlug: "comprehend",
      wordText: "comprehend",
      suggestion: "strong",
    });
    // 平面 word_slug/word_text 不外泄到 item（HTTP 层组装 word 嵌套）。
    expect(items[0]).not.toHaveProperty("word_slug");
    expect(items[0]).not.toHaveProperty("word_text");
  });

  it("passes a missing word surface through as null", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.listPending.mockResolvedValueOnce([
      pendingOrder({ word_slug: null, word_text: null }),
    ]);

    const items = await service.list(USER, WB);

    expect(items[0]).toMatchObject({ wordSlug: null, wordText: null });
  });

  it.each([
    [{ level: "strong" }, "strong"],
    [{ level: "normal" }, "normal"],
    [{ level: "needs_settling" }, "needs_settling"],
    [{ level: "bogus" }, "needs_settling"],
    [{ level: 7 }, "needs_settling"],
    [[], "needs_settling"],
    ["not-a-snapshot", "needs_settling"],
    [null, "needs_settling"],
  ] as Array<[unknown, string]>)("maps snapshot %j to level %s", async (snapshot, expected) => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.listPending.mockResolvedValueOnce([
      pendingOrder({ suggestion_snapshot: snapshot as never }),
    ]);

    const items = await service.list(USER, WB);

    expect(items[0]!.suggestion).toBe(expected);
  });
});

describe("UpgradeWorkOrderService.start", () => {
  it("moves 标记中 → 升级中", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "标记中" }));

    const result = await service.start(USER, "wo-1");

    expect(result.status).toBe("升级中");
    expect(upgradeWorkOrders.updateStatus).toHaveBeenCalledWith(USER, "wo-1", "升级中");
  });

  it("is idempotent when already 升级中", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "升级中" }));

    const result = await service.start(USER, "wo-1");

    expect(result.status).toBe("升级中");
    expect(upgradeWorkOrders.updateStatus).not.toHaveBeenCalled();
  });

  it("rejects starting a completed order", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "已完成" }));

    await expect(service.start(USER, "wo-1")).rejects.toThrow(BusinessRuleError);
  });

  it("throws NotFound for an unknown order", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(null);

    await expect(service.start(USER, "missing")).rejects.toThrow(NotFoundError);
  });
});

describe("UpgradeWorkOrderService.cancel", () => {
  it("moves an active order → 已取消", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "升级中" }));

    const result = await service.cancel(USER, "wo-1");

    expect(result.status).toBe("已取消");
    expect(upgradeWorkOrders.updateStatus).toHaveBeenCalledWith(USER, "wo-1", "已取消");
  });

  it("is idempotent when already 已取消", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "已取消" }));

    const result = await service.cancel(USER, "wo-1");

    expect(result.status).toBe("已取消");
    expect(upgradeWorkOrders.updateStatus).not.toHaveBeenCalled();
  });

  it("rejects cancelling a completed order", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "已完成" }));

    await expect(service.cancel(USER, "wo-1")).rejects.toThrow(BusinessRuleError);
  });

  it("throws NotFound for an unknown order", async () => {
    const { service, upgradeWorkOrders } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(null);

    await expect(service.cancel(USER, "missing")).rejects.toThrow(NotFoundError);
  });
});

describe("UpgradeWorkOrderService.complete", () => {
  it("seed path: promotes with the other-book seed and marks the order 已完成", async () => {
    const { service, upgradeWorkOrders, l2Progress, l2Transition } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "升级中" }));
    l2Progress.findBestByWordAndUser.mockResolvedValueOnce(seedRow());
    l2Transition.promoteWithSeed.mockResolvedValueOnce({
      alreadyPromoted: false,
      l2DueAt: "2026-10-01T00:00:00.000Z",
      seeded: true,
    });

    const result = await service.complete(USER, "wo-1");

    // seed 只取三个初值 + provenance 指针
    expect(l2Transition.promoteWithSeed).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER, wordbook_id: WB, word_id: WORD, stability: 30 }),
      { progressId: "old-l2", wordbookId: "wb-old", stability: 40, difficulty: 4.5, schedulerPayload: { reps: 3, stability: 40, difficulty: 4.5 } },
    );
    expect(upgradeWorkOrders.updateStatus).toHaveBeenCalledWith(USER, "wo-1", "已完成", { completed: true });
    expect(result).toMatchObject({ alreadyPromoted: false, l2DueAt: "2026-10-01T00:00:00.000Z", seeded: true });
    expect(result.workOrder.status).toBe("已完成");
  });

  it("no other-book record: promotes via the L1 path with seed=null", async () => {
    const { service, l2Progress, l2Transition } = setup();
    l2Progress.findBestByWordAndUser.mockResolvedValueOnce(null);

    const result = await service.complete(USER, "wo-1");

    expect(l2Transition.promoteWithSeed).toHaveBeenCalledWith(expect.anything(), null);
    expect(result.seeded).toBe(false);
  });

  it("is idempotent on repeat: an already-completed order does not re-promote nor re-write status", async () => {
    const { service, upgradeWorkOrders, l2Transition } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "已完成" }));
    l2Transition.promoteWithSeed.mockResolvedValueOnce({
      alreadyPromoted: true,
      l2DueAt: "2026-10-01T00:00:00.000Z",
      seeded: false,
    });

    const result = await service.complete(USER, "wo-1");

    expect(result.alreadyPromoted).toBe(true);
    expect(upgradeWorkOrders.updateStatus).not.toHaveBeenCalled();
  });

  it("rejects completing a cancelled order without promoting", async () => {
    const { service, upgradeWorkOrders, l2Transition } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(order({ status: "已取消" }));

    await expect(service.complete(USER, "wo-1")).rejects.toThrow(BusinessRuleError);
    expect(l2Transition.promoteWithSeed).not.toHaveBeenCalled();
  });

  it("rejects completing without an L1 progress row", async () => {
    const { service, l2Transition } = setup({ l1: null });

    await expect(service.complete(USER, "wo-1")).rejects.toThrow(BusinessRuleError);
    expect(l2Transition.promoteWithSeed).not.toHaveBeenCalled();
  });

  it("throws NotFound for an unknown order", async () => {
    const { service, upgradeWorkOrders, l2Transition } = setup();
    upgradeWorkOrders.findByIdForUser.mockResolvedValueOnce(null);

    await expect(service.complete(USER, "missing")).rejects.toThrow(NotFoundError);
    expect(l2Transition.promoteWithSeed).not.toHaveBeenCalled();
  });
});
