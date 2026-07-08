/**
 * CrossTrackService — Phase 2C L1/L2 跨轨联动闭环.
 *
 * Dual-track isolation principle (ADR-002 + dual-track-fsrs-spec decision-2):
 * L1 and L2 run independently by default. Only sustained, extreme failure on
 * one track crosses over to the other — and even then the crossover is
 * *graded*:
 *
 *   L1→L2  (strong): L1 is the foundation. If the foundation collapses
 *     (last 2 ratings both `again`), L2辨析 is pointless — pause L2 with
 *     reason `l1_cascade_failure`. When L1 recovers (last 2 both good/easy),
 *     resume — but ONLY `l1_cascade_failure` pauses; `manual` and
 *     `wordbook_focus` pauses are left untouched.
 *
 *   L2→L1  (weak): L2辨析 failure ≠ L1 recognition weakness (could just be
 *     a hard synonym set). So 3 consecutive `again` only *marks*
 *     `l1_weak_signal=true` — it never re-cards L1, never touches
 *     due_at/needs_recheck/state. The user sees the flag in the UI and
 *     decides whether to re-grind L1.
 *
 * Best-effort contract: like L2TransitionService, these methods are called
 * best-effort from ReviewService.submitAnswer (and, later, L2ReviewService).
 * Their failure must NEVER roll back the triggering L1/L2 submit — the
 * caller wraps the call in try/catch. This file itself does not catch its
 * own errors so they surface clearly in tests; the caller owns the
 * swallow-vs-rethrow decision.
 */

import type { IL2ProgressRepository, IReviewRepository } from "../repositories/interfaces";
import type { ReviewRating } from "../domain";

/** Reasons that mark an L2 progress row as paused. Mirrors the DB CHECK. */
export const L2_PAUSE_REASON = {
  l1CascadeFailure: "l1_cascade_failure",
  wordbookFocus: "wordbook_focus",
  manual: "manual",
} as const;

/** Window sizes — Phase 2C spec §七. */
const L1_CASCADE_FAILURE_WINDOW = 2;
const L1_CASCADE_RECOVERY_WINDOW = 2;
const L2_WEAK_SIGNAL_WINDOW = 3;

/** Ratings that count as "good or better" for L1 recovery. */
const RECOVERY_RATINGS: ReadonlySet<ReviewRating> = new Set(["good", "easy"]);

/**
 * Post-save snapshot of L1 progress handed to the L1→L2 cascade check.
 * `recent_ratings` reflects the state AFTER the just-submitted answer was
 * appended + sliced (the caller computes this from the pre-save array + the
 * new rating, matching what saveAnswer persists). wordbook_id is mandatory:
 * L2 progress is wordbook-scoped in V2.
 */
export interface CrossTrackL1Snapshot {
  user_id: string;
  wordbook_id: string;
  word_id: string;
  recent_ratings: ReviewRating[];
}

export class CrossTrackService {
  constructor(
    private readonly l2ProgressRepo: IL2ProgressRepository,
    private readonly reviewRepo: IReviewRepository,
  ) {}

  /**
   * L1→L2 cascade (Phase 2C rule, spec §七 table).
   *
   *   last N=L1_CASCADE_FAILURE_WINDOW ratings all `again` → pause L2 with
   *     reason `l1_cascade_failure`.
   *   last N=L1_CASCADE_RECOVERY_WINDOW ratings all good/easy → resume, but
   *     ONLY rows paused for `l1_cascade_failure` (manual / wordbook_focus
   *     pauses are intentionally left in place).
   *
   * Idempotent: pause on an already-paused row is a no-op UPDATE; unpause
   * when nothing matches the reason updates zero rows. No existing L2 row
   * means there is nothing to cascade into (e.g. L1 not yet stable enough to
   * have promoted an L2 card) — silently returns.
   */
  async checkL1Cascade(snapshot: CrossTrackL1Snapshot): Promise<void> {
    const recent = snapshot.recent_ratings ?? [];

    // L1 collapsing: last 2 both again → pause L2.
    if (
      recent.length >= L1_CASCADE_FAILURE_WINDOW &&
      recent.slice(-L1_CASCADE_FAILURE_WINDOW).every((r) => r === "again")
    ) {
      await this.l2ProgressRepo.pause(
        snapshot.user_id,
        snapshot.wordbook_id,
        snapshot.word_id,
        L2_PAUSE_REASON.l1CascadeFailure,
      );
      return;
    }

    // L1 recovering: last 2 both good/easy → resume only cascade-failure pauses.
    if (
      recent.length >= L1_CASCADE_RECOVERY_WINDOW &&
      recent.slice(-L1_CASCADE_RECOVERY_WINDOW).every((r) => RECOVERY_RATINGS.has(r))
    ) {
      await this.l2ProgressRepo.unpauseByReason(
        snapshot.user_id,
        snapshot.wordbook_id,
        snapshot.word_id,
        L2_PAUSE_REASON.l1CascadeFailure,
      );
    }
  }

  /**
   * L2→L1 weak-signal cascade (Phase 2C rule, spec §七 table + decision-2).
   *
   *   last N=L2_WEAK_SIGNAL_WINDOW L2 ratings all `again` → mark
   *     `l1_weak_signal=true` on the L1 progress row.
   *
   * Decision-2: this ONLY flips the flag — it does NOT re-card L1, does NOT
   * touch due_at / needs_recheck / state. The user sees the flag in the UI
   * and decides whether to re-grind L1. Idempotent (setting true on an
   * already-true row is a no-op UPDATE).
   *
   * Designed to be called by the (forthcoming) L2ReviewService after an L2
   * answer is persisted. It loads the L2 progress row itself so the caller
   * only needs the (user, wordbook, word) triple.
   */
  async checkL2FailureCascade(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<void> {
    const l2 = await this.l2ProgressRepo.findByWordbookWordAndUser(
      userId,
      wordbookId,
      wordId,
    );
    if (!l2) return;

    const recent = (l2.recent_ratings ?? []) as string[];
    if (
      recent.length >= L2_WEAK_SIGNAL_WINDOW &&
      recent.slice(-L2_WEAK_SIGNAL_WINDOW).every((r) => r === "again")
    ) {
      await this.reviewRepo.markL1WeakSignal(
        userId,
        wordbookId,
        wordId,
        true,
      );
    }
  }
}
