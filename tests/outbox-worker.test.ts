import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTransaction } from "@/db/transaction";
import type { IOutboxRepository, IRepositories, OutboxEventRow } from "@/repositories/interfaces";
import { ReviewOutboxWorker } from "@/outbox/review-outbox.worker";

const mockRepos: Partial<IRepositories> = {};

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

function event(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    aggregate_type: "review_log",
    aggregate_id: "00000000-0000-4000-8000-000000000102",
    event_type: "review.answer.recorded.v1",
    payload: {
      version: 1,
      reviewLogId: "00000000-0000-4000-8000-000000000102",
      progressId: "00000000-0000-4000-8000-000000000107",
      sessionId: "00000000-0000-4000-8000-000000000103",
      userId: "00000000-0000-4000-8000-000000000104",
      wordbookId: "00000000-0000-4000-8000-000000000105",
      wordId: "00000000-0000-4000-8000-000000000106",
    },
    dedupe_key: "review.answer.recorded.v1:00000000-0000-4000-8000-000000000102",
    status: "processing",
    attempts: 1,
    max_attempts: 8,
    available_at: "2026-07-10T00:00:00Z",
    locked_at: "2026-07-10T00:00:00Z",
    locked_until: "2026-07-10T00:01:00Z",
    locked_by: "worker-1",
    last_error: null,
    processed_at: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

function makeOutbox(overrides: Partial<IOutboxRepository> = {}): IOutboxRepository {
  const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
    .mockResolvedValueOnce([event()])
    .mockResolvedValue([]);
  return {
    enqueue: vi.fn(async () => ({ id: "event-1", inserted: true })),
    recoverExpiredLeases: vi.fn(async () => 0),
    claimBatch,
    beginEffect: vi.fn(async () => true),
    completeEffect: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => "retry" as const),
    replayDeadLetter: vi.fn(async () => false),
    getMetrics: vi.fn(async () => ({ pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: null })),
    ...overrides,
  };
}

beforeEach(() => {
  Object.keys(mockRepos).forEach((key) => delete (mockRepos as Record<string, unknown>)[key]);
  mockRepos.outbox = makeOutbox();
  mockRepos.l2Progress = {
    findByWordbookWordAndUser: vi.fn(async () => null),
    insert: vi.fn(async () => ({}) as never),
    findDueCards: vi.fn(async () => []),
    findForUpdate: vi.fn(async () => null),
    saveL2Answer: vi.fn(async () => ({ reviewLogId: "log-l2" })),
    updateProductionStatus: vi.fn(async () => undefined),
    insertDrillStepIfAbsent: vi.fn(async () => ({}) as never),
    findDrillStepForUpdate: vi.fn(async () => null),
    findLastDrillStep: vi.fn(async () => null),
    // M5 修复后接口新增方法：返回 null 表示无产出步可找
    findDrillStepBySessionWordStep: vi.fn(async () => null),
    // M7 修复：L2 撤销链路方法（worker 不应触达，但接口对齐需补全 mock）
    findPendingProductionStepsForResume: vi.fn(async () => []),
    findReviewLogForL2Undo: vi.fn(async () => null),
    applyL2UndoSnapshot: vi.fn(async () => 0),
    markL2ReviewLogUndone: vi.fn(async () => 0),
    insertL2UndoAuditLog: vi.fn(async () => undefined),
    completeDrillStep: vi.fn(async () => undefined),
    skipDrillStep: vi.fn(async () => undefined),
    deleteDrillStep: vi.fn(async () => undefined),
    finalizeL2ContentHash: vi.fn(async () => 0),
    pause: vi.fn(async () => undefined),
    unpauseByReason: vi.fn(async () => undefined),
  };
  mockRepos.reviews = {
    findProgressForOutbox: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000107",
      user_id: "00000000-0000-4000-8000-000000000104",
      wordbook_id: "00000000-0000-4000-8000-000000000105",
      word_id: "00000000-0000-4000-8000-000000000106",
      stability: 2,
      difficulty: 0.4,
      review_count: 4,
      last_rating: "good",
      recent_ratings: ["good", "good"],
    })),
    markL1WeakSignal: vi.fn(async () => 0),
  } as never;
  mockRepos.sessions = { incrementCardsSeenFromOutbox: vi.fn(async () => undefined) } as never;
});

describe("ReviewOutboxWorker", () => {
  it("processes every effect and marks the event processed", async () => {
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    expect(await worker.processBatch()).toBe(1);
    expect(outbox.beginEffect).toHaveBeenCalledTimes(3);
    expect(outbox.completeEffect).toHaveBeenCalledTimes(3);
    expect(mockRepos.sessions?.incrementCardsSeenFromOutbox).toHaveBeenCalledTimes(1);
    expect(outbox.markProcessed).toHaveBeenCalledWith(event().id, "worker-1");
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  it("stops claiming new events when shutdown is requested during a batch", async () => {
    let continueProcessing = true;
    const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
      .mockResolvedValueOnce([event()])
      .mockResolvedValueOnce([event({ id: "00000000-0000-4000-8000-000000000108" })])
      .mockResolvedValue([]);
    const outbox = makeOutbox({ claimBatch });
    mockRepos.outbox = outbox;
    mockRepos.sessions = {
      incrementCardsSeenFromOutbox: vi.fn(async () => { continueProcessing = false; }),
    } as never;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1", batchSize: 20 });

    expect(await worker.processBatch(() => continueProcessing)).toBe(1);
    expect(claimBatch).toHaveBeenCalledTimes(1);
  });

  it("does not recover or claim work when already stopping", async () => {
    const outbox = makeOutbox();
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    expect(await worker.processBatch(() => false)).toBe(0);
    expect(outbox.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(outbox.claimBatch).not.toHaveBeenCalled();
  });

  it("uses current authoritative progress instead of stale event snapshots", async () => {
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(mockRepos.reviews?.findProgressForOutbox).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000107",
      "00000000-0000-4000-8000-000000000104",
      "00000000-0000-4000-8000-000000000105",
    );
    expect(mockRepos.l2Progress?.findByWordbookWordAndUser).not.toHaveBeenCalled();
  });

  it("scopes every user-data effect transaction to the validated event actor", async () => {
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();

    expect(withTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { actorId: "00000000-0000-4000-8000-000000000104" },
    );
  });

  it("skips an effect that already has a durable receipt", async () => {
    const outbox = makeOutbox({
      beginEffect: vi.fn(async (_eventId, effectName) => effectName !== "session_cards_seen"),
    });
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(mockRepos.sessions?.incrementCardsSeenFromOutbox).not.toHaveBeenCalled();
    expect(outbox.completeEffect).toHaveBeenCalledTimes(2);
    expect(outbox.markProcessed).toHaveBeenCalledTimes(1);
  });

  it("schedules retry and does not acknowledge when an effect fails", async () => {
    mockRepos.sessions = { incrementCardsSeenFromOutbox: vi.fn(async () => { throw new Error("db down"); }) } as never;
    const outbox = makeOutbox();
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(outbox.markProcessed).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith(event().id, "worker-1", "db down", 1);
  });

  it("dead-letters unsupported or invalid event payloads through the repository policy", async () => {
    const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
      .mockResolvedValueOnce([event({ event_type: "unknown.v1", attempts: 8 })])
      .mockResolvedValue([]);
    const outbox = makeOutbox({
      claimBatch,
      markFailed: vi.fn(async () => "dead_letter" as const),
    });
    mockRepos.outbox = outbox;
    const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

    await worker.processBatch();
    expect(outbox.markFailed).toHaveBeenCalledWith(
      event().id,
      "worker-1",
      "Unsupported outbox event type: unknown.v1",
      128,
    );
  });

  // ─── FR-12 接线1：track='l2' 分支（l2-drill spec §七） ──────────────────
  // L2 轨事件只做 l2_weak_signal，不递增 cards_seen，不触发 L1 侧联动。

  describe("track='l2' branch (FR-12 wiring)", () => {
    function l2Event(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
      // track='l2' 事件：payload 必须带 track 字段，其余字段沿用 event() 默认
      return event({
        payload: {
          version: 1,
          reviewLogId: "00000000-0000-4000-8000-000000000102",
          progressId: "00000000-0000-4000-8000-000000000107",
          sessionId: "00000000-0000-4000-8000-000000000103",
          userId: "00000000-0000-4000-8000-000000000104",
          wordbookId: "00000000-0000-4000-8000-000000000105",
          wordId: "00000000-0000-4000-8000-000000000106",
          track: "l2",
        },
        ...overrides,
      });
    }

    it("triggers l2_weak_signal effect and skips cards_seen / l1 cascade / l2_transition", async () => {
      const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
        .mockResolvedValueOnce([l2Event()])
        .mockResolvedValue([]);
      const outbox = makeOutbox({ claimBatch });
      mockRepos.outbox = outbox;
      const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

      expect(await worker.processBatch()).toBe(1);

      // l2_weak_signal 收据：beginEffect 被调用一次且 effectName='l2_weak_signal'
      expect(outbox.beginEffect).toHaveBeenCalledWith(
        l2Event().id,
        "l2_weak_signal",
        "worker-1",
      );
      expect(outbox.completeEffect).toHaveBeenCalledWith(
        l2Event().id,
        "l2_weak_signal",
      );
      // cards_seen 不递增（一词不记两次账）
      expect(mockRepos.sessions?.incrementCardsSeenFromOutbox).not.toHaveBeenCalled();
      // L1 路径不应被触达
      expect(mockRepos.reviews?.findProgressForOutbox).not.toHaveBeenCalled();
      // l2_transition / l1_cascade 收据不应被申请
      expect(outbox.beginEffect).not.toHaveBeenCalledWith(
        expect.anything(),
        "l2_transition",
        expect.anything(),
      );
      expect(outbox.beginEffect).not.toHaveBeenCalledWith(
        expect.anything(),
        "l1_cascade",
        expect.anything(),
      );
      // 事件应被标记为已处理
      expect(outbox.markProcessed).toHaveBeenCalledWith(l2Event().id, "worker-1");
    });

    it("invokes CrossTrackService.checkL2FailureCascade via l2Progress lookup", async () => {
      // checkL2FailureCascade 会调用 l2Progress.findByWordbookWordAndUser
      // 加载 L2 progress 行的 recent_ratings，判断是否触发弱信号。
      const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
        .mockResolvedValueOnce([l2Event()])
        .mockResolvedValue([]);
      const outbox = makeOutbox({ claimBatch });
      mockRepos.outbox = outbox;
      // L2 行存在但 recent_ratings 不足 3 个 again → 不触发 markL1WeakSignal
      mockRepos.l2Progress = {
        ...mockRepos.l2Progress,
        findByWordbookWordAndUser: vi.fn(async () => ({
          id: "l2-row-1",
          recent_ratings: ["good", "again"],
        })),
      } as unknown as typeof mockRepos.l2Progress;
      const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

      await worker.processBatch();

      // findByWordbookWordAndUser 必须用事件的 (userId, wordbookId, wordId) 调用
      expect(mockRepos.l2Progress?.findByWordbookWordAndUser).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000104",
        "00000000-0000-4000-8000-000000000105",
        "00000000-0000-4000-8000-000000000106",
      );
      // recent_ratings 不满足窗口条件 → markL1WeakSignal 不应被调用
      expect(mockRepos.reviews?.markL1WeakSignal).not.toHaveBeenCalled();
    });

    it("marks l1_weak_signal when L2 recent_ratings window is all again", async () => {
      const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
        .mockResolvedValueOnce([l2Event()])
        .mockResolvedValue([]);
      const outbox = makeOutbox({ claimBatch });
      mockRepos.outbox = outbox;
      // L2 行 recent_ratings 最后 3 个都是 again → 触发 markL1WeakSignal
      mockRepos.l2Progress = {
        ...mockRepos.l2Progress,
        findByWordbookWordAndUser: vi.fn(async () => ({
          id: "l2-row-1",
          recent_ratings: ["good", "again", "again", "again"],
        })),
      } as unknown as typeof mockRepos.l2Progress;
      mockRepos.reviews = {
        ...mockRepos.reviews,
        markL1WeakSignal: vi.fn(async () => 1),
      } as unknown as typeof mockRepos.reviews;
      const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

      await worker.processBatch();

      expect(mockRepos.reviews?.markL1WeakSignal).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000104",
        "00000000-0000-4000-8000-000000000105",
        "00000000-0000-4000-8000-000000000106",
        true,
      );
      expect(outbox.markProcessed).toHaveBeenCalledWith(l2Event().id, "worker-1");
    });

    it("skips l2_weak_signal when receipt already exists (idempotent)", async () => {
      const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
        .mockResolvedValueOnce([l2Event()])
        .mockResolvedValue([]);
      const outbox = makeOutbox({
        claimBatch,
        // l2_weak_signal 收据已存在 → beginEffect 返回 false
        beginEffect: vi.fn(async (_eventId, effectName) => effectName !== "l2_weak_signal"),
      });
      mockRepos.outbox = outbox;
      const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

      await worker.processBatch();

      // 收据已存在 → 不应触达 L2 progress 查询
      expect(mockRepos.l2Progress?.findByWordbookWordAndUser).not.toHaveBeenCalled();
      // completeEffect 不应被调用（l2_weak_signal 收据已存在，跳过）
      expect(outbox.completeEffect).not.toHaveBeenCalledWith(
        l2Event().id,
        "l2_weak_signal",
      );
      // 事件仍应被标记为已处理
      expect(outbox.markProcessed).toHaveBeenCalledWith(l2Event().id, "worker-1");
    });

    it("scopes L2 effect transaction to the event actor (RLS)", async () => {
      const claimBatch = vi.fn<() => Promise<OutboxEventRow[]>>()
        .mockResolvedValueOnce([l2Event()])
        .mockResolvedValue([]);
      const outbox = makeOutbox({ claimBatch });
      mockRepos.outbox = outbox;
      const worker = new ReviewOutboxWorker(outbox, { workerId: "worker-1" });

      await worker.processBatch();

      expect(withTransaction).toHaveBeenCalledWith(
        expect.any(Function),
        { actorId: "00000000-0000-4000-8000-000000000104" },
      );
    });
  });
});
