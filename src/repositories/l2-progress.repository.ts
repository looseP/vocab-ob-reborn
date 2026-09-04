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
 * Only finalizeL2ContentHash is word-level: L2 content is global per word, so
 * a content-hash change must re-evaluate every scoped row for that word.
 */

import type { Json, L2DrillStepRow, ReviewRating, UserWordL2ProgressRow } from "../domain";
import type {
  IL2ProgressRepository,
  L2ProgressForUpdate,
  L2WordContent,
  NewL2DrillStep,
  NewL2Progress,
  SaveL2AnswerInput,
} from "./interfaces";
import { BaseRepository } from "./base";

const RATING_COUNTER: Record<ReviewRating, string> = {
  again: "l2_again_count",
  hard: "l2_hard_count",
  good: "l2_good_count",
  easy: "l2_easy_count",
};

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
         (user_id, wordbook_id, word_id, l2_stability, l2_difficulty, l2_state, l2_desired_retention, l2_due_at, l2_inherited_from_l1, l2_weights_source, l2_scheduler_payload)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
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
        data.l2_scheduler_payload ? JSON.stringify(data.l2_scheduler_payload) : null,
      ],
    );
    if (!row) throw new Error("L2 progress insert returned no row");
    return row;
  }

  async findDueCards(
    userId: string,
    wordbookId: string,
    limit: number,
  ): Promise<Array<{ progress: UserWordL2ProgressRow; word: L2WordContent }>> {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT p.*, w.id AS w_id, w.slug AS w_slug, w.title AS w_title, w.lemma AS w_lemma,
              w.pos AS w_pos, w.ipa AS w_ipa, w.cefr AS w_cefr,
              w.short_definition AS w_short_definition,
              w.corpus_items AS w_corpus_items, w.synonym_items AS w_synonym_items,
              w.antonym_items AS w_antonym_items
       FROM user_word_l2_progress p
       JOIN words w ON w.id = p.word_id
       WHERE p.user_id = $1 AND p.wordbook_id = $2::uuid
         AND p.l2_paused = false
         AND p.l2_due_at <= now()
       ORDER BY p.l2_due_at ASC
       LIMIT $3`,
      [userId, wordbookId, limit],
    );
    return rows.map((row) => this.mapWithWord(row));
  }

  async findForUpdate(progressId: string, userId: string): Promise<L2ProgressForUpdate | null> {
    const row = await this.queryOne<Record<string, unknown>>(
      `SELECT p.*, w.id AS w_id, w.slug AS w_slug, w.title AS w_title, w.lemma AS w_lemma,
              w.pos AS w_pos, w.ipa AS w_ipa, w.cefr AS w_cefr,
              w.short_definition AS w_short_definition,
              w.corpus_items AS w_corpus_items, w.synonym_items AS w_synonym_items,
              w.antonym_items AS w_antonym_items
       FROM user_word_l2_progress p
       JOIN words w ON w.id = p.word_id
       WHERE p.id = $1::uuid AND p.user_id = $2::uuid
       FOR UPDATE OF p`,
      [progressId, userId],
    );
    return row ? this.mapWithWord(row) : null;
  }

  async saveL2Answer(input: SaveL2AnswerInput): Promise<{ reviewLogId: string }> {
    // 防御性重建（spec §四读侧兜底）：payload 缺失/为空时从行上标量列重建，
    // 绝不让继承卡退化成 New 卡。
    const payload = this.hasUsablePayload(input.nextPayload)
      ? input.nextPayload
      : {
          difficulty: Number(input.difficulty),
          due: input.dueAt,
          elapsed_days: 0,
          lapses: 0,
          learning_steps: 0,
          last_review: input.lastReviewedAt,
          reps: 1,
          scheduled_days: input.scheduledDays ?? 0,
          stability: Number(input.stability),
          state: 2,
        };

    await this.query(
      `UPDATE user_word_l2_progress SET
         l2_stability = $1, l2_difficulty = $2, l2_retrievability = $3,
         l2_state = $4, l2_due_at = $5, l2_last_reviewed_at = $6, l2_last_rating = $7,
         l2_interval_days = $8, l2_scheduler_payload = $9::jsonb,
         l2_content_hash_snapshot = $10,
         l2_review_count = l2_review_count + 1,
         ${RATING_COUNTER[input.rating]} = ${RATING_COUNTER[input.rating]} + 1,
         l2_lapse_count = l2_lapse_count + (CASE WHEN $7::text = 'again' AND l2_state = 'review' THEN 1 ELSE 0 END),
         recent_ratings = (
           SELECT jsonb_agg(elem ORDER BY ord)
           FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(
               recent_ratings || to_jsonb($7::text)
             ) WITH ORDINALITY t(elem, ord)
             ORDER BY ord DESC
             LIMIT 5
           ) sub
         )
       WHERE id = $11::uuid AND user_id = $12::uuid`,
      [
        input.stability,
        input.difficulty,
        input.retrievability,
        input.state,
        input.dueAt,
        input.lastReviewedAt,
        input.rating,
        input.intervalDays,
        JSON.stringify(payload),
        input.contentHashSnapshot,
        input.progressId,
        input.userId,
      ],
    );

    const logRow = await this.queryOne<{ id: string }>(
      `INSERT INTO review_logs
         (user_id, word_id, session_id, rating, state, due_at,
          reviewed_at, elapsed_days, scheduled_days,
          stability, difficulty, metadata, progress_id, wordbook_id, idempotency_key, track,
          previous_progress_snapshot)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
               $7, $8, $9,
               $10, $11, $12::jsonb, $13::uuid, $14::uuid, $15, 'l2', $16::jsonb)
       RETURNING id`,
      [
        input.userId,
        input.wordId,
        input.sessionId,
        input.rating,
        input.state,
        input.dueAt,
        // H3 修复：显式填 reviewed_at（与 L1 路径 review.repository.ts 一致，
        // 不再依赖列默认值 now()，避免与 lastReviewedAt 语义漂移）。
        input.lastReviewedAt,
        // H3 修复：列对齐修正
        //   之前：$7 = scheduledDays 错填到 elapsed_days；$8 = null 错填到 scheduled_days
        //   现在：elapsed_days ← scheduling.elapsedDays；scheduled_days ← scheduling.scheduledDays
        input.elapsedDays,
        input.scheduledDays,
        String(input.stability),
        String(input.difficulty),
        JSON.stringify(input.logMetadata ?? {}),
        input.progressId,
        input.wordbookId,
        input.idempotencyKey,
        JSON.stringify(input.previousSnapshot ?? {}),
      ],
    );
    if (!logRow) throw new Error("L2 review log insert returned no id");
    return { reviewLogId: logRow.id };
  }

  async updateProductionStatus(
    userId: string,
    wordbookId: string,
    wordId: string,
    status: "passed" | "weak" | null,
  ): Promise<void> {
    await this.query(
      `UPDATE user_word_l2_progress
       SET l2_production_status = $4
       WHERE user_id = $1 AND wordbook_id = $2::uuid AND word_id = $3::uuid`,
      [userId, wordbookId, wordId, status],
    );
  }

  async insertDrillStepIfAbsent(data: NewL2DrillStep): Promise<L2DrillStepRow> {
    // ON CONFLICT DO NOTHING + 回读：同 (session, word, step_index) 已存在时
    // 返回既有行（含 completed/skipped 状态），绝不复活已结算的步。
    const inserted = await this.queryOne<L2DrillStepRow>(
      `INSERT INTO l2_drill_session_steps
         (session_id, user_id, wordbook_id, word_id, progress_id, step_index, step_type, task_id, task_type, task_payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (session_id, word_id, step_index) DO NOTHING
       RETURNING *`,
      [
        data.session_id,
        data.user_id,
        data.wordbook_id,
        data.word_id,
        data.progress_id,
        data.step_index,
        data.step_type,
        data.task_id ?? null,
        data.task_type ?? null,
        data.task_payload ? JSON.stringify(data.task_payload) : null,
      ],
    );
    if (inserted) return inserted;
    // M3 修复：冲突回读必须按 user_id 过滤。ON CONFLICT 唯一键不含 user，
    // 若攻击者持有他人 session_id+word_id+step_index，回读会取到他人行的
    // task_payload（DB 存储含 answerIndex）→ 答案泄漏路径。session UUID v4
    // 不可枚举所以风险可控，但防御纵深要求 owner-scoped 过滤。
    const existing = await this.queryOne<L2DrillStepRow>(
      `SELECT * FROM l2_drill_session_steps
       WHERE user_id = $1::uuid AND session_id = $2::uuid AND word_id = $3::uuid AND step_index = $4`,
      [data.user_id, data.session_id, data.word_id, data.step_index],
    );
    if (!existing) throw new Error("L2 drill step insert returned no row");
    return existing;
  }

  async findDrillStepForUpdate(stepId: string, userId: string): Promise<L2DrillStepRow | null> {
    return this.queryOne<L2DrillStepRow>(
      `SELECT * FROM l2_drill_session_steps
       WHERE id = $1::uuid AND user_id = $2::uuid
       FOR UPDATE`,
      [stepId, userId],
    );
  }

  async findLastDrillStep(sessionId: string, userId: string): Promise<L2DrillStepRow | null> {
    return this.queryOne<L2DrillStepRow>(
      `SELECT * FROM l2_drill_session_steps
       WHERE session_id = $1::uuid AND user_id = $2::uuid
       ORDER BY created_at DESC, step_index DESC
       LIMIT 1`,
      [sessionId, userId],
    );
  }

  // M5 修复：幂等重放查找同会话同词指定 step_index 行（与 insertDrillStepIfAbsent
  // 的 ON CONFLICT 回读 SQL 等价，但允许任意 step_index、且不做 FOR UPDATE）。
  // 调用方仅在校验到幂等重放后使用，避免在首次写路径上持有锁。
  async findDrillStepBySessionWordStep(
    sessionId: string,
    userId: string,
    wordId: string,
    stepIndex: number,
  ): Promise<L2DrillStepRow | null> {
    return this.queryOne<L2DrillStepRow>(
      `SELECT * FROM l2_drill_session_steps
       WHERE session_id = $1::uuid AND user_id = $2::uuid AND word_id = $3::uuid AND step_index = $4`,
      [sessionId, userId, wordId, stepIndex],
    );
  }

  // M8 修复：取本会话所有 pending 产出步（step_index >= 1 且 step_type='l2_production'
  // 且 status='pending'）。JOIN progress + words，让 getQueue 在常规到期卡之外
  // 追加这些半截会话步，避免用户刷新后产出口 lost-in-session。
  // 不上锁：调用方在 getQueue 中是只读补集，INSERT 已在第一次出队时完成。
  async findPendingProductionStepsForResume(
    sessionId: string,
    userId: string,
  ): Promise<
    Array<{
      step: L2DrillStepRow;
      progress: UserWordL2ProgressRow;
      word: L2WordContent;
    }>
  > {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT s.*,
              p.id AS p_id, p.user_id AS p_user_id, p.wordbook_id AS p_wordbook_id,
              p.word_id AS p_word_id, p.l2_stability AS p_l2_stability,
              p.l2_difficulty AS p_l2_difficulty, p.l2_state AS p_l2_state,
              p.l2_desired_retention AS p_l2_desired_retention,
              p.l2_due_at AS p_l2_due_at, p.l2_last_reviewed_at AS p_l2_last_reviewed_at,
              p.l2_last_rating AS p_l2_last_rating, p.l2_review_count AS p_l2_review_count,
              p.l2_again_count AS p_l2_again_count, p.l2_hard_count AS p_l2_hard_count,
              p.l2_good_count AS p_l2_good_count, p.l2_easy_count AS p_l2_easy_count,
              p.l2_lapse_count AS p_l2_lapse_count, p.l2_interval_days AS p_l2_interval_days,
              p.l2_retrievability AS p_l2_retrievability,
              p.l2_scheduler_payload AS p_l2_scheduler_payload,
              p.l2_inherited_from_l1 AS p_l2_inherited_from_l1,
              p.l2_weights_source AS p_l2_weights_source,
              p.l2_content_hash_snapshot AS p_l2_content_hash_snapshot,
              p.l2_paused AS p_l2_paused, p.l2_paused_at AS p_l2_paused_at,
              p.l2_paused_reason AS p_l2_paused_reason,
              p.l2_production_status AS p_l2_production_status,
              p.recent_ratings AS p_recent_ratings,
              p.created_at AS p_created_at,
              w.id AS w_id, w.slug AS w_slug, w.title AS w_title, w.lemma AS w_lemma,
              w.pos AS w_pos, w.ipa AS w_ipa, w.cefr AS w_cefr,
              w.short_definition AS w_short_definition,
              w.corpus_items AS w_corpus_items, w.synonym_items AS w_synonym_items,
              w.antonym_items AS w_antonym_items
       FROM l2_drill_session_steps s
       JOIN user_word_l2_progress p ON p.id = s.progress_id AND p.user_id = s.user_id
       JOIN words w ON w.id = s.word_id
       WHERE s.session_id = $1::uuid AND s.user_id = $2::uuid
         AND s.step_type = 'l2_production' AND s.status = 'pending'
       ORDER BY s.created_at ASC, s.step_index ASC`,
      [sessionId, userId],
    );
    return rows.map((row) => {
      const {
        w_id, w_slug, w_title, w_lemma, w_pos, w_ipa, w_cefr, w_short_definition,
        w_corpus_items, w_synonym_items, w_antonym_items,
        p_id, p_user_id, p_wordbook_id, p_word_id, p_l2_stability, p_l2_difficulty,
        p_l2_state, p_l2_desired_retention, p_l2_due_at, p_l2_last_reviewed_at,
        p_l2_last_rating, p_l2_review_count, p_l2_again_count, p_l2_hard_count,
        p_l2_good_count, p_l2_easy_count, p_l2_lapse_count, p_l2_interval_days,
        p_l2_retrievability, p_l2_scheduler_payload, p_l2_inherited_from_l1,
        p_l2_weights_source, p_l2_content_hash_snapshot, p_l2_paused, p_l2_paused_at,
        p_l2_paused_reason, p_l2_production_status, p_recent_ratings,
        p_created_at,
        ...stepRow
      } = row as Record<string, unknown>;
      const word: L2WordContent = {
        id: String(w_id),
        slug: String(w_slug),
        title: String(w_title),
        lemma: String(w_lemma),
        pos: (w_pos as string) ?? null,
        ipa: (w_ipa as string) ?? null,
        cefr: (w_cefr as string) ?? null,
        short_definition: (w_short_definition as string) ?? null,
        corpus_items: (w_corpus_items ?? []) as Json,
        synonym_items: (w_synonym_items ?? []) as Json,
        antonym_items: (w_antonym_items ?? []) as Json,
      };
      const progress = {
        id: String(p_id),
        user_id: String(p_user_id),
        wordbook_id: String(p_wordbook_id),
        word_id: String(p_word_id),
        l2_stability: p_l2_stability,
        l2_difficulty: p_l2_difficulty,
        l2_state: p_l2_state,
        l2_desired_retention: p_l2_desired_retention,
        l2_due_at: p_l2_due_at,
        l2_last_reviewed_at: p_l2_last_reviewed_at,
        l2_last_rating: p_l2_last_rating,
        l2_review_count: p_l2_review_count,
        l2_again_count: p_l2_again_count,
        l2_hard_count: p_l2_hard_count,
        l2_good_count: p_l2_good_count,
        l2_easy_count: p_l2_easy_count,
        l2_lapse_count: p_l2_lapse_count,
        l2_interval_days: p_l2_interval_days,
        l2_retrievability: p_l2_retrievability,
        l2_scheduler_payload: p_l2_scheduler_payload,
        l2_inherited_from_l1: p_l2_inherited_from_l1,
        l2_weights_source: p_l2_weights_source,
        l2_content_hash_snapshot: p_l2_content_hash_snapshot,
        l2_paused: p_l2_paused,
        l2_paused_at: p_l2_paused_at,
        l2_paused_reason: p_l2_paused_reason,
        l2_production_status: p_l2_production_status,
        recent_ratings: p_recent_ratings,
        created_at: p_created_at,
      } as unknown as UserWordL2ProgressRow;
      return {
        step: stepRow as unknown as L2DrillStepRow,
        progress,
        word,
      };
    });
  }

  async completeDrillStep(
    stepId: string,
    userId: string,
    patch: {
      outcome: NonNullable<L2DrillStepRow["outcome"]>;
      mappedRating?: L2DrillStepRow["mapped_rating"];
      reviewLogId?: string | null;
    },
  ): Promise<void> {
    await this.query(
      `UPDATE l2_drill_session_steps
       SET status = 'completed', outcome = $3, mapped_rating = $4,
           review_log_id = COALESCE($5::uuid, review_log_id), completed_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid`,
      [stepId, userId, patch.outcome, patch.mappedRating ?? null, patch.reviewLogId ?? null],
    );
  }

  async skipDrillStep(stepId: string, userId: string): Promise<void> {
    await this.query(
      `UPDATE l2_drill_session_steps
       SET status = 'skipped', completed_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'`,
      [stepId, userId],
    );
  }

  async deleteDrillStep(stepId: string, userId: string): Promise<void> {
    await this.query(
      `DELETE FROM l2_drill_session_steps WHERE id = $1::uuid AND user_id = $2::uuid`,
      [stepId, userId],
    );
  }

  // ── M7 修复：L2 辨析步撤销方法族 ────────────────────────────────────
  // 没有走 undo_review_log SQL RPC，因 RPC 硬绑定 track='l1' 且更新
  // user_word_progress（L1 表）。L2 表是 user_word_l2_progress，所以
  // 在应用层用 SQL 等价实现：读 snapshot → 回写 progress → 标 undone →
  // 插幂等审计行。整套操作 MUST 在调用方的事务中完成。

  async findReviewLogForL2Undo(
    reviewLogId: string,
    userId: string,
  ): Promise<{
    wordId: string;
    wordbookId: string;
    undone: boolean;
    previousSnapshot: Json;
  } | null> {
    return this.queryOne<{
      word_id: string;
      wordbook_id: string;
      undone: boolean;
      previous_snapshot: Json;
    }>(
      `SELECT word_id, wordbook_id, undone, previous_progress_snapshot AS previous_snapshot
       FROM review_logs
       WHERE id = $1::uuid AND user_id = $2::uuid AND track = 'l2'
       FOR UPDATE`,
      [reviewLogId, userId],
    ).then((row) => {
      if (!row) return null;
      return {
        wordId: row.word_id,
        wordbookId: row.wordbook_id,
        undone: row.undone,
        previousSnapshot: row.previous_snapshot,
      };
    });
  }

  async applyL2UndoSnapshot(
    progressId: string,
    userId: string,
    previousSnapshot: Json,
  ): Promise<number> {
    // snapshot 字段对齐 saveL2Answer 写入的 previousSnapshot：
    //   l2_stability / l2_difficulty / l2_state / l2_due_at / recent_ratings。
    // 与 L1 RPC 回写 user_word_progress 等价，但作用于 user_word_l2_progress。
    // 没回写 l2_scheduler_payload，因为 snapshot 中未包含它（saveL2Answer
    // 的 previousSnapshot 不写 l2_scheduler_payload，是已知的快照边界）。
    // 为防止 payload 漂移，回写后保留既有 l2_scheduler_payload，读侧兜底
    // 在下次 answerWithinTx 时会重建。
    const snap = (previousSnapshot ?? {}) as Record<string, unknown>;
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_l2_progress SET
         l2_stability = COALESCE($3::numeric, l2_stability),
         l2_difficulty = COALESCE($4::numeric, l2_difficulty),
         l2_state = COALESCE($5::text, l2_state),
         l2_due_at = COALESCE($6::timestamptz, l2_due_at),
         recent_ratings = COALESCE($7::jsonb, recent_ratings)
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING id`,
      [
        progressId,
        userId,
        snap.l2_stability ?? null,
        snap.l2_difficulty ?? null,
        snap.l2_state ?? null,
        snap.l2_due_at ?? null,
        snap.recent_ratings != null ? JSON.stringify(snap.recent_ratings) : null,
      ],
    );
    return rows.length;
  }

  async markL2ReviewLogUndone(reviewLogId: string, userId: string): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE review_logs
       SET undone = true, undone_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid AND track = 'l2' AND undone = false
       RETURNING id`,
      [reviewLogId, userId],
    );
    return rows.length;
  }

  async insertL2UndoAuditLog(input: {
    userId: string;
    wordId: string;
    wordbookId: string;
    progressId: string;
    sessionId: string;
    reviewLogId: string;
    restoredState: string;
    idempotencyKey: string | null;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.query(
      `INSERT INTO review_logs (
         user_id, word_id, wordbook_id, progress_id, session_id,
         rating, state, metadata, reviewed_at, idempotency_key, track
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         NULL, $6, $7, $8, $9, 'l2'
       )`,
      [
        input.userId,
        input.wordId,
        input.wordbookId,
        input.progressId,
        input.sessionId,
        input.restoredState,
        JSON.stringify({ action: "undo", undone_log_id: input.reviewLogId }),
        nowIso,
        input.idempotencyKey,
      ],
    );
  }

  private mapWithWord(row: Record<string, unknown>): L2ProgressForUpdate {
    const {
      w_id,
      w_slug,
      w_title,
      w_lemma,
      w_pos,
      w_ipa,
      w_cefr,
      w_short_definition,
      w_corpus_items,
      w_synonym_items,
      w_antonym_items,
      ...progress
    } = row as Record<string, unknown>;
    const word: L2WordContent = {
      id: String(w_id),
      slug: String(w_slug),
      title: String(w_title),
      lemma: String(w_lemma),
      pos: (w_pos as string) ?? null,
      ipa: (w_ipa as string) ?? null,
      cefr: (w_cefr as string) ?? null,
      short_definition: (w_short_definition as string) ?? null,
      corpus_items: (w_corpus_items ?? []) as Json,
      synonym_items: (w_synonym_items ?? []) as Json,
      antonym_items: (w_antonym_items ?? []) as Json,
    };
    return { progress: progress as unknown as UserWordL2ProgressRow, word };
  }

  /** A payload is usable only when it can round-trip through toCard without degrading to a New card. */
  private hasUsablePayload(payload: Json): boolean {
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
    const rec = payload as Record<string, unknown>;
    if (!("due" in rec)) return false;
    return !Number.isNaN(new Date(String(rec.due)).getTime());
  }

  /** Persist canonical hashes and schedule changed, non-paused L2 snapshots atomically. */
  async finalizeL2ContentHash(
    wordId: string,
    newL2Hash: string,
    newContentHash: string,
  ): Promise<number> {
    const row = await this.queryOne<{ updated_count: number }>(
      `SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text) AS updated_count`,
      [wordId, newL2Hash, newContentHash],
    );
    return row?.updated_count ?? 0;
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
