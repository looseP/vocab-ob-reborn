import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IOutboxRepository, IRepositories, IReviewRepository, ISessionRepository, InsertNewCardStatus } from "@/repositories/interfaces";
import type { ProgressWithContentHash, SaveAnswerInput, UndoRpcResult } from "@/repositories/interfaces";
import { ReviewService, type FsrsAdapterFn } from "@/services/review.service";
import { REVIEW_QUEUE_CANDIDATE_LIMIT } from "@/services/review-queue";
import { NotFoundError, BusinessRuleError } from "@/errors";
import type { UserWordProgressRow, Json } from "@/domain";

// ── Mock infrastructure ─────────────────────────────────────────────────
// Mock withTransaction to directly call the callback with a fake tx,
// and mock createRepositories to return our mock repos.
const mockRepos: Partial<IRepositories> = {};
let transactionCallbackActive = false;

const { withTransactionMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(async (
    cb: (tx: unknown) => Promise<unknown>,
    _options?: { actorId?: string },
  ) => {
    transactionCallbackActive = true;
    try {
      return await cb({});
    } finally {
      transactionCallbackActive = false;
    }
  }),
}));

vi.mock("@/db/transaction", () => ({
  withTransaction: withTransactionMock,
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
    findDueCandidates: vi.fn(async () => []),
    findPracticeCards: vi.fn(async () => []),
    findWordsByIds: vi.fn(async () => []),
    findDrillCandidates: vi.fn(async () => []),
    checkIdempotency: vi.fn(async () => null),
    findProgressForUpdate: vi.fn(async () => makeMockProgress()),
    findProgressForSkip: vi.fn(async () => null),
    findProgressForSuspend: vi.fn(async () => null),
    findProgressForOutbox: vi.fn(async () => makeMockProgress()),
    insertNewCard: vi.fn(async (): Promise<InsertNewCardStatus> => ({ status: "inserted", progressId: "p-new" })),
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
    withTransactionMock.mockClear();
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
    expect(withTransactionMock).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
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
    withTransactionMock.mockClear();
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
    expect(withTransactionMock).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
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
    withTransactionMock.mockClear();
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
    expect(withTransactionMock).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
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
    withTransactionMock.mockClear();
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
    expect(withTransactionMock).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
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

// ── Frontend rebuild: queue / stats / leeches / timeline / heatmap ──────
describe("ReviewService — rebuild read methods", () => {
  function makeProgressRow(overrides: Partial<UserWordProgressRow> = {}): UserWordProgressRow {
    return {
      id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
      desired_retention: 0.9, due_at: "2026-01-01T00:00:00Z", last_reviewed_at: null,
      last_rating: "good", review_count: 3, lapse_count: 4, again_count: 1,
      hard_count: 0, good_count: 2, easy_count: 0, interval_days: 7,
      scheduler_payload: {} as Json,
      content_hash_snapshot: "old-hash",
      l1_content_hash_snapshot: null,
      recent_ratings: [],
      l1_weak_signal: false,
      skip_count: 0,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
      ...overrides,
    };
  }

  it("getQueue returns cards with session and stats, forwarding the mode", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findDueCards = vi.fn(async () => [{
      progress: makeProgressRow(),
      word: { id: "w-9", slug: "abound", title: "Abound", lemma: "abound", short_definition: "def", ipa: null, pos: "verb", cefr: "C1" },
    }]);
    const getOrCreateTodaySession = vi.fn(async () => ({
      id: "s1", user_id: "u1", wordbook_id: "wb1", mode: "cram",
      cards_seen: 2, started_at: "2026-08-16T00:00:00Z", ended_at: null,
    }));
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null, findDueCards, getOrCreateTodaySession });

    const queue = await service.getQueue("u1", "wb1", 20, "cram");

    expect(queue.items).toEqual([{
      progressId: "p1",
      word: { id: "w-9", slug: "abound", title: "Abound", lemma: "abound", short_definition: "def", ipa: null, pos: "verb", cefr: "C1" },
      state: "review",
      dueAt: "2026-01-01T00:00:00Z",
      lastRating: "good",
      reviewCount: 3,
      l1WeakSignal: false,
    }]);
    expect(queue.session).toEqual({ id: "s1", mode: "cram", cardsSeen: 2 });
    expect(queue.stats).toEqual({ total: 1, remaining: 1 });
    expect(getOrCreateTodaySession).toHaveBeenCalledWith("u1", "wb1", "cram");
  });

  it("getQueue fails closed when queue dependencies are not configured", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.getQueue("u1", "wb1")).rejects.toThrow("Review queue dependencies not configured");
  });

  it("getStats delegates to the stats dependency and fails closed without it", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const stats = { todayCount: 3, totalCount: 30, ratingDist: { again: 1, hard: 2, good: 5, easy: 2 } };
    const getReviewStats = vi.fn(async () => stats);
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null, getReviewStats });

    await expect(service.getStats("u1", "wb1")).resolves.toEqual(stats);
    expect(getReviewStats).toHaveBeenCalledWith("u1", "wb1");

    const bare = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(bare.getStats("u1", "wb1")).rejects.toThrow("getReviewStats not configured");
  });

  it("getLeeches maps joined rows to card summaries and fails closed without the dependency", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findLeeches = vi.fn(async () => [{
      ...makeProgressRow({ id: "p2", due_at: null }),
      slug: "abound", title: "Abound", lemma: "abound", w_id: "w-9", short_definition: "def",
    }]);
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null, findLeeches });

    const leeches = await service.getLeeches("u1", "wb1", 5);

    expect(leeches).toEqual([{
      progressId: "p2",
      word: { id: "w-9", slug: "abound", title: "Abound", lemma: "abound", short_definition: "def" },
      lapseCount: 4,
      state: "review",
      dueAt: null,
    }]);
    expect(findLeeches).toHaveBeenCalledWith("u1", "wb1", 5);

    const bare = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(bare.getLeeches("u1", "wb1")).rejects.toThrow("findLeeches not configured");
  });

  it("getTimeline and getHeatmap pass through their dependencies and fail closed without them", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const timelineRows = [{ id: "rl1", rating: "good", created_at: "2026-08-01T00:00:00Z", word_slug: "abound", word_lemma: "abound" }];
    const heatmapRows = [{ date: "2026-08-01", count: "7" }];
    const getTimeline = vi.fn(async () => timelineRows);
    const getHeatmap = vi.fn(async () => heatmapRows);
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null, getTimeline, getHeatmap });

    await expect(service.getTimeline("u1", "wb1", 50)).resolves.toEqual(timelineRows);
    expect(getTimeline).toHaveBeenCalledWith("u1", "wb1", 50);
    await expect(service.getHeatmap("u1", "wb1", 365)).resolves.toEqual(heatmapRows);
    expect(getHeatmap).toHaveBeenCalledWith("u1", "wb1", 365);

    const bare = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(bare.getTimeline("u1", "wb1")).rejects.toThrow();
    await expect(bare.getHeatmap("u1", "wb1")).rejects.toThrow();
  });

  it("clearL1WeakSignal delegates to the dependency and returns ok", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const clearL1WeakSignal = vi.fn(async () => 1);
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null, clearL1WeakSignal });

    await expect(service.clearL1WeakSignal({ wordbookId: "wb1", wordId: "w1" }, "u1")).resolves.toEqual({ ok: true });
    expect(clearL1WeakSignal).toHaveBeenCalledWith("u1", "wb1", "w1");
  });

  it("clearL1WeakSignal throws NotFoundError when no row updated", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const clearL1WeakSignal = vi.fn(async () => 0);
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null, clearL1WeakSignal });

    await expect(service.clearL1WeakSignal({ wordbookId: "wb1", wordId: "w1" }, "u1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("clearL1WeakSignal fails closed without the dependency", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });

    await expect(service.clearL1WeakSignal({ wordbookId: "wb1", wordId: "w1" }, "u1")).rejects.toThrow(
      /clearL1WeakSignal dependency not configured/,
    );
  });
});

// ── P0: practice modes (cram / preview) side-effect boundaries ──────────
describe("ReviewService — P0 practice-mode behavior", () => {
  function makeProgressRow(overrides: Partial<UserWordProgressRow> = {}): UserWordProgressRow {
    return {
      id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
      desired_retention: 0.9, due_at: "2026-01-01T00:00:00Z", last_reviewed_at: null,
      last_rating: "good", review_count: 3, lapse_count: 0, again_count: 0,
      hard_count: 0, good_count: 3, easy_count: 0, interval_days: 7,
      scheduler_payload: {} as Json,
      content_hash_snapshot: "old-hash",
      l1_content_hash_snapshot: null,
      recent_ratings: [],
      l1_weak_signal: false,
      skip_count: 0,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
      ...overrides,
    };
  }

  function makePracticeCard() {
    return {
      progress: makeProgressRow(),
      word: { id: "w-9", slug: "abound", title: "Abound", lemma: "abound", short_definition: "def", ipa: null, pos: "verb", cefr: "C1" },
    };
  }

  function makeSession(mode: string) {
    return vi.fn(async () => ({
      id: "s1", user_id: "u1", wordbook_id: "wb1", mode,
      cards_seen: 0, started_at: "2026-08-16T00:00:00Z", ended_at: null,
    }));
  }

  it("getQueue routes cram/preview to findPracticeCards and review to findDueCards", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findDueCards = vi.fn(async () => [makePracticeCard()]);
    const findPracticeCards = vi.fn(async () => [makePracticeCard()]);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards,
      findPracticeCards,
      getOrCreateTodaySession: makeSession("cram"),
    });

    // cram → practice deck, NOT the due deck
    await service.getQueue("u1", "wb1", 20, "cram");
    expect(findPracticeCards).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(findDueCards).not.toHaveBeenCalled();

    // preview → practice deck, NOT the due deck
    findPracticeCards.mockClear();
    findDueCards.mockClear();
    await service.getQueue("u1", "wb1", 20, "preview");
    expect(findPracticeCards).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(findDueCards).not.toHaveBeenCalled();

    // review → due deck only
    findPracticeCards.mockClear();
    findDueCards.mockClear();
    await service.getQueue("u1", "wb1", 20, "review");
    expect(findDueCards).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(findPracticeCards).not.toHaveBeenCalled();
  });

  it("getQueue falls back to findDueCards when findPracticeCards is not wired", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findDueCards = vi.fn(async () => []);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards,
      getOrCreateTodaySession: makeSession("cram"),
    });

    await service.getQueue("u1", "wb1", 20, "cram");
    expect(findDueCards).toHaveBeenCalledWith("u1", "wb1", 20);
  });

  it("getQueue forwards the practice mode to the session", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const getOrCreateTodaySession = makeSession("preview");
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards: vi.fn(async () => []),
      findPracticeCards: vi.fn(async () => []),
      getOrCreateTodaySession,
    });

    await service.getQueue("u1", "wb1", 20, "preview");
    expect(getOrCreateTodaySession).toHaveBeenCalledWith("u1", "wb1", "preview");
  });

  it("submitAnswer in cram mode is a no-persistence self-test (no tx, no repos, no outbox)", async () => {
    const { adapter } = makeMockFsrsAdapter();
    mockRepos.reviews = makeMockReviewRepo();
    mockRepos.sessions = makeMockSessionRepo();
    mockRepos.outbox = makeMockOutboxRepo();
    withTransactionMock.mockClear();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.submitAnswer(
      { progressId: "p1", rating: "good", sessionId: "s1", mode: "cram" },
      "u1",
    );

    expect(result.ok).toBe(true);
    expect(result.state).toBe("practice");
    expect(result.reviewLogId).toMatch(/^cram-/);
    // Cram must NOT touch the database at all.
    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(mockRepos.reviews?.findProgressForUpdate).not.toHaveBeenCalled();
    expect(mockRepos.reviews?.saveAnswer).not.toHaveBeenCalled();
    expect(mockRepos.outbox?.enqueue).not.toHaveBeenCalled();
  });

  it("submitAnswer outside cram still runs the transaction path", async () => {
    const { adapter } = makeMockFsrsAdapter();
    mockRepos.reviews = makeMockReviewRepo();
    mockRepos.sessions = makeMockSessionRepo();
    mockRepos.outbox = makeMockOutboxRepo();
    withTransactionMock.mockClear();

    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    const result = await service.submitAnswer(
      { progressId: "p1", rating: "good", sessionId: "s1", mode: "preview" },
      "u1",
    );

    expect(result.ok).toBe(true);
    expect(result.state).toBe("review");
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(mockRepos.reviews?.saveAnswer).toHaveBeenCalledTimes(1);
  });
});

// ── P1: queue-priority routing (review/zen candidate builder) ────────────
describe("ReviewService — P1 queue-priority routing", () => {
  function makeProgressRow(overrides: Partial<UserWordProgressRow> = {}): UserWordProgressRow & { needs_recheck: boolean } {
    return {
      id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
      desired_retention: 0.9, due_at: "2026-01-01T00:00:00Z", last_reviewed_at: null,
      last_rating: "good", review_count: 3, lapse_count: 0, again_count: 0,
      hard_count: 0, good_count: 3, easy_count: 0, interval_days: 7,
      scheduler_payload: {} as Json,
      content_hash_snapshot: "old-hash",
      l1_content_hash_snapshot: null,
      recent_ratings: [],
      l1_weak_signal: false,
      skip_count: 0,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
      needs_recheck: false,
      ...overrides,
    };
  }

  function makeWord(id = "w-1") {
    return { id, slug: "abound", title: "Abound", lemma: "abound", short_definition: "def", ipa: null, pos: "verb", cefr: "C1" };
  }

  function makeSession(mode: string) {
    return vi.fn(async () => ({
      id: "s1", user_id: "u1", wordbook_id: "wb1", mode,
      cards_seen: 0, started_at: "2026-08-16T00:00:00Z", ended_at: null,
    }));
  }

  it("routes review mode through the priority builder and attaches queue metadata", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const candidates = [
      { progress: makeProgressRow({ state: "review" }), word: makeWord("w-1") },
      { progress: makeProgressRow({ id: "p2", state: "new" }), word: makeWord("w-2") },
    ];
    const findDueCandidates = vi.fn(async () => candidates);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards: vi.fn(async () => []),
      findDueCandidates,
      getOrCreateTodaySession: makeSession("review"),
    });

    const queue = await service.getQueue("u1", "wb1", 20, "review");

    expect(findDueCandidates).toHaveBeenCalledWith("u1", "wb1", REVIEW_QUEUE_CANDIDATE_LIMIT);
    expect(queue.stats).toEqual({ total: 2, remaining: 2, deferredNewCards: 0 });
    // review 卡带队列优先级元数据
    expect(queue.items[0].queueBucket).toBe("overdue");
    expect(queue.items[0].queueLabel).toBe("到期复习");
    expect(typeof queue.items[0].queueReason).toBe("string");
    // new 卡殿后
    expect(queue.items[1].queueBucket).toBe("new");
  });

  it("falls back to findDueCards when the candidate pool is empty", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findDueCards = vi.fn(async () => [{
      progress: makeProgressRow(),
      word: makeWord("w-1"),
    }]);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards,
      findDueCandidates: vi.fn(async () => []),
      getOrCreateTodaySession: makeSession("review"),
    });

    const queue = await service.getQueue("u1", "wb1", 20, "review");
    expect(findDueCards).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(queue.stats).toEqual({ total: 1, remaining: 1 });
  });

  it("falls back to findDueCards when findDueCandidates is not wired", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findDueCards = vi.fn(async () => [{
      progress: makeProgressRow(),
      word: makeWord("w-1"),
    }]);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards,
      getOrCreateTodaySession: makeSession("review"),
    });

    const queue = await service.getQueue("u1", "wb1", 20, "review");
    expect(findDueCards).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(queue.items[0].queueBucket).toBeUndefined();
  });
});

// ── P2: free-review selection (wordIds) ──────────────────────────────────
describe("ReviewService — P2 free-review selection", () => {
  function makeWord(id: string) {
    return { id, slug: `slug-${id}`, title: `Title ${id}`, lemma: `lemma-${id}`, short_definition: "def", ipa: null, pos: "verb", cefr: "C1" };
  }

  function makeSession() {
    return vi.fn(async () => ({
      id: "s1", user_id: "u1", wordbook_id: "wb1", mode: "preview",
      cards_seen: 0, started_at: "2026-08-16T00:00:00Z", ended_at: null,
    }));
  }

  it("routes preview+wordIds through findWordsByIds preserving selection order", async () => {
    const { adapter } = makeMockFsrsAdapter();
    // 返回顺序与传入不一致，验证 service 按 wordIds 保序
    const findWordsByIds = vi.fn(async () => [makeWord("w-2"), makeWord("w-1"), makeWord("w-3")]);
    const findPracticeCards = vi.fn(async () => []);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards: vi.fn(async () => []),
      findPracticeCards,
      findWordsByIds,
      getOrCreateTodaySession: makeSession(),
    });

    const queue = await service.getQueue("u1", "wb1", 20, "preview", ["w-1", "w-2", "w-3"]);

    expect(findWordsByIds).toHaveBeenCalledWith("u1", ["w-1", "w-2", "w-3"]);
    expect(findPracticeCards).not.toHaveBeenCalled();
    expect(queue.items.map((i) => i.word.id)).toEqual(["w-1", "w-2", "w-3"]);
    expect(queue.items[0].state).toBe("new");
    expect(queue.session.mode).toBe("preview");
    expect(queue.stats).toEqual({ total: 3, remaining: 3 });
  });

  it("ignores empty wordIds and falls back to the practice deck", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findWordsByIds = vi.fn(async () => [makeWord("w-1")]);
    const findPracticeCards = vi.fn(async () => []);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDueCards: vi.fn(async () => []),
      findPracticeCards,
      findWordsByIds,
      getOrCreateTodaySession: makeSession(),
    });

    const queue = await service.getQueue("u1", "wb1", 20, "preview", []);

    expect(findWordsByIds).not.toHaveBeenCalled();
    expect(findPracticeCards).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(queue.stats).toEqual({ total: 0, remaining: 0 });
  });
});

// ── 补全：drill candidates (cram 练习变体) ────────────────────────────────
describe("ReviewService — drill candidates", () => {
  it("resolves cloze from examples and filters unmatchable words", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const findDrillCandidates = vi.fn(async () => [
      {
        progress: { id: "p1", state: "review" } as UserWordProgressRow,
        word: {
          id: "w1", slug: "abandon", title: "Abandon", lemma: "abandon",
          short_definition: "放弃",
          examples: [{ text: "He decided to abandon the plan." }] as unknown as Json,
        },
      },
      {
        progress: { id: "p2", state: "review" } as UserWordProgressRow,
        word: {
          id: "w2", slug: "x", title: "X", lemma: "unmatchable",
          short_definition: null,
          examples: [{ text: "Nothing here." }] as unknown as Json,
        },
      },
    ]);
    const service = new ReviewService({
      fsrsAdapter: adapter,
      loadWeights: async () => null,
      findDrillCandidates,
    });

    const items = await service.getDrillCandidates("u1", "wb1", 20);

    expect(findDrillCandidates).toHaveBeenCalledWith("u1", "wb1", 20);
    expect(items).toHaveLength(1);
    expect(items[0].lemma).toBe("abandon");
    expect(items[0].clozeText).toContain("▢▢▢");
    expect(items[0].clozeLength).toBe(7);
  });

  it("fails closed without findDrillCandidates", async () => {
    const { adapter } = makeMockFsrsAdapter();
    const service = new ReviewService({ fsrsAdapter: adapter, loadWeights: async () => null });
    await expect(service.getDrillCandidates("u1", "wb1")).rejects.toThrow(
      /findDrillCandidates not configured/,
    );
  });
});
