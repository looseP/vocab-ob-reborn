import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IOutboxRepository, IRepositories, IReviewRepository, ISessionRepository } from "@/repositories/interfaces";
import type { ProgressWithContentHash, SaveAnswerInput, UndoRpcResult } from "@/repositories/interfaces";
import { ReviewService, type FsrsAdapterFn } from "@/services/review.service";
import { NotFoundError, BusinessRuleError } from "@/errors";
import type { UserWordProgressRow, Json } from "@/domain";

// ── Mock infrastructure ─────────────────────────────────────────────────
// Mock withTransaction to directly call the callback with a fake tx,
// and mock createRepositories to return our mock repos.
const mockRepos: Partial<IRepositories> = {};
let transactionCallbackActive = false;

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    transactionCallbackActive = true;
    try {
      return await cb({});
    } finally {
      transactionCallbackActive = false;
    }
  }),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

// ── Mock factories ──────────────────────────────────────────────────────
function makeMockProgress(overrides: Partial<ProgressWithContentHash> = {}): ProgressWithContentHash {
  return {
    id: "p1",
    user_id: "u1",
    word_id: "w1",
    wordbook_id: "wb1",
    state: "review" as const,
    stability: 1.5,
    difficulty: 0.3,
    retrievability: 0.9,
    desired_retention: 0.9,
    due_at: "2026-01-01T00:00:00Z",
    last_reviewed_at: "2025-12-31T00:00:00Z",
    last_rating: "good" as const,
    review_count: 3,
    lapse_count: 0,
    again_count: 0,
    hard_count: 0,
    good_count: 3,
    easy_count: 0,
    interval_days: 7,
    scheduler_payload: {} as Json,
    content_hash_snapshot: "old-hash",
    skip_count: 0,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-12-31T00:00:00Z",
    content_hash: "current-hash",
    word_slug: "aboard",
    word_title: "aboard",
    word_lemma: "aboard",
    recent_ratings: ["good", "good", "good"],
    l1_weak_signal: false,
    ...overrides,
  } as ProgressWithContentHash;
}

function makeMockFsrsAdapter(): { adapter: FsrsAdapterFn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const adapter: FsrsAdapterFn = (...args) => {
    calls.push(args);
    return {
      difficulty: 0.4,
      dueAt: "2026-01-08T00:00:00Z",
      logDueAt: "2026-01-08T00:00:00Z",
      elapsedDays: 7,
      scheduledDays: 7,
      retrievability: 0.85,
      stability: 2.0,
      state: "review",
      nextPayload: { test: true } as Json,
    };
  };
  return { adapter, calls };
}

function makeMockReviewRepo(overrides: Partial<IReviewRepository> = {}): IReviewRepository {
  return {
    findDueCards: vi.fn(async () => []),
    checkIdempotency: vi.fn(async () => null),
    findProgressForUpdate: vi.fn(async () => makeMockProgress()),
    findProgressForSkip: vi.fn(async () => null),
    findProgressForSuspend: vi.fn(async () => null),
    findProgressForOutbox: vi.fn(async () => makeMockProgress()),
    saveAnswer: vi.fn(async () => ({ reviewLogId: "log-1" })),
    skipCard: vi.fn(async () => ({ reviewLogId: "log-skip" })),
    suspendCard: vi.fn(async () => ({ reviewLogId: "log-suspend" })),
    findReviewLogWordbookForUndo: vi.fn(async () => "wb1"),
    undoReviewLog: vi.fn(async () => ({
      success: true, progressId: "p1", wordId: "w1", errorMessage: null,
    } as UndoRpcResult)),
    findStaleCards: vi.fn(async () => []),
    markStaleForRecheck: vi.fn(async () => 0),
    markL1StaleForRecheck: vi.fn(async () => 0),
    markL1WeakSignal: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeMockOutboxRepo(overrides: Partial<IOutboxRepository> = {}): IOutboxRepository {
  return {
    enqueue: vi.fn(async () => ({ id: "event-1", inserted: true })),
    recoverExpiredLeases: vi.fn(async () => 0),
    claimBatch: vi.fn(async () => []),
    beginEffect: vi.fn(async () => true),
    completeEffect: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => "retry" as const),
    replayDeadLetter: vi.fn(async () => false),
    getMetrics: vi.fn(async () => ({ pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: null })),
    ...overrides,
  };
}

function makeMockSessionRepo(overrides: Partial<ISessionRepository> = {}): ISessionRepository {
  return {
    findActiveByUser: vi.fn(async () => null),
    getOrCreateToday: vi.fn(async () => ({ id: "s1" } as never)),
    create: vi.fn(async () => ({ id: "s1" } as never)),
    assertActiveOwned: vi.fn(async () => undefined),
    incrementCardsSeen: vi.fn(async () => undefined),
    incrementCardsSeenFromOutbox: vi.fn(async () => undefined),
    endSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("ReviewService.submitAnswer", () => {
  beforeEach(() => {
    // Reset mockRepos between tests
    Object.keys(mockRepos).forEach(k => delete (mockRepos as Record<string, unknown>)[k]);
    mockRepos.outbox = makeMockOutboxRepo();
  });

  it("returns idempotent result when idempotencyKey already exists", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      checkIdempotency: vi.fn(async () => "existing-log-id"),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.submitAnswer({
      progressId: "p1", rating: "good", sessionId: "s1", idempotencyKey: "key-1",
    }, "u1");

    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(result.reviewLogId).toBe("existing-log-id");
    // Should NOT call findProgressForUpdate or saveAnswer
    expect(reviewRepo.findProgressForUpdate).not.toHaveBeenCalled();
    expect(reviewRepo.saveAnswer).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when progress not found", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForUpdate: vi.fn(async () => null),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.submitAnswer({
      progressId: "missing", rating: "good", sessionId: "s1",
    }, "u1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws BusinessRuleError when card is suspended", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForUpdate: vi.fn(async () => makeMockProgress({ state: "suspended" })),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.submitAnswer({
      progressId: "p1", rating: "good", sessionId: "s1",
    }, "u1")).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it("calls fsrsAdapter with correct params and persists", async () => {
    const { adapter, calls } = makeMockFsrsAdapter();
    const progress = makeMockProgress();
    const reviewRepo = makeMockReviewRepo({
      findProgressForUpdate: vi.fn(async () => progress),
    });
    const sessionRepo = makeMockSessionRepo();
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = sessionRepo;

    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => [1, 2, 3],
    });
    const result = await service.submitAnswer({
      progressId: "p1", rating: "good", sessionId: "s1", idempotencyKey: "key-1",
    }, "u1");

    expect(result.ok).toBe(true);
    expect(result.reviewLogId).toBe("log-1");

    // FSRS adapter was called with scheduler_payload, rating, Date, desired_retention, weights
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe("good");  // rating
    expect(calls[0][3]).toBe(0.9);     // desired_retention
    expect(calls[0][4]).toEqual([1, 2, 3]);  // weights

    // saveAnswer was called with contentHash (M-NEW-4)
    expect(reviewRepo.saveAnswer).toHaveBeenCalledTimes(1);
    const saveInput = (reviewRepo.saveAnswer as ReturnType<typeof vi.fn>).mock.calls[0][0] as SaveAnswerInput;
    expect(saveInput.contentHash).toBe("current-hash");
    expect(saveInput.wordId).toBe("w1");
    expect(saveInput.wordbookId).toBe("wb1");

    // Durable event is written inside the authoritative transaction.
    expect(mockRepos.outbox?.enqueue).toHaveBeenCalledTimes(1);
    expect(mockRepos.outbox?.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      aggregateType: "review_log",
      aggregateId: "log-1",
      eventType: "review.answer.recorded.v1",
      dedupeKey: "review.answer.recorded.v1:log-1",
    }));
  });

  it("writes the outbox event before the transaction callback returns", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const enqueuePhases: boolean[] = [];
    mockRepos.reviews = makeMockReviewRepo();
    mockRepos.sessions = makeMockSessionRepo();
    mockRepos.outbox = makeMockOutboxRepo({
      enqueue: vi.fn(async () => {
        enqueuePhases.push(transactionCallbackActive);
        return { id: "event-1", inserted: true };
      }),
    });

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await service.submitAnswer({ progressId: "p1", rating: "good", sessionId: "s1" }, "u1");

    expect(enqueuePhases).toEqual([true]);
  });

  it("fails the authoritative transaction when durable event enqueue fails", async () => {
    const { adapter } = makeMockFsrsAdapter();
    mockRepos.reviews = makeMockReviewRepo();
    mockRepos.sessions = makeMockSessionRepo();
    mockRepos.outbox = makeMockOutboxRepo({
      enqueue: vi.fn(async () => { throw new Error("outbox unavailable"); }),
    });

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.submitAnswer({ progressId: "p1", rating: "good", sessionId: "s1" }, "u1"))
      .rejects.toThrow("outbox unavailable");
  });
});

describe("ReviewService.skip", () => {
  beforeEach(() => {
    Object.keys(mockRepos).forEach(k => delete (mockRepos as Record<string, unknown>)[k]);
    mockRepos.outbox = makeMockOutboxRepo();
  });

  it("returns idempotent when key exists", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      checkIdempotency: vi.fn(async () => "existing"),
    });
    mockRepos.reviews = reviewRepo;

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.skip(
      { progressId: "p1", sessionId: "s1", idempotencyKey: "key" },
      "u1",
    );

    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
  });

  it("throws NotFoundError when progress not found", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForSkip: vi.fn(async () => null),
    });
    mockRepos.reviews = reviewRepo;

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.skip(
      { progressId: "missing", sessionId: "s1" },
      "u1",
    )).rejects.toBeInstanceOf(NotFoundError);
  });

  it("skips card successfully", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForSkip: vi.fn(async () => ({
        id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 3,
      })),
      skipCard: vi.fn(async () => ({ reviewLogId: "log-skip" })),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.skip(
      { progressId: "p1", sessionId: "s1", idempotencyKey: "key" },
      "u1",
    );

    expect(result.ok).toBe(true);
    expect(reviewRepo.skipCard).toHaveBeenCalledTimes(1);
  });

  it("rejects a Session outside the progress owner/wordbook scope", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForSkip: vi.fn(async () => ({
        id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 3,
      })),
    });
    const sessionRepo = makeMockSessionRepo({
      assertActiveOwned: vi.fn(async () => { throw new NotFoundError("Session", "foreign-session"); }),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = sessionRepo;

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.skip(
      { progressId: "p1", sessionId: "foreign-session" },
      "u1",
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(sessionRepo.assertActiveOwned).toHaveBeenCalledWith("foreign-session", "u1", "wb1");
    expect(reviewRepo.skipCard).not.toHaveBeenCalled();
  });
});

describe("ReviewService.suspend", () => {
  beforeEach(() => {
    Object.keys(mockRepos).forEach(k => delete (mockRepos as Record<string, unknown>)[k]);
    mockRepos.outbox = makeMockOutboxRepo();
  });

  it("suspends card successfully", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForSuspend: vi.fn(async () => ({
        id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 0,
      })),
      suspendCard: vi.fn(async () => ({ reviewLogId: "log-suspend" })),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.suspend(
      { progressId: "p1", sessionId: "s1", idempotencyKey: "key" },
      "u1",
    );

    expect(result.ok).toBe(true);
    expect(reviewRepo.suspendCard).toHaveBeenCalledTimes(1);
  });

  it("handles optional sessionId (null)", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findProgressForSuspend: vi.fn(async () => ({
        id: "p1", word_id: "w1", wordbook_id: "wb1", state: "review" as const, skip_count: 0,
      })),
    });
    mockRepos.reviews = reviewRepo;

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.suspend(
      { progressId: "p1" },
      "u1",
    );

    expect(result.ok).toBe(true);
  });
});

describe("ReviewService.undo", () => {
  beforeEach(() => {
    Object.keys(mockRepos).forEach(k => delete (mockRepos as Record<string, unknown>)[k]);
    mockRepos.outbox = makeMockOutboxRepo();
  });

  it("undoes successfully", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo();
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.undo(
      { reviewLogId: "log-1", sessionId: "s1", idempotencyKey: "key" },
      "u1",
    );

    expect(result.ok).toBe(true);
    expect(reviewRepo.findReviewLogWordbookForUndo).toHaveBeenCalledWith("log-1", "u1");
    expect(mockRepos.sessions?.assertActiveOwned).toHaveBeenCalledWith("s1", "u1", "wb1");
    expect(reviewRepo.undoReviewLog).toHaveBeenCalledWith("log-1", "u1", "wb1", "s1", "key");
  });

  it("does not reveal or mutate another user's review log", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      findReviewLogWordbookForUndo: vi.fn(async () => null),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.undo(
      { reviewLogId: "foreign-log", sessionId: "foreign-session" },
      "u1",
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(mockRepos.sessions?.assertActiveOwned).not.toHaveBeenCalled();
    expect(reviewRepo.undoReviewLog).not.toHaveBeenCalled();
  });

  it("throws BusinessRuleError when undo fails", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const reviewRepo = makeMockReviewRepo({
      undoReviewLog: vi.fn(async () => ({
        success: false, progressId: null, wordId: null, errorMessage: "找不到日志",
      } as UndoRpcResult)),
    });
    mockRepos.reviews = reviewRepo;
    mockRepos.sessions = makeMockSessionRepo();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.undo(
      { reviewLogId: "bad", sessionId: "s1" },
      "u1",
    )).rejects.toBeInstanceOf(BusinessRuleError);
  });
});
