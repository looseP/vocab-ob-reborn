/**
 * L2ReviewService 单元测试 —— FR-12 接线1 / 缺口1.3
 *
 * 验证点：
 * - 幂等重放路径（idempotencyKey 命中即返回，不触达 FSRS / saveL2Answer / outbox）
 * - 暂停卡拒答（spec §六 红线：paused 不可答）
 * - 缺失 progress 抛 NotFoundError
 * - weights 回退链：loadL2Weights → loadWeights → null（双轨 spec §十）
 * - 空 payload 读侧兜底：rebuildSchedulerPayloadIfEmpty 从行上标量列重建
 * - H3 列对齐：saveL2Answer 收到真实的 elapsedDays（不是 scheduledDays 错填）
 * - outbox.enqueue 入队 track='l2' 事件（FR-12 接线1）
 *
 * 测试策略：直接调用 answerWithinTx（package-private 入参版本），注入 mock repos，
 * 不触达 withTransaction / createRepositories，避免模块 mock 噪音。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BusinessRuleError, NotFoundError } from "@/errors";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(),
}));

import { createRepositories } from "@/repositories/factory";
import type { UserWordL2ProgressRow } from "@/domain";
import type {
  IL2ProgressRepository,
  IOutboxRepository,
  ISessionRepository,
  IReviewRepository,
} from "@/repositories/interfaces";
import {
  L2ReviewService,
  rebuildSchedulerPayloadIfEmpty,
} from "@/services/l2-review.service";
import type { FsrsScheduling } from "@/services/review.service";

const USER_ID = "00000000-0000-4000-8000-000000000104";
const WORDBOOK_ID = "00000000-0000-4000-8000-000000000105";
const WORD_ID = "00000000-0000-4000-8000-000000000106";
const PROGRESS_ID = "00000000-0000-4000-8000-000000000107";
const SESSION_ID = "00000000-0000-4000-8000-000000000103";
const REVIEW_LOG_ID = "00000000-0000-4000-8000-000000000201";

function makeProgressRow(overrides: Partial<UserWordL2ProgressRow> = {}): UserWordL2ProgressRow {
  return {
    id: PROGRESS_ID,
    user_id: USER_ID,
    word_id: WORD_ID,
    wordbook_id: WORDBOOK_ID,
    l2_stability: 3.5,
    l2_difficulty: 5.0,
    l2_retrievability: 0.85,
    l2_state: "review",
    l2_desired_retention: 0.9,
    l2_due_at: "2026-08-20T00:00:00Z",
    l2_last_reviewed_at: null,
    l2_last_rating: null,
    l2_review_count: 2,
    l2_lapse_count: 0,
    l2_interval_days: null,
    l2_scheduler_payload: {
      due: "2026-08-20T00:00:00Z",
      stability: 3,
      difficulty: 5,
      state: 2,
    },
    l2_again_count: 0,
    l2_hard_count: 0,
    l2_good_count: 2,
    l2_easy_count: 0,
    l2_content_hash_snapshot: "l2:word:prog",
    recent_ratings: ["good", "good"],
    l2_paused: false,
    l2_paused_at: null,
    l2_paused_reason: null,
    l2_inherited_from_l1: true,
    l2_weights_source: "fsrs_l2_weights",
    l2_predicted_retrievability: null,
    l2_production_status: null,
    created_at: "2026-08-25T00:00:00Z",
    ...overrides,
  };
}

function makeScheduling(overrides: Partial<FsrsScheduling> = {}): FsrsScheduling {
  return {
    difficulty: 5.0,
    dueAt: "2026-09-25T00:00:00Z",
    logDueAt: null,
    elapsedDays: 1,
    scheduledDays: 10,
    retrievability: 0.85,
    stability: 3.5,
    state: "review" as const,
    nextPayload: {
      due: "2026-09-25T00:00:00Z",
      stability: 3.5,
      difficulty: 5.0,
      state: 2,
      elapsed_days: 1,
      scheduled_days: 10,
      reps: 3,
      lapses: 0,
      learning_steps: 0,
      last_review: "2026-08-25T00:00:00Z",
    },
    ...overrides,
  };
}

interface MockRepos {
  l2Progress: IL2ProgressRepository;
  reviews: IReviewRepository;
  sessions: ISessionRepository;
  outbox: IOutboxRepository;
}

function makeMockRepos(): MockRepos {
  return {
    l2Progress: {
      findForUpdate: vi.fn(async () => null),
      saveL2Answer: vi.fn(async () => ({ reviewLogId: REVIEW_LOG_ID })),
      updateProductionStatus: vi.fn(async () => undefined),
      insertDrillStepIfAbsent: vi.fn(async () => ({}) as never),
      findDrillStepForUpdate: vi.fn(async () => null),
      findDrillStepBySessionWordStep: vi.fn(async () => null),
      findLastDrillStep: vi.fn(async () => null),
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
      findByWordbookWordAndUser: vi.fn(async () => null),
      findDueCards: vi.fn(async () => []),
      insert: vi.fn(async () => ({}) as never),
    } as unknown as IL2ProgressRepository,
    reviews: {
      checkIdempotency: vi.fn(async () => null),
      markL1WeakSignal: vi.fn(async () => 0),
      findProgressForOutbox: vi.fn(async () => null),
    } as unknown as IReviewRepository,
    sessions: {
      assertActiveOwned: vi.fn(async () => undefined),
    } as unknown as ISessionRepository,
    outbox: {
      enqueue: vi.fn(async () => ({ id: "event-1", inserted: true })),
    } as unknown as IOutboxRepository,
  };
}

/**
 * 构造 L2ReviewService 用于幂等/NotFound/paused/session-failure 等不进入 FSRS 的路径。
 * 返回 fsrsAdapter mock 供调用计数断言（这些路径预期 fsrsAdapter 不被调用）。
 */
function makeService(): { service: L2ReviewService; fsrsAdapter: ReturnType<typeof vi.fn> } {
  const fsrsAdapter = vi.fn(() => makeScheduling());
  const service = new L2ReviewService({
    fsrsAdapter: fsrsAdapter as never,
    loadWeights: vi.fn(async () => null) as never,
    loadL2Weights: vi.fn(async () => null) as never,
  });
  return { service, fsrsAdapter };
}

beforeEach(() => {
  // 每个 it 重新构建 fixture，无需全局 reset
});

// ─── rebuildSchedulerPayloadIfEmpty：空 payload 读侧兜底 ───────────────────

describe("rebuildSchedulerPayloadIfEmpty (spec §四 读侧兜底)", () => {
  it("returns payload as-is when it has a valid due field", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: {
        due: "2026-08-20T00:00:00Z",
        stability: 3,
        difficulty: 5,
        state: 2,
      },
    });
    const result = rebuildSchedulerPayloadIfEmpty(row);
    expect(result).toEqual(row.l2_scheduler_payload);
  });

  it("rebuilds from scalar columns when payload is null", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: null,
      l2_stability: 4.2,
      l2_difficulty: 6.1,
      l2_due_at: "2026-09-01T00:00:00Z",
      l2_last_reviewed_at: "2026-08-15T00:00:00Z",
      l2_review_count: 5,
    });
    const result = rebuildSchedulerPayloadIfEmpty(row) as Record<string, unknown>;
    // 必须从标量列重建，而不是抛异常
    expect(result).toMatchObject({
      difficulty: 6.1,
      due: "2026-09-01T00:00:00.000Z",
      elapsed_days: 0,
      lapses: 0,
      learning_steps: 0,
      last_review: "2026-08-15T00:00:00.000Z",
      reps: 5,
      scheduled_days: 0,
      stability: 4.2,
      state: 2, // ts-fsrs State.Review
    });
  });

  it("rebuilds when payload is an empty object (no due field)", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: {},
      l2_due_at: "2026-09-01T00:00:00Z",
    });
    const result = rebuildSchedulerPayloadIfEmpty(row) as Record<string, unknown>;
    expect(result).toMatchObject({
      due: "2026-09-01T00:00:00.000Z",
      state: 2,
    });
  });

  it("rebuilds when payload is an array (malformed)", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: [1, 2, 3],
      l2_due_at: "2026-09-01T00:00:00Z",
    });
    const result = rebuildSchedulerPayloadIfEmpty(row) as Record<string, unknown>;
    expect(result).toMatchObject({ due: "2026-09-01T00:00:00.000Z" });
  });

  it("rebuilds when payload due is not a parseable date", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: { due: "not-a-date" },
      l2_due_at: "2026-09-01T00:00:00Z",
    });
    const result = rebuildSchedulerPayloadIfEmpty(row) as Record<string, unknown>;
    expect(result).toMatchObject({ due: "2026-09-01T00:00:00.000Z" });
  });

  it("throws BusinessRuleError when both payload and l2_due_at are missing", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: null,
      l2_due_at: null,
    });
    expect(() => rebuildSchedulerPayloadIfEmpty(row)).toThrow(BusinessRuleError);
    expect(() => rebuildSchedulerPayloadIfEmpty(row)).toThrow(/missing due date and scheduler payload/);
  });

  it("uses default stability=1 when l2_stability is null", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: null,
      l2_stability: null,
      l2_difficulty: null,
      l2_due_at: "2026-09-01T00:00:00Z",
    });
    const result = rebuildSchedulerPayloadIfEmpty(row) as Record<string, unknown>;
    expect(result.stability).toBe(1);
    expect(result.difficulty).toBe(5); // null → 5 default
  });

  it("defaults reps=0 when l2_review_count is 0", () => {
    const row = makeProgressRow({
      l2_scheduler_payload: null,
      l2_review_count: 0,
      l2_due_at: "2026-09-01T00:00:00Z",
      l2_last_reviewed_at: null,
    });
    const result = rebuildSchedulerPayloadIfEmpty(row) as Record<string, unknown>;
    expect(result.reps).toBe(0);
    expect(result.last_review).toBeNull();
  });
});

// ─── answerWithinTx：幂等重放、暂停、weights 回退 ─────────────────────────

describe("L2ReviewService.answerWithinTx (FR-12 接线1)", () => {
  it("returns existing log id on idempotency hit (skips FSRS + save + outbox)", async () => {
    const { service, fsrsAdapter } = makeService();
    const repos = makeMockRepos();
    (repos.reviews.checkIdempotency as ReturnType<typeof vi.fn>).mockResolvedValue(REVIEW_LOG_ID);

    const result = await service.answerWithinTx(
      repos,
      {
        progressId: PROGRESS_ID,
        sessionId: SESSION_ID,
        rating: "good",
        idempotencyKey: "idem-1",
      },
      USER_ID,
    );

    expect(result).toEqual({
      ok: true,
      reviewLogId: REVIEW_LOG_ID,
      idempotent: true,
      mappedRating: "good",
      nextDueAt: "",
      state: "",
    });
    // 不应触达 FSRS / saveL2Answer / outbox（幂等重放零副作用）
    expect(fsrsAdapter.mock.calls.length).toBe(0);
    expect(repos.l2Progress.saveL2Answer).not.toHaveBeenCalled();
    expect(repos.outbox.enqueue).not.toHaveBeenCalled();
    expect(repos.l2Progress.findForUpdate).not.toHaveBeenCalled();
    expect(repos.sessions.assertActiveOwned).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when L2 progress is missing", async () => {
    const { service } = makeService();
    const repos = makeMockRepos();
    // findForUpdate returns null

    await expect(
      service.answerWithinTx(
        repos,
        { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);

    expect(repos.l2Progress.saveL2Answer).not.toHaveBeenCalled();
    expect(repos.outbox.enqueue).not.toHaveBeenCalled();
  });

  it("throws BusinessRuleError when L2 card is paused", async () => {
    const { service } = makeService();
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: true }),
      word: { id: WORD_ID },
    });

    await expect(
      service.answerWithinTx(
        repos,
        { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
        USER_ID,
      ),
    ).rejects.toThrow(/Cannot answer a paused L2 card/);

    // 暂停卡不可答，不应触达 FSRS / save / outbox
    expect(repos.l2Progress.saveL2Answer).not.toHaveBeenCalled();
    expect(repos.outbox.enqueue).not.toHaveBeenCalled();
    // 会话归属也不应触达（暂停优先于会话校验）
    expect(repos.sessions.assertActiveOwned).not.toHaveBeenCalled();
  });

  it("propagates session ownership failure (sessions.assertActiveOwned)", async () => {
    const { service } = makeService();
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });
    (repos.sessions.assertActiveOwned as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BusinessRuleError("Session not owned by user"),
    );

    await expect(
      service.answerWithinTx(
        repos,
        { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
        USER_ID,
      ),
    ).rejects.toThrow(/Session not owned by user/);

    expect(repos.l2Progress.saveL2Answer).not.toHaveBeenCalled();
    expect(repos.outbox.enqueue).not.toHaveBeenCalled();
  });

  // ─── weights 回退链（双轨 spec §十） ─────────────────────────────────

  it("uses loadL2Weights when it returns non-empty weights", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const loadL2Weights = vi.fn(async () => [0.4, 0.5, 0.6]);
    const loadWeights = vi.fn(async () => [0.7, 0.8, 0.9]);
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadL2Weights: loadL2Weights as never,
      loadWeights: loadWeights as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    // 必须用 L2 专属 weights，不回退到 L1 weights
    expect(loadL2Weights).toHaveBeenCalledWith(WORDBOOK_ID);
    expect(loadWeights).not.toHaveBeenCalled();
    expect(fsrsAdapter).toHaveBeenCalledWith(
      expect.anything(),
      "good",
      expect.any(Date),
      0.9, // l2_desired_retention
      [0.4, 0.5, 0.6],
    );
  });

  it("falls back to loadWeights when loadL2Weights returns null", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const loadL2Weights = vi.fn(async () => null);
    const loadWeights = vi.fn(async () => [0.7, 0.8, 0.9]);
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadL2Weights: loadL2Weights as never,
      loadWeights: loadWeights as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    expect(loadL2Weights).toHaveBeenCalledWith(WORDBOOK_ID);
    expect(loadWeights).toHaveBeenCalledWith(WORDBOOK_ID);
    expect(fsrsAdapter).toHaveBeenCalledWith(
      expect.anything(),
      "good",
      expect.any(Date),
      0.9,
      [0.7, 0.8, 0.9],
    );
  });

  it("falls back to loadWeights when loadL2Weights throws", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const loadL2Weights = vi.fn(async () => {
      throw new Error("L2 weights table missing");
    });
    const loadWeights = vi.fn(async () => [0.7, 0.8, 0.9]);
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadL2Weights: loadL2Weights as never,
      loadWeights: loadWeights as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    // L2 loader 抛异常 → 兜底走 L1 loader，不阻断 L2 应答
    expect(loadWeights).toHaveBeenCalledWith(WORDBOOK_ID);
    expect(fsrsAdapter.mock.calls.length).toBeGreaterThan(0);
  });

  it("passes null weights to fsrsAdapter when both loaders return null", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadL2Weights: vi.fn(async () => null) as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    expect(fsrsAdapter).toHaveBeenCalledWith(
      expect.anything(),
      "good",
      expect.any(Date),
      0.9,
      null, // 两个 loader 都返回 null → fsrsAdapter 接收 null（其内部会用默认 weights）
    );
  });

  // ─── 空 payload 读侧兜底：payload 必须先经过 rebuildSchedulerPayloadIfEmpty ─

  it("rebuilds payload from scalar columns when l2_scheduler_payload is null", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({
        l2_paused: false,
        l2_scheduler_payload: null, // 空 payload
        l2_due_at: "2026-09-01T00:00:00Z",
        l2_stability: 4.2,
        l2_difficulty: 6.1,
        l2_review_count: 5,
      }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    // fsrsAdapter 必须收到重建后的 payload（含 due/stability/difficulty），不是 null
    const payloadArg = (fsrsAdapter.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown> | undefined;
    expect(payloadArg).toBeDefined();
    expect(payloadArg).toMatchObject({
      due: "2026-09-01T00:00:00.000Z",
      stability: 4.2,
      difficulty: 6.1,
      state: 2,
    });
  });

  it("passes valid payload directly to fsrsAdapter without rebuilding", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    const originalPayload = {
      due: "2026-08-20T00:00:00Z",
      stability: 3,
      difficulty: 5,
      state: 2,
      custom_marker: "should-be-preserved",
    };
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({
        l2_paused: false,
        l2_scheduler_payload: originalPayload,
      }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    const payloadArg = (fsrsAdapter.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown> | undefined;
    expect(payloadArg).toMatchObject(originalPayload);
  });

  // ─── H3 列对齐：saveL2Answer 必须收到真实 elapsedDays ─────────────────────

  it("forwards scheduling.elapsedDays (not scheduledDays) to saveL2Answer", async () => {
    const scheduling = makeScheduling({ elapsedDays: 7, scheduledDays: 21 });
    const fsrsAdapter = vi.fn(() => scheduling);
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    const saveArgs = (repos.l2Progress.saveL2Answer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // H3 红线：elapsedDays 必须是 scheduling.elapsedDays=7，不再被 scheduledDays=21 错填
    expect(saveArgs.elapsedDays).toBe(7);
    expect(saveArgs.scheduledDays).toBe(21);
    expect(saveArgs.intervalDays).toBe(21); // Math.round(scheduledDays)
  });

  // ─── outbox.enqueue 入队 track='l2' 事件（FR-12 接线1） ────────────────────

  it("enqueues REVIEW_ANSWER_RECORDED event with track='l2' after save", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    const result = await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    // outbox.enqueue 必须被调用一次
    expect(repos.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = (repos.outbox.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enqueueArgs.eventType).toBe("review.answer.recorded.v1");
    expect(enqueueArgs.aggregateType).toBe("review_log");
    expect(enqueueArgs.aggregateId).toBe(REVIEW_LOG_ID);
    expect(enqueueArgs.dedupeKey).toBe(`review.answer.recorded.v1:${REVIEW_LOG_ID}`);
    // FR-12 接线1 红线：payload.track 必须是 'l2'，让 worker 走 l2_weak_signal 分支
    expect(enqueueArgs.payload.track).toBe("l2");
    expect(enqueueArgs.payload.userId).toBe(USER_ID);
    expect(enqueueArgs.payload.wordId).toBe(WORD_ID);
    expect(enqueueArgs.payload.wordbookId).toBe(WORDBOOK_ID);
    expect(enqueueArgs.payload.reviewLogId).toBe(REVIEW_LOG_ID);
    expect(enqueueArgs.payload.progressId).toBe(PROGRESS_ID);
    expect(enqueueArgs.payload.sessionId).toBe(SESSION_ID);
    expect(enqueueArgs.payload.version).toBe(1);
    // 返回值对齐
    expect(result).toEqual({
      ok: true,
      reviewLogId: REVIEW_LOG_ID,
      mappedRating: "good",
      nextDueAt: "2026-09-25T00:00:00Z",
      state: "review",
    });
  });

  it("forwards idempotencyKey to saveL2Answer for replay protection", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      {
        progressId: PROGRESS_ID,
        sessionId: SESSION_ID,
        rating: "good",
        idempotencyKey: "idem-save-1",
      },
      USER_ID,
    );

    const saveArgs = (repos.l2Progress.saveL2Answer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saveArgs.idempotencyKey).toBe("idem-save-1");
    expect(saveArgs.sessionId).toBe(SESSION_ID);
    // logMetadata 必须含 track='l2'（FR-12 红线：审计日志区分 L1/L2 轨）
    expect(saveArgs.logMetadata).toMatchObject({ track: "l2" });
    expect(saveArgs.logMetadata).toMatchObject({ desired_retention: 0.9 });
  });

  it("passes logMetadata through to saveL2Answer (merged with track='l2')", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      {
        progressId: PROGRESS_ID,
        sessionId: SESSION_ID,
        rating: "good",
        logMetadata: {
          mode: "l2_drill",
          step_index: 0,
          taskId: "cloze:abc",
          outcome: "correct",
        },
      },
      USER_ID,
    );

    const saveArgs = (repos.l2Progress.saveL2Answer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // 调用方传入的 metadata 字段必须保留
    expect(saveArgs.logMetadata).toMatchObject({
      mode: "l2_drill",
      step_index: 0,
      taskId: "cloze:abc",
      outcome: "correct",
    });
    // 服务层注入的 track 字段也必须存在（不应被覆盖）
    expect(saveArgs.logMetadata).toMatchObject({ track: "l2" });
  });

  it("passes previousSnapshot with pre-save l2_state and recent_ratings", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({
        l2_paused: false,
        l2_stability: 2.1,
        l2_difficulty: 4.8,
        l2_state: "review",
        l2_due_at: "2026-08-20T00:00:00Z",
        recent_ratings: ["good", "again"],
      }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    const saveArgs = (repos.l2Progress.saveL2Answer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // previousSnapshot 必须含撤销链所需字段（M7 撤销会读取这个快照）
    expect(saveArgs.previousSnapshot).toMatchObject({
      l2_stability: 2.1,
      l2_difficulty: 4.8,
      l2_state: "review",
      l2_due_at: "2026-08-20T00:00:00Z",
      recent_ratings: ["good", "again"],
    });
  });
});

// ─── submitL2Answer 公共入口 + 回退分支（覆盖率收口）──────────────────────
describe("L2ReviewService.submitL2Answer (public entry)", () => {
  it("wraps answerWithinTx in an actorId transaction via createRepositories", async () => {
    const { service } = makeService();
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });
    (createRepositories as ReturnType<typeof vi.fn>).mockReturnValue(repos);

    const result = await service.submitL2Answer(
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    expect(result.ok).toBe(true);
    expect(result.reviewLogId).toBe(REVIEW_LOG_ID);
    expect(createRepositories).toHaveBeenCalled();
  });

  it("treats loadWeights rejection as null weights fallback (never blocks answer)", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadL2Weights: vi.fn(async () => null) as never,
      loadWeights: vi.fn(async () => {
        throw new Error("db down");
      }) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    // 两个 loader 都失败 → fsrsAdapter 收到 null weights（内部用默认）
    expect(fsrsAdapter).toHaveBeenCalledWith(expect.anything(), "good", expect.any(Date), 0.9, null);
  });

  it("defaults recent_ratings to [] and content hash to fallback when null", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling());
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({
        l2_paused: false,
        recent_ratings: null as never,
        l2_content_hash_snapshot: null,
      }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    const saveArgs = (repos.l2Progress.saveL2Answer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saveArgs.previousSnapshot.recent_ratings).toEqual([]);
    expect(saveArgs.contentHashSnapshot).toBe(`l2:${WORD_ID}:${PROGRESS_ID}`);
  });

  it("maps null retrievability and scheduledDays to null outputs", async () => {
    const fsrsAdapter = vi.fn(() => makeScheduling({ retrievability: null, scheduledDays: null } as never));
    const service = new L2ReviewService({
      fsrsAdapter: fsrsAdapter as never,
      loadWeights: vi.fn(async () => null) as never,
    });
    const repos = makeMockRepos();
    (repos.l2Progress.findForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      progress: makeProgressRow({ l2_paused: false }),
      word: { id: WORD_ID },
    });

    await service.answerWithinTx(
      repos,
      { progressId: PROGRESS_ID, sessionId: SESSION_ID, rating: "good" },
      USER_ID,
    );

    const saveArgs = (repos.l2Progress.saveL2Answer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saveArgs.retrievability).toBeNull();
    expect(saveArgs.intervalDays).toBeNull();
    expect(saveArgs.scheduledDays).toBeNull();
  });
});
