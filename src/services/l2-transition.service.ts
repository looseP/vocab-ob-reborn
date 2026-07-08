/**
 * L2TransitionService — promotes an L1 (primary FSRS) card into the L2
 * (second-pass) scheduling loop once L1 reaches a stable plateau.
 *
 * Transition conditions:
 *   L1_stability      ≥ 21d
 *   L1_review_count   ≥ 5
 *   L1_last_rating    ∈ {good, easy}
 *   no existing L2 progress  (idempotent)
 *
 * Inherited values:
 *   inherit_ratio = 0.5 × L1_S / (L1_S + 21)
 *   L2_S          = max(L1_S × ratio, 1.0)   ← vuln-1 fix: absolute floor 1.0d
 *   L2_difficulty = min(10, L1_difficulty + 2.0)
 *   L2_state      = 'review'
 *   L2_desired_retention = 0.9               ← decision-1
 *
 * Failure handling:
 *   catch swallows only PG unique-violation (23505) for idempotency;
 *   all other errors are re-thrown.          ← vuln-2 fix
 */

import type { IL2ProgressRepository } from "../repositories/interfaces";
import { logger } from "../observability/logger";

export interface L1ProgressSnapshot {
  user_id: string;
  /** Wordbook scope — L2 progress is wordbook-scoped in V2, so the idempotency
   *  check and insert must be scoped to (user_id, wordbook_id, word_id). */
  wordbook_id: string;
  word_id: string;
  stability: number | string;
  difficulty: number | string | null;
  review_count: number;
  last_rating: string | null;
}

const TRANSITION_STABILITY_THRESHOLD = 21;
const TRANSITION_REVIEW_COUNT_THRESHOLD = 5;
const L2_DESIRED_RETENTION = 0.9;
const L2_STABILITY_FLOOR = 1.0;
const L2_DIFFICULTY_CEILING = 10;
const L2_DIFFICULTY_INHERIT_DELTA = 2.0;
const TRANSITION_ALLOWED_RATINGS = new Set(["good", "easy"]);
const MS_PER_DAY = 86_400_000;

export class L2TransitionService {
  /**
   * @param l2ProgressRepo L2 progress repository. Injected so tests can
   *   substitute a mock; production code passes the real instance from
   *   `createRepositories()`.
   */
  constructor(private readonly l2ProgressRepo: IL2ProgressRepository) {}

  /**
   * Evaluate the transition conditions for a single L1 progress snapshot
   * and, if eligible, insert an inherited L2 progress row. Idempotent.
   */
  async checkAndTransition(progress: L1ProgressSnapshot): Promise<void> {
    const l1S = Number(progress.stability);

    // ── Transition conditions ────────────────────────────────────────────
    if (l1S < TRANSITION_STABILITY_THRESHOLD) return;
    if (progress.review_count < TRANSITION_REVIEW_COUNT_THRESHOLD) return;
    if (!TRANSITION_ALLOWED_RATINGS.has(progress.last_rating ?? "")) return;

    // ── Idempotency check (wordbook-scoped) ──────────────────────────────
    // Same user+word in a DIFFERENT wordbook must NOT block this transition —
    // each wordbook gets its own independent L2 progress row.
    const existing = await this.l2ProgressRepo.findByWordbookWordAndUser(
      progress.user_id,
      progress.wordbook_id,
      progress.word_id,
    );
    if (existing) return;

    // ── Inherited values ─────────────────────────────────────────────────
    // inherit_ratio = 0.5 × L1_S / (L1_S + 21)
    const inheritRatio = (0.5 * l1S) / (l1S + TRANSITION_STABILITY_THRESHOLD);
    // vuln-1 fix: absolute floor of 1.0d
    const l2Stability = Math.max(l1S * inheritRatio, L2_STABILITY_FLOOR);
    const l1Difficulty =
      progress.difficulty == null ? 5 : Number(progress.difficulty);
    const l2Difficulty = Math.min(
      L2_DIFFICULTY_CEILING,
      l1Difficulty + L2_DIFFICULTY_INHERIT_DELTA,
    );
    const l2DueAt = new Date(Date.now() + l2Stability * MS_PER_DAY);

    try {
      await this.l2ProgressRepo.insert({
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        l2_stability: l2Stability,
        l2_difficulty: l2Difficulty,
        l2_state: "review",
        l2_desired_retention: L2_DESIRED_RETENTION,
        l2_due_at: l2DueAt.toISOString(),
        l2_inherited_from_l1: true,
        l2_weights_source: "inherited",
      });
    } catch (err: unknown) {
      // vuln-2 fix: swallow ONLY 23505 (unique violation) for idempotency;
      // re-throw every other error so silent data loss cannot hide here.
      if (err != null && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "23505") {
        logger.warn(
          "l2-transition",
          "L2 transition skipped: progress already exists (23505)",
          {
            userId: progress.user_id,
            wordbookId: progress.wordbook_id,
            wordId: progress.word_id,
          },
        );
        return;
      }
      throw err;
    }
  }
}
