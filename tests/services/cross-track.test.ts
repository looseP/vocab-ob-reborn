import { describe, it, expect, vi } from "vitest";
import type { IL2ProgressRepository, IReviewRepository } from "@/repositories/interfaces";
import type { UserWordL2ProgressRow } from "@/domain";
import { CrossTrackService, type CrossTrackL1Snapshot } from "@/services/cross-track.service";

// ── Mock factory helpers ────────────────────────────────────────────────

function makeMockL2Repo(overrides: Partial<IL2ProgressRepository> = {}): IL2ProgressRepository {
  return {
    findByWordbookWordAndUser: vi.fn(async () => null),
    insert: vi.fn(async () => ({}) as never),
    markL2StaleForRecheck: vi.fn(async () => 0),
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
