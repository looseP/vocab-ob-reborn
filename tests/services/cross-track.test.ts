import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import type { IL2ProgressRepository, InsertNewCardStatus, IReviewRepository } from "@/repositories/interfaces";
import type { UserWordL2ProgressRow } from "@/domain";
import { CrossTrackService, type CrossTrackL1Snapshot } from "@/services/cross-track.service";

// ── Mock factory helpers ────────────────────────────────────────────────

function makeMockL2Repo(overrides: Partial<IL2ProgressRepository> = {}): IL2ProgressRepository {
    return {
      findByWordbookWordAndUser: vi.fn(async () => null),
      insert: vi.fn(async () => ({}) as never),
      findDueCards: vi.fn(async () => []),
      findForUpdate: vi.fn(async () => null),
      saveL2Answer: vi.fn(async () => ({ reviewLogId: "log-l2" })),
      updateProductionStatus: vi.fn(async () => undefined),
      insertDrillStepIfAbsent: vi.fn(async () => ({}) as never),
      findDrillStepForUpdate: vi.fn(async () => null),
      findLastDrillStep: vi.fn(async () => null),
      // M5 修复后接口新增方法：跨轨测试不触达 drill 步查找，stub null
      findDrillStepBySessionWordStep: vi.fn(async () => null),
      // M7 修复：L2 撤销链路方法（跨轨测试不触达，stub 安全默认值）
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
      ...overrides,
    };
  }

function makeMockReviewRepo(overrides: Partial<IReviewRepository> = {}): IReviewRepository {
  return {
    findDueCards: vi.fn(async () => []),
    checkIdempotency: vi.fn(async () => null),
    findProgressForUpdate: vi.fn(async () => null),
    findProgressForSkip: vi.fn(async () => null),
    findProgressForSuspend: vi.fn(async () => null),
    findProgressForOutbox: vi.fn(async () => null),
    insertNewCard: vi.fn(async (): Promise<InsertNewCardStatus> => ({ status: "inserted", progressId: "p-new" })),
    saveAnswer: vi.fn(async () => ({ reviewLogId: "log-1" })),
    skipCard: vi.fn(async () => ({ reviewLogId: "log-skip" })),
    suspendCard: vi.fn(async () => ({ reviewLogId: "log-suspend" })),
    findReviewLogWordbookForUndo: vi.fn(async () => "wb1"),
    undoReviewLog: vi.fn(async () => ({
      success: true, progressId: null, wordId: null, errorMessage: null,
    })),
    findStaleCards: vi.fn(async () => []),
    markStaleForRecheck: vi.fn(async () => 0),
    markL1StaleForRecheck: vi.fn(async () => 0),
    markL1WeakSignal: vi.fn(async () => 1),
    ...overrides,
  };
}

function makeL1Snapshot(
  recent_ratings: string[],
  overrides: Partial<CrossTrackL1Snapshot> = {},
): CrossTrackL1Snapshot {
  return {
    user_id: "u1",
    wordbook_id: "wb1",
    word_id: "w1",
    recent_ratings: recent_ratings as CrossTrackL1Snapshot["recent_ratings"],
    ...overrides,
  };
}

function makeL2Row(
  recent_ratings: string[],
  overrides: Partial<UserWordL2ProgressRow> = {},
): UserWordL2ProgressRow {
  return {
    id: "l2-1",
    user_id: "u1",
    word_id: "w1",
    wordbook_id: "wb1",
    l2_stability: 5,
    l2_difficulty: 7,
    l2_retrievability: null,
    l2_state: "review",
    l2_desired_retention: 0.9,
    l2_due_at: "2026-01-08T00:00:00Z",
    l2_last_reviewed_at: "2025-12-31T00:00:00Z",
    l2_last_rating: "again",
    l2_review_count: 3,
    l2_lapse_count: 0,
    l2_interval_days: null,
    l2_scheduler_payload: {},
    l2_again_count: 3,
    l2_hard_count: 0,
    l2_good_count: 0,
    l2_easy_count: 0,
    l2_content_hash_snapshot: null,
    recent_ratings: recent_ratings as UserWordL2ProgressRow["recent_ratings"],
    l2_paused: false,
    l2_paused_at: null,
    l2_paused_reason: null,
    l2_inherited_from_l1: true,
    l2_weights_source: "inherited",
    l2_predicted_retrievability: null,
    // placeholder flags required by the row shape — NOT the L3 main model (ADR-0005)
    l2_production_status: null,
    l3_pending: false,
    l3_self_assessments: [],
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── L1→L2 cascade (checkL1Cascade) ─────────────────────────────────────

describe("CrossTrackService.checkL1Cascade (L1→L2)", () => {
  it("pauses L2 when last 2 ratings are both again", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["again", "again"]));

    expect(l2Repo.pause).toHaveBeenCalledWith("u1", "wb1", "w1", "l1_cascade_failure");
  });

  it("pauses L2 when the last 2 are again even with older ratings present", async () => {
    // 5-element window: [good, easy, again, again, again] → last 2 are again
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["good", "easy", "again", "again", "again"]));

    expect(l2Repo.pause).toHaveBeenCalledTimes(1);
    expect(l2Repo.pause).toHaveBeenCalledWith("u1", "wb1", "w1", "l1_cascade_failure");
    // Recovery branch must NOT also fire.
    expect(l2Repo.unpauseByReason).not.toHaveBeenCalled();
  });

  it("unpauses cascade-failure pause when last 2 ratings are both good", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["good", "good"]));

    expect(l2Repo.unpauseByReason).toHaveBeenCalledWith("u1", "wb1", "w1", "l1_cascade_failure");
    // Must NOT pause.
    expect(l2Repo.pause).not.toHaveBeenCalled();
  });

  it("unpauses cascade-failure pause when last 2 ratings are both easy", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["easy", "easy"]));

    expect(l2Repo.unpauseByReason).toHaveBeenCalledWith("u1", "wb1", "w1", "l1_cascade_failure");
  });

  it("unpauses cascade-failure pause when last 2 are good+easy (mixed good+)", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["good", "easy"]));

    expect(l2Repo.unpauseByReason).toHaveBeenCalledWith("u1", "wb1", "w1", "l1_cascade_failure");
  });

  it("does NOT unpause when recovery window contains a 'hard'", async () => {
    // hard is not good/easy — recovery requires all-good+ in the window.
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["hard", "good"]));

    expect(l2Repo.unpauseByReason).not.toHaveBeenCalled();
    expect(l2Repo.pause).not.toHaveBeenCalled();
  });

  it("does neither when ratings are mixed (e.g. [again, good])", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["again", "good"]));

    expect(l2Repo.pause).not.toHaveBeenCalled();
    expect(l2Repo.unpauseByReason).not.toHaveBeenCalled();
  });

  it("does neither when fewer than 2 ratings exist", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["again"]));

    expect(l2Repo.pause).not.toHaveBeenCalled();
    expect(l2Repo.unpauseByReason).not.toHaveBeenCalled();
  });

  it("does nothing when recent_ratings is empty", async () => {
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot([]));

    expect(l2Repo.pause).not.toHaveBeenCalled();
    expect(l2Repo.unpauseByReason).not.toHaveBeenCalled();
  });

  // ── Unpause only targets cascade reason, not manual / wordbook_focus ──
  it("unpauseByReason is scoped to reason='l1_cascade_failure' (does not touch manual pauses)", async () => {
    // The cascade must NEVER clear a manual or wordbook_focus pause. The
    // service delegates to unpauseByReason with the cascade reason — the
    // repository's WHERE clause filters by reason, so manual/wordbook_focus
    // pauses survive. Here we assert the service passes the cascade reason.
    const l2Repo = makeMockL2Repo();
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL1Cascade(makeL1Snapshot(["good", "good"]));

    expect(l2Repo.unpauseByReason).toHaveBeenCalledTimes(1);
    const [, , , reason] = (l2Repo.unpauseByReason as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(reason).toBe("l1_cascade_failure");
    expect(reason).not.toBe("manual");
    expect(reason).not.toBe("wordbook_focus");
  });
});

// ── L2→L1 cascade (checkL2FailureCascade) ──────────────────────────────

describe("CrossTrackService.checkL2FailureCascade (L2→L1)", () => {
  it("marks l1_weak_signal=true when last 3 L2 ratings are all again", async () => {
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () => makeL2Row(["again", "again", "again"])),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackService(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");

    expect(reviewRepo.markL1WeakSignal).toHaveBeenCalledWith("u1", "wb1", "w1", true);
  });

  it("marks weak signal when last 3 are again within a 5-element window", async () => {
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () =>
        makeL2Row(["good", "hard", "again", "again", "again"]),
      ),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackService(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");

    expect(reviewRepo.markL1WeakSignal).toHaveBeenCalledWith("u1", "wb1", "w1", true);
  });

  it("does NOT mark weak signal when only 2 of the last 3 are again", async () => {
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () => makeL2Row(["again", "good", "again"])),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackService(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");

    expect(reviewRepo.markL1WeakSignal).not.toHaveBeenCalled();
  });

  it("does NOT mark weak signal when fewer than 3 L2 ratings exist", async () => {
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () => makeL2Row(["again", "again"])),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackService(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");

    expect(reviewRepo.markL1WeakSignal).not.toHaveBeenCalled();
  });

  it("does nothing when no L2 progress row exists", async () => {
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () => null),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackService(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");

    expect(reviewRepo.markL1WeakSignal).not.toHaveBeenCalled();
  });

  it("looks up the L2 row scoped by (user, wordbook, word)", async () => {
    const findBy = vi.fn(async () => makeL2Row(["again", "again", "again"]));
    const l2Repo = makeMockL2Repo({ findByWordbookWordAndUser: findBy });
    const service = new CrossTrackService(l2Repo, makeMockReviewRepo());
    await service.checkL2FailureCascade("uA", "wbA", "wA");

    expect(findBy).toHaveBeenCalledWith("uA", "wbA", "wA");
  });

  // ── Decision-2: L2→L1 ONLY marks — never re-cards ────────────────────
  it("does NOT call any re-card method (no markL1StaleForRecheck, no markStaleForRecheck)", async () => {
    // Phase 2C decision-2: L2 failure only flips l1_weak_signal. It must not
    // touch due_at / needs_recheck / state. The service should only invoke
    // markL1WeakSignal — never the stale-for-recheck family.
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () => makeL2Row(["again", "again", "again"])),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackService(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");

    expect(reviewRepo.markL1WeakSignal).toHaveBeenCalledTimes(1);
    expect(reviewRepo.markL1StaleForRecheck).not.toHaveBeenCalled();
    expect(reviewRepo.markStaleForRecheck).not.toHaveBeenCalled();
  });
});

// ── P2-6: L2_WEAK_SIGNAL_WINDOW env-var tuning ────────────────────────────
// 模块级常量在 import 时一次性求值，须 vi.resetModules + dynamic import
// 才能让 process.env 改动生效。验证调优旋钮：合法值生效，越界回退默认。
describe("CrossTrackService L2_WEAK_SIGNAL_WINDOW env-var tuning (P2-6)", () => {
  const envBackup = process.env.L2_WEAK_SIGNAL_WINDOW;
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

  afterEach(() => {
    delete process.env.L2_WEAK_SIGNAL_WINDOW;
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (envBackup !== undefined) process.env.L2_WEAK_SIGNAL_WINDOW = envBackup;
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // L2 progress 行 recent_ratings 构造：N 个全 again 即应触发，N-1 个则不触发。
  // 通过对当前 service 实例直接 spy markL1WeakSignal 验证窗口边界。
  async function importServiceAndProbe(windowSize: number, ratings: string[]) {
    process.env.L2_WEAK_SIGNAL_WINDOW = String(windowSize);
    vi.resetModules();
    const mod = await import("@/services/cross-track.service");
    const CrossTrackServiceDyn = mod.CrossTrackService;
    const l2Repo = makeMockL2Repo({
      findByWordbookWordAndUser: vi.fn(async () => makeL2Row(ratings)),
    });
    const reviewRepo = makeMockReviewRepo();
    const service = new CrossTrackServiceDyn(l2Repo, reviewRepo);
    await service.checkL2FailureCascade("u1", "wb1", "w1");
    return reviewRepo.markL1WeakSignal as unknown as { mock: { calls: unknown[][] } };
  }

  it("N=2 triggers weak signal when last 2 ratings are all again", async () => {
    const spy = await importServiceAndProbe(2, ["again", "again"]);
    expect(spy.mock.calls).toHaveLength(1);
  });

  it("N=4 does NOT trigger when only last 3 are again (need 4)", async () => {
    const spy = await importServiceAndProbe(4, ["again", "again", "again"]);
    expect(spy.mock.calls).toHaveLength(0);
  });

  it("N=5 triggers when last 5 ratings are all again", async () => {
    const spy = await importServiceAndProbe(5, ["again", "again", "again", "again", "again"]);
    expect(spy.mock.calls).toHaveLength(1);
  });

  it("out-of-bounds N=1 falls back to default N=3 (does not trigger on 2 again)", async () => {
    // N=1 越界 → 默认 3；2 个 again 不应触发
    const spy = await importServiceAndProbe(1, ["again", "again"]);
    expect(spy.mock.calls).toHaveLength(0);
  });

  it("out-of-bounds N=11 falls back to default N=3 (triggers on 3 again)", async () => {
    const spy = await importServiceAndProbe(11, ["again", "again", "again"]);
    expect(spy.mock.calls).toHaveLength(1);
  });

  it("non-numeric N='abc' falls back to default N=3", async () => {
    const spy = await importServiceAndProbe(Number.NaN, ["again", "again", "again"]);
    expect(spy.mock.calls).toHaveLength(1);
  });
});
