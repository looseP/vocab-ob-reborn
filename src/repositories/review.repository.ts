/**
 * ReviewRepository — the most complex repository, with transaction-heavy logic.
 *
 * H1/H4 fix: All transactional methods call requireTx() first.
 * H2 fix: counterField uses a whitelist map, never string interpolation.
 * H3 fix: PROGRESS_COLUMNS_PREFIXED for JOIN queries; bare for single-table.
 * H5 fix: skip/suspend/undo methods added.
 * M7 fix: findProgressForUpdate JOINs words for slug/title/lemma.
 */

import type {
  Json,
  ReviewRating,
  ReviewState,
  UserWordProgressRow,
} from "../domain";
import type {
  IReviewRepository,
  ProgressForAction,
  ProgressWithContentHash,
  SaveAnswerInput,
  UndoRpcResult,
} from "./interfaces";
import { BaseRepository } from "./base";
import { ValidationError } from "../errors";

// ── H2 fix: whitelist for rating → counter column ───────────────────────
const RATING_COUNTER_MAP: Record<ReviewRating, string> = {
  again: "again_count",
  hard: "hard_count",
  good: "good_count",
  easy: "easy_count",
};

// ── H3 fix: prefixed columns for JOIN queries (avoids ambiguous "id") ──
const PROGRESS_COLUMNS_PREFIXED = `
  uwp.id, uwp.user_id, uwp.word_id, uwp.wordbook_id, uwp.state,
  uwp.stability, uwp.difficulty, uwp.retrievability, uwp.desired_retention,
  uwp.due_at, uwp.last_reviewed_at, uwp.last_rating, uwp.review_count,
  uwp.lapse_count, uwp.again_count, uwp.hard_count, uwp.good_count,
  uwp.easy_count, uwp.interval_days, uwp.scheduler_payload,
  uwp.content_hash_snapshot, uwp.skip_count, uwp.created_at, uwp.updated_at,
  uwp.recent_ratings, uwp.l1_weak_signal
`;

// Bare columns for single-table queries (no JOIN ambiguity)
const PROGRESS_COLUMNS = PROGRESS_COLUMNS_PREFIXED.replace(/uwp\./g, "");

export class ReviewRepository extends BaseRepository implements IReviewRepository {
  /**
   * Find due review cards for a user/wordbook.
   */
  async findDueCards(
    userId: string,
    wordbookId: string,
    limit: number,
  ) {
    // H3 fix: use prefixed columns + explicit w.id AS w_id to avoid ambiguity
    const rows = await this.query<
      UserWordProgressRow & { slug: string; title: string; lemma: string; w_id: string }
    >(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.id AS w_id, w.slug, w.title, w.lemma
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.state != 'suspended'
         AND (uwp.due_at IS NULL OR uwp.due_at <= now())
       ORDER BY uwp.due_at ASC NULLS FIRST, uwp.last_reviewed_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit],
    );

    return rows.map((r) => {
      const { slug, title, lemma, w_id, ...progress } = r;
      return {
        progress: progress as unknown as UserWordProgressRow,
        word: { id: w_id, slug, title, lemma },
      };
    });
  }

  /**
   * Advisory lock + idempotency check. MUST be in a transaction.
   * H4 fix: requireTx() enforces transaction context.
   */
  async checkIdempotency(idempotencyKey: string): Promise<string | null> {
    this.requireTx();
    await this.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [idempotencyKey],
    );
    const rows = await this.query<{ id: string }>(
      `SELECT id FROM review_logs WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * SELECT FOR UPDATE with word join for slug/title/lemma.
   * MUST be in a transaction. M7 fix: include word fields.
   */
  async findProgressForUpdate(progressId: string): Promise<ProgressWithContentHash | null> {
    this.requireTx();
    return this.queryOne<ProgressWithContentHash>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.content_hash, w.slug AS word_slug, w.title AS word_title, w.lemma AS word_lemma
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.id = $1::uuid
       FOR UPDATE`,
      [progressId],
    );
  }

  /**
   * SELECT FOR UPDATE minimal fields for skip. MUST be in a transaction.
   */
  async findProgressForSkip(progressId: string, userId: string): Promise<ProgressForAction | null> {
    this.requireTx();
    return this.queryOne<ProgressForAction>(
      `SELECT id, word_id, wordbook_id, state, skip_count
       FROM user_word_progress
       WHERE id = $1::uuid AND user_id = $2
       FOR UPDATE`,
      [progressId, userId],
    );
  }

  /**
   * SELECT FOR UPDATE minimal fields for suspend. MUST be in a transaction.
   */
  async findProgressForSuspend(progressId: string, userId: string): Promise<ProgressForAction | null> {
    this.requireTx();
    return this.queryOne<ProgressForAction>(
      `SELECT id, word_id, wordbook_id, state, skip_count
       FROM user_word_progress
       WHERE id = $1::uuid AND user_id = $2
       FOR UPDATE`,
      [progressId, userId],
    );
  }

  /**
   * UPDATE progress + INSERT review_log. MUST be in a transaction.
   * H2 fix: counterField via whitelist, not interpolation.
   */
  async saveAnswer(input: SaveAnswerInput): Promise<{ reviewLogId: string }> {
    this.requireTx();

    // H2 fix: whitelist lookup — prevents SQL injection via column name
    const counterField = RATING_COUNTER_MAP[input.rating];
    if (!counterField) {
      throw new ValidationError(`Invalid rating: ${input.rating}`, "rating");
    }

    const nowIso = new Date().toISOString();

    // 1. UPDATE user_word_progress
    // M-NEW-4 fix: include content_hash_snapshot refresh (matches v1)
    // Dual-track: also refresh l1_content_hash_snapshot (L1-specific hash)
    // and append the latest rating to recent_ratings (capped at 5).
    //
    // recent_ratings SQL breakdown:
    //   recent_ratings || to_jsonb($5::text)  — append new rating to existing array
    //   jsonb_array_elements(...) WITH ORDINALITY  — explode to (elem, ord) pairs
    //   ORDER BY ord DESC LIMIT 5  — take 5 most recent
    //   jsonb_agg(elem ORDER BY ord ASC)  — re-aggregate in chronological order
    // Result: [oldest_kept, ..., newest] (max 5 elements)
    await this.query(
      `UPDATE user_word_progress
       SET difficulty = $1, due_at = $2, interval_days = $3,
           lapse_count = lapse_count + $4,
           last_rating = $5, last_reviewed_at = $6,
           retrievability = $7, review_count = review_count + 1,
           scheduler_payload = $8, stability = $9, state = $10,
           ${counterField} = ${counterField} + 1,
           content_hash_snapshot = $11,
           l1_content_hash_snapshot = $11,
           recent_ratings = (
             SELECT jsonb_agg(elem ORDER BY ord)
             FROM (
               SELECT elem, ord
               FROM jsonb_array_elements(
                 recent_ratings || to_jsonb($5::text)
               ) WITH ORDINALITY t(elem, ord)
               ORDER BY ord DESC
               LIMIT 5
             ) sub
             ORDER BY ord ASC
           ),
           updated_at = $12
       WHERE id = $13::uuid`,
      [
        input.scheduling.difficulty,
        input.scheduling.dueAt,
        input.scheduling.scheduledDays,
        input.rating === "again" ? 1 : 0,
        input.rating,
        nowIso,
        input.scheduling.retrievability,
        JSON.stringify(input.scheduling.nextPayload),
        input.scheduling.stability,
        input.scheduling.state,
        input.contentHash,        // M-NEW-4: refresh snapshot to current word hash
        nowIso,
        input.progressId,
      ],
    );

    // 2. INSERT review_logs (track='l1' marks this as an L1 review)
    const logRow = await this.queryOne<{ id: string }>(
      `INSERT INTO review_logs (
         user_id, word_id, wordbook_id, progress_id, session_id,
         rating, state, stability, difficulty, due_at,
         reviewed_at, elapsed_days, scheduled_days,
         metadata, previous_progress_snapshot, idempotency_key, track
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, 'l1'
       )
       RETURNING id`,
      [
        input.userId,
        input.wordId,
        input.wordbookId,
        input.progressId,
        input.sessionId,
        input.rating,
        input.scheduling.state,
        input.scheduling.stability,
        input.scheduling.difficulty,
        input.scheduling.logDueAt,
        nowIso,
        input.scheduling.elapsedDays,
        input.scheduling.scheduledDays,
        JSON.stringify(input.logMetadata),
        JSON.stringify(input.previousSnapshot),
        input.idempotencyKey,
      ],
    );

    if (!logRow) throw new Error("review_log insert returned no row");
    return { reviewLogId: logRow.id };
  }

  /**
   * UPDATE skip_count + INSERT review_log (action=skip). MUST be in a transaction.
   */
  async skipCard(
    progress: ProgressForAction,
    userId: string,
    sessionId: string | null,
    idempotencyKey: string | null,
  ): Promise<{ reviewLogId: string }> {
    this.requireTx();
    const nowIso = new Date().toISOString();

    await this.query(
      `UPDATE user_word_progress
       SET skip_count = skip_count + 1, updated_at = $1
       WHERE id = $2::uuid`,
      [nowIso, progress.id],
    );

    const logRow = await this.queryOne<{ id: string }>(
      `INSERT INTO review_logs (
         user_id, word_id, wordbook_id, progress_id, session_id,
         rating, state, metadata, reviewed_at, idempotency_key
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         NULL, $6, $7, $8, $9
       )
       RETURNING id`,
      [
        userId,
        progress.word_id,
        progress.wordbook_id,
        progress.id,
        sessionId,
        progress.state,
        JSON.stringify({ action: "skip" }),
        nowIso,
        idempotencyKey,
      ],
    );

    if (!logRow) throw new Error("skip review_log insert returned no row");
    return { reviewLogId: logRow.id };
  }

  /**
   * UPDATE state=suspended + INSERT review_log (action=suspend). MUST be in a transaction.
   */
  async suspendCard(
    progress: ProgressForAction,
    userId: string,
    sessionId: string | null,
    idempotencyKey: string | null,
  ): Promise<{ reviewLogId: string }> {
    this.requireTx();
    const nowIso = new Date().toISOString();

    await this.query(
      `UPDATE user_word_progress
       SET state = 'suspended', updated_at = $1
       WHERE id = $2::uuid`,
      [nowIso, progress.id],
    );

    const logRow = await this.queryOne<{ id: string }>(
      `INSERT INTO review_logs (
         user_id, word_id, wordbook_id, progress_id, session_id,
         rating, state, metadata, reviewed_at, idempotency_key
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         NULL, 'suspended', $6, $7, $8
       )
       RETURNING id`,
      [
        userId,
        progress.word_id,
        progress.wordbook_id,
        progress.id,
        sessionId,
        JSON.stringify({ action: "suspend" }),
        nowIso,
        idempotencyKey,
      ],
    );

    if (!logRow) throw new Error("suspend review_log insert returned no row");
    return { reviewLogId: logRow.id };
  }

  /**
   * Call undo_review_log RPC + insert idempotency log. MUST be in a transaction.
   */
  async undoReviewLog(
    reviewLogId: string,
    userId: string,
    sessionId: string,
    idempotencyKey: string | null,
  ): Promise<UndoRpcResult> {
    this.requireTx();

    // 1. Call the atomic RPC function
    const rpcRow = await this.queryOne<{
      out_success: boolean;
      out_progress_id: string | null;
      out_word_id: string | null;
      out_error_message: string | null;
    }>(
      `SELECT * FROM undo_review_log($1::uuid, $2::uuid, $3::uuid)`,
      [reviewLogId, userId, sessionId],
    );

    if (!rpcRow) {
      return { success: false, progressId: null, wordId: null, errorMessage: "RPC returned no result" };
    }

    if (!rpcRow.out_success) {
      return {
        success: false,
        progressId: rpcRow.out_progress_id,
        wordId: rpcRow.out_word_id,
        errorMessage: rpcRow.out_error_message ?? "Undo failed",
      };
    }

    // 2. Insert idempotency log after RPC success
    if (idempotencyKey) {
      // H-NEW-1 fix: query progress row for real wordbook_id + state
      const progressRow = await this.queryOne<{ wordbook_id: string; state: string }>(
        `SELECT wordbook_id, state FROM user_word_progress WHERE id = $1::uuid`,
        [rpcRow.out_progress_id],
      );

      const nowIso = new Date().toISOString();
      await this.query(
        `INSERT INTO review_logs (
           user_id, word_id, wordbook_id, progress_id, session_id,
           rating, state, metadata, reviewed_at, idempotency_key
         ) VALUES (
           $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           NULL, $6, $7, $8, $9
         )`,
        [
          userId,
          rpcRow.out_word_id,
          progressRow?.wordbook_id ?? null,  // H-NEW-1 fix: real wordbook_id
          rpcRow.out_progress_id,
          sessionId,
          progressRow?.state ?? "review",    // M-NEW-1 fix: real restored state
          JSON.stringify({ action: "undo", undone_log_id: reviewLogId }),
          nowIso,
          idempotencyKey,
        ],
      );
    }

    return {
      success: true,
      progressId: rpcRow.out_progress_id,
      wordId: rpcRow.out_word_id,
      errorMessage: null,
    };
  }

  /**
   * Find cards whose content_hash has drifted from the word's current hash.
   */
  async findStaleCards(wordId: string): Promise<UserWordProgressRow[]> {
    // Single-table query — bare columns are safe here (no JOIN)
    return this.query<UserWordProgressRow>(
      `SELECT ${PROGRESS_COLUMNS}
       FROM user_word_progress
       WHERE word_id = $1::uuid
         AND content_hash_snapshot IS NOT NULL
         AND content_hash_snapshot != (
           SELECT content_hash FROM words WHERE id = $1::uuid
         )`,
      [wordId],
    );
  }

  /**
   * Mark stale cards for recheck. Also sets needs_recheck=true (B fix).
   * Returns the number of affected rows.
   *
   * @deprecated Use {@link markL1StaleForRecheck} instead — it tracks the L1
   * content hash snapshot separately via `l1_content_hash_snapshot`. This
   * method remains for backward compatibility using the full
   * `content_hash_snapshot` column.
   */
  async markStaleForRecheck(wordId: string, newHash: string): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_progress
       SET content_hash_snapshot = $1,
           needs_recheck = true,
           state = CASE
             WHEN state = 'review' THEN 'relearning'
             WHEN state = 'new' THEN 'new'
             ELSE state
           END,
           due_at = now()
       WHERE word_id = $2::uuid
         AND content_hash_snapshot IS NOT NULL
         AND content_hash_snapshot != $1
       RETURNING id`,
      [newHash, wordId],
    );
    return rows.length;
  }

  /**
   * Mark stale cards for recheck using the L1 content hash snapshot.
   * Updates `l1_content_hash_snapshot` (not the full `content_hash_snapshot`),
   * sets `needs_recheck = true`, demotes `review` → `relearning`, and resets
   * `due_at` to now. Returns the number of affected rows.
   */
  async markL1StaleForRecheck(wordId: string, newL1Hash: string): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_progress
       SET l1_content_hash_snapshot = $1,
           needs_recheck = true,
           state = CASE
             WHEN state = 'review' THEN 'relearning'
             WHEN state = 'new' THEN 'new'
             ELSE state
           END,
           due_at = now()
       WHERE word_id = $2::uuid
         AND l1_content_hash_snapshot IS NOT NULL
         AND l1_content_hash_snapshot != $1
       RETURNING id`,
      [newL1Hash, wordId],
    );
    return rows.length;
  }

  /**
   * Set the L1 weak-signal flag for one progress row, scoped to
   * (user, wordbook, word). Phase 2C decision-2: this ONLY flips the flag —
   * it deliberately does NOT touch due_at, needs_recheck, or state, because
   * L2辨析 failure ≠ L1 recognition weakness; the user decides whether to
   * re-grind L1 after seeing the flag in the UI. Returns the updated row count.
   */
  async markL1WeakSignal(
    userId: string,
    wordbookId: string,
    wordId: string,
    value: boolean,
  ): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_progress
       SET l1_weak_signal = $4, updated_at = now()
       WHERE user_id = $1 AND wordbook_id = $2::uuid AND word_id = $3::uuid
       RETURNING id`,
      [userId, wordbookId, wordId, value],
    );
    return rows.length;
  }
}
