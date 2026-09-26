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
  BulkForgetBatchInput,
  BulkSuspendByWordbookInput,
  ForgettingPreviewRow,
  IReviewRepository,
  InsertNewCardInput,
  InsertNewCardStatus,
  ProgressForAction,
  ProgressWithContentHash,
  SaveAnswerInput,
  UndoRpcResult,
} from "./interfaces";
import { BaseRepository } from "./base";
import { ValidationError } from "../errors";
import { startOfTodayIsoInDisplayTz } from "../db/timezone";
import { LEECH_LAPSE_THRESHOLD } from "../domain/review.entity";

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
  uwp.content_hash_snapshot, uwp.l1_content_hash_snapshot, uwp.skip_count, uwp.created_at, uwp.updated_at,
  uwp.recent_ratings, uwp.l1_weak_signal, uwp.needs_recheck, uwp.ladder_rung
`;

// Bare columns for single-table queries (no JOIN ambiguity)
const PROGRESS_COLUMNS = PROGRESS_COLUMNS_PREFIXED.replace(/uwp\./g, "");

/** numeric/int 列（pg 可能返回字符串）→ number|null；非有限值一律 null。 */
function toNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Joined progress + word row shape returned by the queue queries. */
type ReviewCardQueryRow = UserWordProgressRow & {
  slug: string;
  title: string;
  lemma: string;
  w_id: string;
  short_definition: string | null;
  ipa: string | null;
  pos: string | null;
  cefr: string | null;
  needs_recheck: boolean;
  /**
   * words 侧的两个 hash，供 needs_recheck 读时派生（ADR-0021）：
   * 只有 findDueCandidates 选择它们，其余 JOIN 查询不选 → 可选。
   * 经 mapReviewCardRows 的 rest-spread 落在 progress 侧（与
   * ProgressWithContentHash 的既有约定一致）。
   */
  content_hash?: string;
  l1_content_hash?: string | null;
  /**
   * T3 Hint 阶梯（2026-09-25）：words 侧提示字段。仅 queue 系查询
   * （findDueCards/findPracticeCards/findDueCandidates/findWordsByIds）选取；
   * mnemonic/chain 从 words.metadata 派生（SQL 内 COALESCE，沿用
   * findForgettingPreviewRows 的取数先例），drill/leeches 查询不选。
   */
  examples?: Json | null;
  prototype_text?: string | null;
  mnemonic_text?: string | null;
  mnemonic_type?: string | null;
  semantic_chain?: string | null;
};

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
    const rows = await this.query<ReviewCardQueryRow>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.id AS w_id, w.slug, w.title, w.lemma,
              w.short_definition, w.ipa, w.pos, w.cefr,
              w.examples, w.prototype_text,
              COALESCE(w.metadata->>'mnemonic_text', w.metadata->>'mnemonic') AS mnemonic_text,
              w.metadata->>'mnemonic_type' AS mnemonic_type,
              w.metadata->>'semantic_chain' AS semantic_chain
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.state != 'suspended'
         AND (uwp.due_at IS NULL OR uwp.due_at <= now())
       ORDER BY uwp.due_at ASC NULLS FIRST, uwp.last_reviewed_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit],
    );

    return this.mapReviewCardRows(rows);
  }

  /**
   * Find all active (non-suspended) cards for a user/wordbook, regardless of
   * due_at. Used by the practice modes (cram / preview) which are NOT limited
   * by the FSRS schedule. No scheduling side-effects happen in those modes.
   */
  async findPracticeCards(
    userId: string,
    wordbookId: string,
    limit: number,
  ) {
    const rows = await this.query<ReviewCardQueryRow>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.id AS w_id, w.slug, w.title, w.lemma,
              w.short_definition, w.ipa, w.pos, w.cefr,
              w.examples, w.prototype_text,
              COALESCE(w.metadata->>'mnemonic_text', w.metadata->>'mnemonic') AS mnemonic_text,
              w.metadata->>'mnemonic_type' AS mnemonic_type,
              w.metadata->>'semantic_chain' AS semantic_chain
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.state != 'suspended'
       ORDER BY uwp.due_at ASC NULLS FIRST, uwp.last_reviewed_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit],
    );

    return this.mapReviewCardRows(rows);
  }

  /**
   * Find all due (schedule-eligible) candidate cards for a user/wordbook.
   * Unlike findDueCards this is used as the *candidate pool* for the P1
   * queue-priority builder (review/zen): a larger pool is fetched and the
   * service layer applies priority bucketing + the new-card quota before
   * returning the final batch. Carries needs_recheck (人工标记) plus the
   * words-side hashes so the service can derive "content changed" at read
   * time (ADR-0021: 读时派生，零写入).
   */
  async findDueCandidates(
    userId: string,
    wordbookId: string,
    limit: number,
  ): Promise<Array<{ progress: UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }>> {
    const rows = await this.query<ReviewCardQueryRow>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.id AS w_id, w.slug, w.title, w.lemma,
              w.short_definition, w.ipa, w.pos, w.cefr,
              w.examples, w.prototype_text,
              COALESCE(w.metadata->>'mnemonic_text', w.metadata->>'mnemonic') AS mnemonic_text,
              w.metadata->>'mnemonic_type' AS mnemonic_type,
              w.metadata->>'semantic_chain' AS semantic_chain,
              w.content_hash, w.l1_content_hash
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.state != 'suspended'
         AND (uwp.due_at IS NULL OR uwp.due_at <= now())
       ORDER BY uwp.due_at ASC NULLS FIRST, uwp.last_reviewed_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit],
    );

    return this.mapReviewCardRows<
      UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }
    >(rows);
  }

  /**
   * Fetch words by ids for the free-review (勾选) flow — P2. Mirrors the
   * original free/queue semantics: query the words table directly (published
   * only), regardless of review-progress membership, so the user can freely
   * pick any word from the library. Order is re-applied by the caller to
   * preserve the user's selection order.
   */
  async findWordsByIds(
    wordIds: string[],
  ): Promise<Array<{ id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null }>> {
    if (wordIds.length === 0) return [];
    const rows = await this.query<{ id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: Json | null; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null }>(
      `SELECT id, slug, title, lemma, short_definition, ipa, pos, cefr,
              examples, prototype_text,
              COALESCE(metadata->>'mnemonic_text', metadata->>'mnemonic') AS mnemonic_text,
              metadata->>'mnemonic_type' AS mnemonic_type,
              metadata->>'semantic_chain' AS semantic_chain
       FROM words
       WHERE id = ANY($1::uuid[]) AND is_published = true AND is_deleted = false`,
      [wordIds],
    );
    return rows.map((row) => ({
      ...row,
      examples: Array.isArray(row.examples) ? (row.examples as unknown[]) : [],
    }));
  }

  /**
   * Fetch drill candidates (cram 练习变体): already-reviewed words
   * (state != new/suspended, review_count >= 1) joined with their examples,
   * so the service layer can resolve a cloze per word. Purely read-only.
   */
  async findDrillCandidates(
    userId: string,
    wordbookId: string,
    limit: number,
  ): Promise<Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; examples: Json } }>> {
    const rows = await this.query<UserWordProgressRow & { slug: string; title: string; lemma: string; w_id: string; short_definition: string | null; examples: Json }>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.id AS w_id, w.slug, w.title, w.lemma, w.short_definition, w.examples
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.state != 'new' AND uwp.state != 'suspended'
         AND uwp.review_count >= 1
       ORDER BY uwp.due_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit],
    );
    return rows.map((r) => {
      const { slug, title, lemma, w_id, short_definition, examples, ...progress } = r;
      return {
        progress: progress as UserWordProgressRow,
        word: { id: w_id, slug, title, lemma, short_definition, examples },
      };
    });
  }

  private mapReviewCardRows<T extends UserWordProgressRow = UserWordProgressRow>(
    rows: Array<ReviewCardQueryRow>,
  ): Array<{ progress: T; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }> {
    return rows.map((r) => {
      const { slug, title, lemma, w_id, short_definition, ipa, pos, cefr, examples, prototype_text, mnemonic_text, mnemonic_type, semantic_chain, ...progress } = r;
      return {
        progress: progress as unknown as T,
        word: {
          id: w_id, slug, title, lemma, short_definition, ipa, pos, cefr,
          // T3 Hint 阶梯：examples jsonb notNull；非数组防御归一（旧数据形态兜底）
          examples: Array.isArray(examples) ? (examples as unknown[]) : [],
          prototype_text: prototype_text ?? null,
          mnemonic_text: mnemonic_text ?? null,
          mnemonic_type: mnemonic_type ?? null,
          semantic_chain: semantic_chain ?? null,
        },
      };
    });
  }

  /**
   * User-scoped advisory lock + idempotency check. MUST be in a transaction.
   * The lock identity exactly matches the lookup/unique-index scope.
   * H4 fix: requireTx() enforces transaction context.
   */
  async checkIdempotency(userId: string, idempotencyKey: string): Promise<string | null> {
    this.requireTx();
    await this.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [userId, idempotencyKey],
    );
    const rows = await this.query<{ id: string }>(
      `SELECT id FROM review_logs
       WHERE user_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [userId, idempotencyKey],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Atomically create a new L1 card (state='new', algo='fsrs').
   * Word existence and wordbook ownership are guarded in the same transaction;
   * a duplicate (user_id, word_id, wordbook_id) resolves to 'duplicate'.
   * MUST be in a transaction.
   */
  async insertNewCard(input: InsertNewCardInput): Promise<InsertNewCardStatus> {
    this.requireTx();
    const word = await this.queryOne<{ id: string }>(
      `SELECT id FROM words WHERE id = $1::uuid`,
      [input.wordId],
    );
    if (!word) return { status: "word_not_found", progressId: null };

    const wordbook = await this.queryOne<{ id: string }>(
      `SELECT id FROM wordbooks WHERE id = $1::uuid AND user_id = $2`,
      [input.wordbookId, input.userId],
    );
    if (!wordbook) return { status: "wordbook_invalid", progressId: null };

    const rows = await this.query<{ id: string }>(
      `INSERT INTO user_word_progress
         (user_id, word_id, wordbook_id, schedule_algo, state, desired_retention)
       VALUES ($1, $2::uuid, $3::uuid, 'fsrs', 'new', $4)
       ON CONFLICT (user_id, word_id, wordbook_id) DO NOTHING
       RETURNING id`,
      [input.userId, input.wordId, input.wordbookId, input.desiredRetention],
    );
    const row = rows[0];
    if (!row) return { status: "duplicate", progressId: null };
    return { status: "inserted", progressId: row.id };
  }

  /**
   * Owner-scoped SELECT FOR UPDATE with word join for slug/title/lemma.
   * MUST be in a transaction. M7 fix: include word fields.
   * FOR UPDATE OF uwp locks only the progress row — words is read-only for
   * vocab_app (GRANT SELECT only), so locking the joined words table would
   * fail with permission denied (regression guard: L2 repo already uses
   * `FOR UPDATE OF p` for the same reason).
   */
  async findProgressForUpdate(progressId: string, userId: string): Promise<ProgressWithContentHash | null> {
    this.requireTx();
    return this.queryOne<ProgressWithContentHash>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.content_hash, w.slug AS word_slug, w.title AS word_title, w.lemma AS word_lemma
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.id = $1::uuid AND uwp.user_id = $2
       FOR UPDATE OF uwp`,
      [progressId, userId],
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
   * 主动晋升入口（Phase F）：按 (user, wordbook, word) 读 L1 进度行。
   * user_word_progress 是 owner-RLS 表——调用方必须在携带
   * request.jwt.claim.sub 的事务内执行（见 createServices 注入闭包）。
   */
  async findByUserWordbookWord(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<UserWordProgressRow | null> {
    return this.queryOne<UserWordProgressRow>(
      `SELECT * FROM user_word_progress
       WHERE user_id = $1 AND wordbook_id = $2::uuid AND word_id = $3::uuid`,
      [userId, wordbookId, wordId],
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

  async findProgressForOutbox(
    progressId: string,
    userId: string,
    wordbookId: string,
  ): Promise<UserWordProgressRow | null> {
    this.requireTx();
    return this.queryOne<UserWordProgressRow>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED}
       FROM user_word_progress uwp
       WHERE uwp.id = $1::uuid
         AND uwp.user_id = $2::uuid
         AND uwp.wordbook_id = $3::uuid
       FOR UPDATE`,
      [progressId, userId, wordbookId],
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
    //   recent_ratings || to_jsonb($16::text)  — append a separately typed rating value
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
                 recent_ratings || to_jsonb($16::text)
               ) WITH ORDINALITY t(elem, ord)
               ORDER BY ord DESC
               LIMIT 5
             ) sub
           ),
           ladder_rung = COALESCE($17, ladder_rung),
           updated_at = $12
       WHERE id = $13::uuid AND user_id = $14::uuid AND wordbook_id = $15::uuid`,
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
        input.userId,
        input.wordbookId,
        String(input.rating), // $16: text for JSON append; $5 remains the enum value
        input.ladderRung ?? null, // $17: 阶梯起步档结算结果（COALESCE 保缺省原值）
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
       WHERE id = $2::uuid AND user_id = $3::uuid AND wordbook_id = $4::uuid`,
      [nowIso, progress.id, userId, progress.wordbook_id],
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
       WHERE id = $2::uuid AND user_id = $3::uuid AND wordbook_id = $4::uuid`,
      [nowIso, progress.id, userId, progress.wordbook_id],
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

  // ── 一键遗忘（ADR-0020）：书级非破坏挂起 / 精确批次恢复 ──────────────────
  //
  // 语义红线（ADR-0020）：遗忘 = 挂起。这些方法**永不删除进度行、永不重置
  // stability、永不推 due_at**——只改 state（挂起）或从批次快照回写 state（恢复）。
  //
  // 与 suspendCard 的**有意偏离**：suspendCard 把 review_logs.state 写成**新**状态
  // （'suspended'）；批量挂起把 review_logs.state 写成**旧**状态，并在
  // previous_progress_snapshot 里冗余保存 `{state}`——因为 restore 要求仅凭本批次
  // 日志就能把每一行精确还原到遗忘前的状态，必须有旧 state 的保真快照。
  // 两者都是 rating=NULL 的非作答事件（CONTEXT.md「Non-answer event」）。

  /**
   * 该书预览行：L1 进度（state/stability/retrievability/recent_ratings/lapse_count）
   * + 词条锚点元数据（morphology_root / mnemonic_text / semantic_chain / aliases）。
   * 只读；numeric 列归一为 number|null。
   */
  async findForgettingPreviewRows(userId: string, wordbookId: string): Promise<ForgettingPreviewRow[]> {
    const rows = await this.query<{
      word_id: string;
      state: string;
      stability: number | string | null;
      retrievability: number | string | null;
      recent_ratings: Json;
      lapse_count: number | string | null;
      morphology: string | null;
      mnemonic: string | null;
      semantic_chain: string | null;
      aliases: string[] | null;
    }>(
      `SELECT uwp.word_id AS word_id,
              uwp.state, uwp.stability, uwp.retrievability,
              uwp.recent_ratings, uwp.lapse_count,
              w.metadata->>'morphology_root' AS morphology,
              COALESCE(w.metadata->>'mnemonic_text', w.metadata->>'mnemonic') AS mnemonic,
              w.metadata->>'semantic_chain' AS semantic_chain,
              w.aliases
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
       ORDER BY uwp.word_id ASC`,
      [userId, wordbookId],
    );
    return rows.map((row) => ({
      wordId: row.word_id,
      state: row.state,
      stability: toNullableNumber(row.stability),
      retrievability: toNullableNumber(row.retrievability),
      recentRatings: Array.isArray(row.recent_ratings) ? (row.recent_ratings as string[]) : [],
      lapseCount: toNullableNumber(row.lapse_count) ?? 0,
      morphology: row.morphology,
      mnemonic: row.mnemonic,
      semanticChain: row.semantic_chain,
      aliases: row.aliases ?? [],
    }));
  }

  /** 与 bulkSuspendByWordbook 完全同条件的可挂起行计数（preview 用，零写入）。 */
  async countBulkSuspendCandidates(input: {
    userId: string;
    wordbookId: string;
    keepWordIds: string[];
  }): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM user_word_progress
       WHERE user_id = $1 AND wordbook_id = $2::uuid
         AND state NOT IN ('suspended', 'new')
         AND word_id <> ALL($3::uuid[])`,
      [input.userId, input.wordbookId, input.keepWordIds],
    );
    return row ? parseInt(row.count, 10) : 0;
  }

  /**
   * 单条 set-based 写：把非锚点、非 suspended/new 的 L1 行置为 suspended，并
   * 逐行写 review_logs（rating=NULL，metadata.action='bulk_forget' + batchId，
   * previous_progress_snapshot={'state': 旧 state}）。
   *
   * 采用「candidates CTE 读旧值 → suspended CTE 更新 → INSERT SELECT 写日志」
   * 的单语句形态：PostgreSQL 保证 WITH 中的数据修改语句必定执行到完成（即使
   * 主查询未读取其输出），因此挂起与写日志原子发生，且日志拿到的是**更新前**的
   * state。返回挂起行数。
   */
  async bulkSuspendByWordbook(input: BulkSuspendByWordbookInput): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `WITH candidates AS (
         SELECT id, user_id, word_id, wordbook_id, state AS previous_state
         FROM user_word_progress
         WHERE user_id = $1 AND wordbook_id = $2::uuid
           AND state NOT IN ('suspended', 'new')
           AND word_id <> ALL($3::uuid[])
       ),
       suspended AS (
         UPDATE user_word_progress uwp
         SET state = 'suspended', updated_at = now()
         FROM candidates c
         WHERE uwp.id = c.id
         RETURNING uwp.id
       )
       INSERT INTO review_logs (
         user_id, word_id, wordbook_id, progress_id, session_id,
         rating, state, metadata, previous_progress_snapshot, reviewed_at, track
       )
       SELECT c.user_id, c.word_id, c.wordbook_id, c.id, NULL,
              NULL, c.previous_state,
              jsonb_build_object('action', 'bulk_forget', 'batchId', $4::text),
              jsonb_build_object('state', c.previous_state),
              now(), 'l1'
       FROM candidates c
       RETURNING id`,
      [input.userId, input.wordbookId, input.keepWordIds, input.batchId],
    );
    return rows.length;
  }

  /** restore 前置校验：该 (user, wordbook, batchId) 是否已有 bulk_forget 日志。 */
  async findBulkForgetBatch(input: BulkForgetBatchInput): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `SELECT id
       FROM review_logs
       WHERE user_id = $1 AND wordbook_id = $2::uuid
         AND metadata->>'action' = 'bulk_forget'
         AND metadata->>'batchId' = $3
       LIMIT 1`,
      [input.userId, input.wordbookId, input.batchId],
    );
    return row !== null;
  }

  /**
   * 只按本批次日志回写 state（previous_progress_snapshot->>'state'），scope 同时
   * 钉死 (user, wordbook) 以防跨书/跨用户误写。不触碰 stability / due_at。
   * 可重复调用（无 gone 标记）：在无中间写入的前提下幂等，重复 restore 会再次写入
   * 同一快照 state 并返回相同行数。
   */
  async restoreBulkForget(input: BulkForgetBatchInput): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_progress uwp
       SET state = rl.previous_progress_snapshot->>'state', updated_at = now()
       FROM review_logs rl
       WHERE rl.user_id = $1 AND rl.wordbook_id = $2::uuid
         AND rl.metadata->>'action' = 'bulk_forget'
         AND rl.metadata->>'batchId' = $3
         AND uwp.id = rl.progress_id
         AND uwp.user_id = $1
         AND uwp.wordbook_id = $2::uuid
       RETURNING uwp.id`,
      [input.userId, input.wordbookId, input.batchId],
    );
    return rows.length;
  }

  async findReviewLogWordbookForUndo(reviewLogId: string, userId: string): Promise<string | null> {
    this.requireTx();
    const row = await this.queryOne<{ wordbook_id: string }>(
      `SELECT wordbook_id
       FROM review_logs
       WHERE id = $1::uuid AND user_id = $2::uuid
       FOR UPDATE`,
      [reviewLogId, userId],
    );
    return row?.wordbook_id ?? null;
  }

  /**
   * Call owner/wordbook-scoped undo_review_log RPC + insert idempotency log. MUST be in a transaction.
   */
  async undoReviewLog(
    reviewLogId: string,
    userId: string,
    wordbookId: string,
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
      `SELECT * FROM undo_review_log($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [reviewLogId, userId, wordbookId, sessionId],
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
        `SELECT wordbook_id, state
         FROM user_word_progress
         WHERE id = $1::uuid AND user_id = $2::uuid AND wordbook_id = $3::uuid`,
        [rpcRow.out_progress_id, userId, wordbookId],
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
          progressRow?.wordbook_id ?? wordbookId,
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

  async getStats(userId: string, wordbookId: string) {
    // 统一口径：以显示时区(Asia/Shanghai)的当日零点为"今天"边界（对齐原项目
    // StatsRepository 的 startOfTodayIsoInDisplayTz），时间字段统一用 reviewed_at。
    //
    // L1 速刷口径（CONTEXT.md「Counter scope」）：本面板是 L1-only 速刷面，故
    // todayTotal / totalCount / 四档 FILTER 都只计**作答事件**（rating IS NOT NULL），
    // skip/suspend/undo（rating=NULL）不再计入"今日复习/累计复习"。
    // **故意**保留 track='l1'：速刷面板只看 L1 轨，L2 慢复习不混入；全轨口径
    // （不限 track）在 stats.repository.ts 的 reviewedToday/7d/30d，那是另一处，勿动。
    const todayStart = startOfTodayIsoInDisplayTz();
    const rows = await this.query<{
      today_count: string;
      total_count: string;
      again_count: string;
      hard_count: string;
      good_count: string;
      easy_count: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE rl.reviewed_at >= $3)::text AS today_count,
        COUNT(*)::text AS total_count,
        COUNT(*) FILTER (WHERE rl.rating = 'again')::text AS again_count,
        COUNT(*) FILTER (WHERE rl.rating = 'hard')::text AS hard_count,
        COUNT(*) FILTER (WHERE rl.rating = 'good')::text AS good_count,
        COUNT(*) FILTER (WHERE rl.rating = 'easy')::text AS easy_count
       FROM review_logs rl
       WHERE rl.user_id = $1 AND rl.wordbook_id = $2 AND rl.track = 'l1'
         AND rl.rating IS NOT NULL`,
      [userId, wordbookId, todayStart],
    );
    const r = rows[0] ?? {};
    // 阶梯会话分组（ADR-0036 LW-2）：metadata.source='typing' 的作答聚合，
    // 供阶梯开关两组对比（档位分布 / 降档率 / 默写错误率）。
    const ladderRows = await this.query<{
      sessions: string;
      dictation: string;
      listen: string;
      copy: string;
      downgraded: string;
      avg_wrong: string | null;
    }>(
      `SELECT
        COUNT(*)::text AS sessions,
        COUNT(*) FILTER (WHERE rl.metadata->>'tier' = 'dictation')::text AS dictation,
        COUNT(*) FILTER (WHERE rl.metadata->>'tier' = 'listen')::text AS listen,
        COUNT(*) FILTER (WHERE rl.metadata->>'tier' = 'copy')::text AS copy,
        COUNT(*) FILTER (WHERE rl.metadata->>'downgraded' = 'true')::text AS downgraded,
        AVG((rl.metadata->>'wrong_times')::numeric)::text AS avg_wrong
       FROM review_logs rl
       WHERE rl.user_id = $1 AND rl.wordbook_id = $2 AND rl.track = 'l1'
         AND rl.rating IS NOT NULL AND rl.metadata->>'source' = 'typing'`,
      [userId, wordbookId],
    );
    const lr = ladderRows[0] ?? {};
    const sessions = parseInt(lr.sessions ?? "0", 10);
    return {
      todayCount: parseInt(r.today_count ?? "0", 10),
      totalCount: parseInt(r.total_count ?? "0", 10),
      ratingDist: {
        again: parseInt(r.again_count ?? "0", 10),
        hard: parseInt(r.hard_count ?? "0", 10),
        good: parseInt(r.good_count ?? "0", 10),
        easy: parseInt(r.easy_count ?? "0", 10),
      },
      ladder: {
        sessions,
        tierDist: {
          dictation: parseInt(lr.dictation ?? "0", 10),
          listen: parseInt(lr.listen ?? "0", 10),
          copy: parseInt(lr.copy ?? "0", 10),
        },
        downgradeRate: sessions > 0 ? Math.round((parseInt(lr.downgraded ?? "0", 10) / sessions) * 1000) / 1000 : null,
        avgWrongTimes: lr.avg_wrong != null ? Math.round(parseFloat(lr.avg_wrong) * 100) / 100 : null,
      },
    };
  }

  async findLeeches(userId: string, wordbookId: string, limit: number) {
    // 统一漏词阈值：与域实体 ReviewCard.isLeech 共用 LEECH_LAPSE_THRESHOLD
    // （项目决策 = 2，遗忘 2 次即标记漏词），消除双标。
    return this.query<
      UserWordProgressRow & { slug: string; title: string; lemma: string; w_id: string; short_definition: string | null }
    >(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.id AS w_id, w.slug, w.title, w.lemma, w.short_definition
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.lapse_count >= $4
       ORDER BY uwp.lapse_count DESC, uwp.due_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit, LEECH_LAPSE_THRESHOLD],
    );
  }

  async getTimeline(userId: string, wordbookId: string, limit: number) {
    // 时间线只展示"评分动作"（again/hard/good/easy）。skip/suspend/undo 写的是
    // rating=NULL 的日志，过滤后避免前端出现无意义的 "null" 徽标；同时让
    // rating 字段与响应契约 z.string() 严格一致。
    return this.query<{
      id: string; rating: string; created_at: string;
      word_slug: string; word_lemma: string;
    }>(
      `SELECT rl.id, rl.rating, rl.reviewed_at AS created_at,
              w.slug AS word_slug, w.lemma AS word_lemma
       FROM review_logs rl
       JOIN words w ON w.id = rl.word_id
       WHERE rl.user_id = $1 AND rl.wordbook_id = $2 AND rl.track = 'l1'
         AND rl.rating IS NOT NULL
       ORDER BY rl.reviewed_at DESC
       LIMIT $3`,
      [userId, wordbookId, limit],
    );
  }

  async getHeatmap(userId: string, wordbookId: string, days: number) {
    // 统一口径：按显示时区(Asia/Shanghai)切日分组（对齐原项目 streak 的
    // Asia/Shanghai 日界），时间字段统一用 reviewed_at。
    // 全轨作答口径（CONTEXT.md「Counter scope」）：热力图计的是**所有轨**的作答次数
    // （L1 + L2），与 dashboard 卡片 reviewedToday/7d/30d 同口径 —— 故只加
    // rating IS NOT NULL，**不过滤 track**（skip/suspend/seed 等非作答事件仍排除）。
    return this.query<{ date: string; count: string }>(
      `SELECT (rl.reviewed_at AT TIME ZONE 'Asia/Shanghai')::date::text AS date,
              COUNT(*)::text AS count
       FROM review_logs rl
       WHERE rl.user_id = $1 AND rl.wordbook_id = $2
         AND rl.rating IS NOT NULL
         AND rl.reviewed_at >= now() - ($3 || ' days')::interval
       GROUP BY (rl.reviewed_at AT TIME ZONE 'Asia/Shanghai')::date
       ORDER BY date`,
      [userId, wordbookId, days],
    );
  }
}
