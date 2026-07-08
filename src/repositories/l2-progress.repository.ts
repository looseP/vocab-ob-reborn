/**
 * L2ProgressRepository — second-pass scheduling progress per user+wordbook+word.
 *
 * L2 ("level 2") scheduling is inherited from L1 (the primary FSRS review
 * loop) and can be paused when L1 cascades fail. Stale rows are re-checked
 * when a word's content hash changes.
 *
 * Scope: every user/operation-driven query is scoped to (user_id,
 * wordbook_id, word_id). The V2 review track is wordbook-scoped, so a user
 * reviewing the same word in two different wordbooks must get independent L2
 * progress rows — sharing would let one wordbook's L2 state pollute another's.
 * Only markL2StaleForRecheck is word-level: L2 content is global per word, so
 * a content-hash change must re-evaluate every scoped row for that word.
 */

import type { UserWordL2ProgressRow } from "../domain";
import type { IL2ProgressRepository, NewL2Progress } from "./interfaces";
import { BaseRepository } from "./base";

export class L2ProgressRepository extends BaseRepository implements IL2ProgressRepository {
  async findByWordbookWordAndUser(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<UserWordL2ProgressRow | null> {
    return this.queryOne<UserWordL2ProgressRow>(
      `SELECT * FROM user_word_l2_progress
        WHERE user_id = $1 AND wordbook_id = $2::uuid AND word_id = $3::uuid`,
      [userId, wordbookId, wordId],
    );
  }

  async insert(data: NewL2Progress): Promise<UserWordL2ProgressRow> {
    const row = await this.queryOne<UserWordL2ProgressRow>(
      `INSERT INTO user_word_l2_progress
         (user_id, wordbook_id, word_id, l2_stability, l2_difficulty, l2_state, l2_desired_retention, l2_due_at, l2_inherited_from_l1, l2_weights_source)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        data.user_id,
        data.wordbook_id,
        data.word_id,
        data.l2_stability,
        data.l2_difficulty,
        data.l2_state,
        data.l2_desired_retention,
        data.l2_due_at,
        data.l2_inherited_from_l1,
        data.l2_weights_source,
      ],
    );
    if (!row) throw new Error("L2 progress insert returned no row");
    return row;
  }

  /**
   * Mark L2 rows stale when a word's content hash changed, so they get
   * re-evaluated. Only non-paused rows with a prior snapshot are affected.
   * This is content-driven (L2 content is global per word), so it touches
   * every scoped row for that word regardless of user/wordbook. Returns the
   * count of rows scheduled for recheck.
   */
  async markL2StaleForRecheck(wordId: string, newL2Hash: string): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_l2_progress
       SET l2_content_hash_snapshot = $1, l2_due_at = now()
       WHERE word_id = $2::uuid
         AND l2_content_hash_snapshot IS NOT NULL
         AND l2_content_hash_snapshot != $1
         AND l2_paused = false
       RETURNING id`,
      [newL2Hash, wordId],
    );
    return rows.length;
  }

  async pause(userId: string, wordbookId: string, wordId: string, reason: string): Promise<void> {
    await this.query(
      `UPDATE user_word_l2_progress
       SET l2_paused = true, l2_paused_at = now(), l2_paused_reason = $4
       WHERE user_id = $1 AND wordbook_id = $2::uuid AND word_id = $3::uuid`,
      [userId, wordbookId, wordId, reason],
    );
  }

  async unpauseByReason(
    userId: string,
    wordbookId: string,
    wordId: string,
    reason: string,
  ): Promise<void> {
    await this.query(
      `UPDATE user_word_l2_progress
       SET l2_paused = false, l2_paused_at = NULL, l2_paused_reason = NULL, l2_due_at = now()
       WHERE user_id = $1 AND wordbook_id = $2::uuid AND word_id = $3::uuid AND l2_paused_reason = $4`,
      [userId, wordbookId, wordId, reason],
    );
  }
}
