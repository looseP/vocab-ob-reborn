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
  ReviewQueueChannel,
  ReviewRating,
  ReviewState,
  UserWordProgressRow,
} from "../domain";
import type {
  BulkForgetBatchInput,
  BulkSuspendByWordIdsInput,
  BulkSuspendByWordbookInput,
  ExpireCardsByWordIdsInput,
  ForgettingPreviewRow,
  IReviewRepository,
  InsertNewCardInput,
  InsertNewCardStatus,
  ProgressForAction,
  ProgressWithContentHash,
  QueueListBucket,
  QueueListRow,
  RemoveCardsByWordIdsInput,
  RestoreSuspendSnapshotInput,
  SaveAnswerInput,
  SuspendedWordSnapshot,
  UndoRpcResult,
} from "./interfaces";
import { BaseRepository } from "./base";
import { ValidationError } from "../errors";
import { startOfTodayIsoInDisplayTz } from "../db/timezone";
import { deriveContentStaleness } from "../domain/content-staleness";
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

/**
 * 桶 → SQL 谓词的白名单。**用户输入永不进入 SQL**：分桶只决定挑哪个常量，
 * 未知桶值在到达仓储前已被 zod 拒绝（schema 用 z.enum）。与 interfaces.ts 的
 * QueueListBucket 一一对应。
 */
const QUEUE_BUCKET_PREDICATE: Record<Exclude<QueueListBucket, "all">, string> = {
  suspended: `uwp.state = 'suspended'`,
  new: `uwp.state = 'new'`,
  learning: `uwp.state IN ('learning', 'relearning')`,
  due: `uwp.state = 'review' AND (uwp.due_at IS NULL OR uwp.due_at <= now())`,
  review: `uwp.state = 'review' AND uwp.due_at > now()`,
};

/** listQueueCards 的 SQL 行形态（snake_case + count 窗口列）。 */
type QueueListQueryRow = {
  w_id: string;
  slug: string;
  title: string;
  lemma: string;
  short_definition: string | null;
  pos: string | null;
  cefr: string | null;
  state: ReviewState;
  due_at: string | null;
  review_count: number;
  lapse_count: number;
  stability: number | null;
  interval_days: number | null;
  last_reviewed_at: string | null;
  last_rating: ReviewRating | null;
  needs_recheck: boolean | null;
  content_hash_snapshot: string | null;
  l1_content_hash_snapshot: string | null;
  content_hash: string;
  l1_content_hash: string | null;
};

/**
 * 通道 → SQL 谓词白名单（2026-10-10 新学/复习隔离）。
 *
 * 与 `QUEUE_BUCKET_PREDICATE` 同一纪律：**用户输入永不进入 SQL**，通道只决定挑哪个
 * 常量，两侧枚举（services/review-queue.ts 的 ReviewQueueChannel 与此表）一一对应。
 *
 * `review` 通道刻意**不含** `due_at IS NULL`：state='review' 的卡 due_at 必非空
 * （到期才转出 new），写成 `due_at <= now()` 与原查询同义。
 * `new` 通道只认 `state='new'`（needs_recheck 的行不在此过滤——它们是「内容已变
 * 需重看」的已作答卡，属于复习通道，由 review 通道的 needs_recheck 提权处理）。
 */
const CHANNEL_PREDICATE: Record<"review" | "new", string> = {
  review: `uwp.state IN ('learning', 'relearning', 'review')
           AND (uwp.state <> 'review' OR uwp.due_at IS NULL OR uwp.due_at <= now())`,
  new: `uwp.state = 'new'`,
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
   *
   * **排序必须是 `due_at ASC NULLS LAST`（2026-10-07 修）**：新卡的 `due_at` 是
   * `NULL`，而本查询靠 `LIMIT` 截候选池 —— 若按 `NULLS FIRST` 排，几百张新卡会先把
   * 池子占满，**到期卡一张都进不来**，于是 review/zen 队列只发新卡、到期复习永远
   * 排不上（实测：某书 478 张新卡 + 14 张到期 ⇒ 池内 0 张到期，接口 `total=8` 全是
   * 新卡、`deferredNewCards=192`）。配额机制（`review-queue.ts` 的
   * `MAX_NEW_CARDS_PER_BATCH` / `MAX_NEW_CARD_SHARE`）本就是为「避免新卡挤占到期
   * 复习」而设 —— 这一行的 `NULLS LAST` 是它生效的前提。
   */
  async findDueCandidates(
    userId: string,
    wordbookId: string,
    limit: number,
    channel: ReviewQueueChannel | null = null,
  ): Promise<Array<{ progress: UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }>> {
    const predicate = channel === null ? null : CHANNEL_PREDICATE[channel];
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
        ${predicate ? `AND (${predicate})` : ""}
        ${predicate ? "" : "AND (uwp.due_at IS NULL OR uwp.due_at <= now())"}
      -- 到期卡优先（NULLS LAST）：新卡 due_at 为 NULL，NULLS FIRST 会让它们占满
      -- 200 个候选名额、到期卡一张进不来 ⇒ 队列只发新卡。见本方法 JSDoc。
      -- 通道隔离后此排序仍保留：review 通道内按到期时间先后出卡，语义不变。
      ORDER BY uwp.due_at ASC NULLS LAST, uwp.last_reviewed_at ASC NULLS FIRST
      LIMIT $3`,
      [userId, wordbookId, limit],
    );

    return this.mapReviewCardRows<
      UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }
    >(rows);
  }

  /**
   * 阶段一（轻量候选快照）—— 两阶段队列取数。
   *
   * 只取 user_word_progress 的窄列 + words 的两个 content hash（供 ADR-0021
   * needs_recheck 读时派生），**不 join words 大字段**（examples / metadata /
   * prototype_text …）。排序键与 findDueCandidates 完全一致（到期优先、
   * NULLS LAST），所以两阶段得到的出卡顺序与旧实现逐张相同 —— 只是把
   * "排序/配额"与"取 word 详情"拆开，池宽因而可以从 200 扩到数千而不爆内存。
   *
   * @param limit 快照行数上限；由 service 按会话 offset 计算（自动扩窗）。
   * @param channel 复习通道（2026-10-10 隔离）；`null` = 不下推通道条件（保持旧行为，
   *   即混流池 + 依赖 due_at IS NULL 分支放进新卡），供练习模式与旧调用方使用。
   */
  async findDueCandidateSnapshots(
    userId: string,
    wordbookId: string,
    limit: number,
    channel: "review" | "new" | null = null,
  ): Promise<Array<UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }>> {
    const predicate = channel === null ? null : CHANNEL_PREDICATE[channel];
    return this.query<UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }>(
      `SELECT ${PROGRESS_COLUMNS_PREFIXED},
              w.content_hash, w.l1_content_hash
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         AND uwp.state != 'suspended'
         ${predicate ? `AND (${predicate})` : ""}
         ${predicate ? "" : "AND (uwp.due_at IS NULL OR uwp.due_at <= now())"}
       ORDER BY uwp.due_at ASC NULLS LAST, uwp.last_reviewed_at ASC NULLS FIRST
       LIMIT $3`,
      [userId, wordbookId, limit],
    );
  }

  /**
   * 阶段二（按 word_id 水合）—— 只为当前批的 ≤20 张卡补 word 详情。
   *
   * 用 ANY($3::uuid[]) 单次批量取回；调用方按 word.id 建 Map 回填。
   * 顺序不保证（由调用方按批次顺序回填），故不重复排序。
   */
  async loadReviewCardsByWordIds(
    userId: string,
    wordbookId: string,
    wordIds: string[],
  ): Promise<Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }>> {
    if (wordIds.length === 0) return [];
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
         AND uwp.word_id = ANY($3::uuid[])
       LIMIT $4`,
      [userId, wordbookId, wordIds, wordIds.length],
    );
    return this.mapReviewCardRows(rows);
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
              w.content_hash, w.l1_content_hash,
              w.slug AS word_slug, w.title AS word_title, w.lemma AS word_lemma
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
    // Dual-track: also refresh l1_content_hash_snapshot — 但必须填 **L1 hash**
    // （$18），不能复用 $11 的全量 hash：`deriveContentStaleness` 拿
    // words.l1_content_hash 与这一列配对（L1 专属对），装全量 hash 就是跨空间
    // 比对、恒不相等 ⇒ 每张学过的词都被误报"重新核对"。
    // 调用方（review.service）传 words.l1_content_hash，缺 L1 时回退全量。
    // and append the latest rating to recent_ratings (capped at 5).
    //
    // recent_ratings SQL breakdown:
    //   recent_ratings || to_jsonb($16::text)  — append a separately typed rating value
    //   jsonb_array_elements(...) WITH ORDINALITY  — explode to (elem, ord) pairs
    //   ORDER BY ord DESC LIMIT 5  — take 5 most recent
    //   jsonb_agg(elem ORDER BY ord ASC)  — re-aggregate in chronological order
    // Result: [oldest_kept, ..., newest] (max 5 elements)
    //
    // 参数化：$1..$17 的既有映射不动，L1 hash 追加为末位 $18。
    await this.query(
      `UPDATE user_word_progress
       SET difficulty = $1, due_at = $2, interval_days = $3,
           lapse_count = lapse_count + $4,
           last_rating = $5, last_reviewed_at = $6,
           retrievability = $7, review_count = review_count + 1,
           scheduler_payload = $8, stability = $9, state = $10,
           ${counterField} = ${counterField} + 1,
           content_hash_snapshot = $11,
           l1_content_hash_snapshot = $18,
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
        input.l1ContentHash, // $18: L1 专属 hash → l1_content_hash_snapshot（调用方缺 L1 时回退全量）
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
   * 队列总览计数（队列全景页，2026-10-10）：按**互斥**优先级分桶。
   *
   * 桶定义（互斥且完备，覆盖 user_word_progress.state 的全部取值）：
   *  1. suspended —— state='suspended'（ADR-0020 遗忘挂起）
   *  2. new       —— state='new'（从未作答）
   *  3. learning  —— state IN ('learning','relearning')（短期卡，必然已到期）
   *  4. due       —— state='review' 且 (due_at IS NULL OR due_at <= now())
   *  5. review    —— state='review' 且 due_at > now()（成熟、未到期）
   *
   * `dueNow` 单列：非挂起、非新卡、已到期（= learning + due）—— 即「现在就该复习
   * 的张数」。与仪表盘 due_count 的日历日口径不同，勿混用。
   */
  async countQueueBuckets(
    userId: string,
    wordbookId: string,
  ): Promise<{
    due: number;
    learning: number;
    review: number;
    new: number;
    suspended: number;
    dueNow: number;
    total: number;
  }> {
    const row = await this.queryOne<Record<string, string>>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE uwp.state = 'suspended')::text AS suspended,
         COUNT(*) FILTER (WHERE uwp.state = 'new')::text AS new_count,
         COUNT(*) FILTER (WHERE uwp.state IN ('learning', 'relearning'))::text AS learning,
         COUNT(*) FILTER (WHERE uwp.state = 'review'
                            AND (uwp.due_at IS NULL OR uwp.due_at <= now()))::text AS due,
         COUNT(*) FILTER (WHERE uwp.state = 'review' AND uwp.due_at > now())::text AS review,
         COUNT(*) FILTER (WHERE uwp.state NOT IN ('suspended', 'new')
                            AND (uwp.due_at IS NULL OR uwp.due_at <= now()))::text AS due_now
       FROM user_word_progress uwp
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid`,
      [userId, wordbookId],
    );
    const count = (key: string): number => {
      const raw = row?.[key];
      const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      due: count("due"),
      learning: count("learning"),
      review: count("review"),
      new: count("new_count"),
      suspended: count("suspended"),
      dueNow: count("due_now"),
      total: count("total"),
    };
  }

  /**
   * 队列清单（队列全景页）：按桶 / 搜索词分页列出卡。
   *
   * - 桶条件来自**模块级常量白名单**（QUEUE_BUCKET_PREDICATE），绝不拼接用户输入。
   * - 排序末尾追加 `w.lemma ASC`：due_at / review_count 大量并列，缺稳定 tiebreak 时
   *   翻页会重复或漏行（同一批卡在两页里各出现一次）。
   * - `count(*) OVER()` 顺带取回过滤后总数，避免再跑一次 COUNT。
   */
  async listQueueCards(input: {
    userId: string;
    wordbookId: string;
    bucket: QueueListBucket;
    search: string | null;
    limit: number;
    offset: number;
  }): Promise<{ items: QueueListRow[]; total: number }> {
    const predicate = input.bucket === "all" ? null : QUEUE_BUCKET_PREDICATE[input.bucket];
    const rows = await this.query<(QueueListQueryRow & { total_count: string })>(
      `SELECT uwp.state, uwp.due_at, uwp.review_count, uwp.lapse_count,
              uwp.stability, uwp.interval_days, uwp.last_reviewed_at,
              uwp.needs_recheck, uwp.last_rating,
              uwp.content_hash_snapshot, uwp.l1_content_hash_snapshot,
              w.id AS w_id, w.slug, w.title, w.lemma, w.short_definition,
              w.pos, w.cefr, w.content_hash, w.l1_content_hash,
              COUNT(*) OVER()::text AS total_count
       FROM user_word_progress uwp
       JOIN words w ON w.id = uwp.word_id
       WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
         ${predicate ? `AND (${predicate})` : ""}
         AND ($3::text IS NULL
              OR w.lemma ILIKE '%' || $3 || '%' ESCAPE '\'
              OR w.title ILIKE '%' || $3 || '%' ESCAPE '\')
       ORDER BY
         (CASE WHEN uwp.state = 'suspended' THEN 1 ELSE 0 END) ASC,
         (CASE WHEN uwp.due_at IS NULL OR uwp.due_at <= now() THEN 0 ELSE 1 END) ASC,
         uwp.due_at ASC NULLS LAST,
         uwp.review_count ASC,
         w.lemma ASC
       LIMIT $4 OFFSET $5`,
      [input.userId, input.wordbookId, input.search, input.limit, input.offset],
    );
    const total = rows.length > 0 ? Number.parseInt(rows[0].total_count, 10) : 0;
    return {
      items: rows.map((row) => ({
        wordId: row.w_id,
        slug: row.slug,
        title: row.title,
        lemma: row.lemma,
        shortDefinition: row.short_definition,
        pos: row.pos,
        cefr: row.cefr,
        state: row.state,
        dueAt: row.due_at,
        reviewCount: row.review_count,
        lapseCount: row.lapse_count,
        stability: toNullableNumber(row.stability),
        intervalDays: toNullableNumber(row.interval_days),
        lastReviewedAt: row.last_reviewed_at,
        lastRating: row.last_rating,
        // 与队列候选同一口径：行上人工标记 || 内容陈旧度派生（ADR-0021）
        needsRecheck: Boolean(row.needs_recheck) || deriveContentStaleness({
          contentHash: row.content_hash,
          l1ContentHash: row.l1_content_hash,
          contentHashSnapshot: row.content_hash_snapshot,
          l1ContentHashSnapshot: row.l1_content_hash_snapshot,
        }),
      })),
      total: Number.isFinite(total) ? total : 0,
    };
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
   * 葫芦冲刺批量挂起（ADR-0041 决策 5 / 完备设计 §六，第 9 个 state 写点）。
   *
   * 单条 set-based 语句：从候选子查询读**挂起前** state，主 UPDATE 挂起，经
   * `RETURNING s.word_id, s.old_state` 回返快照 —— 结果直接写入计划行的
   * `suspend_snapshot`，因此**不需要 review_logs**（这正是「葫芦的快照在计划行、
   * 一键遗忘的快照在日志」的分野）。
   *
   * 范围含 `new`（与 bulkSuspendByWordbook 排除 new 的语义**不同**：有快照即安全，
   * 且目标是整批退出到期队列）；`state <> 'suspended'` 使重复挂起零行变化。
   * scope 钉死 (user, wordbook) 防跨书误写。MUST be in a transaction。
   */
  async bulkSuspendByWordIds(input: BulkSuspendByWordIdsInput): Promise<SuspendedWordSnapshot[]> {
    this.requireTx();
    if (input.wordIds.length === 0) return [];
    const rows = await this.query<{ word_id: string; old_state: string }>(
      `UPDATE user_word_progress u
       SET state = 'suspended', updated_at = now()
       FROM (
         SELECT id, word_id, state AS old_state
         FROM user_word_progress
         WHERE user_id = $1 AND wordbook_id = $2::uuid
           AND word_id = ANY($3::uuid[])
           AND state <> 'suspended'
       ) s
       WHERE u.id = s.id
       RETURNING s.word_id, s.old_state`,
      [input.userId, input.wordbookId, input.wordIds],
    );
    return rows.map((row) => ({ wordId: row.word_id, oldState: row.old_state }));
  }

  /**
   * 队列编辑（P1）：移出复习队列 —— 物理删除进度行 + 逐词写卡片移除审计。
   *
   * 两段式（同事务）：DELETE ... RETURNING 拿到被删行（id 与旧 state）→
   * INSERT review_logs（rating=NULL、metadata.action='card_removed'）。
   * review_logs.progress_id **无外键约束**（实测 6 个 FK 均不涉此列），审计可
   * 安全引用已删行。不排除 suspended —— 挂起词同样可被用户主动移出。
   * scope 钉死 (user, wordbook) 防跨书误删；未命中 id 幂等零行。MUST be in a transaction。
   */
  async removeCardsByWordIds(input: RemoveCardsByWordIdsInput): Promise<string[]> {
    this.requireTx();
    if (input.wordIds.length === 0) return [];
    const removed = await this.query<{ id: string; word_id: string; previous_state: string }>(
      `DELETE FROM user_word_progress
       WHERE user_id = $1 AND wordbook_id = $2::uuid
         AND word_id = ANY($3::uuid[])
       RETURNING id, word_id, state AS previous_state`,
      [input.userId, input.wordbookId, input.wordIds],
    );
    if (removed.length > 0) {
      await this.query(
        `INSERT INTO review_logs (
           user_id, word_id, wordbook_id, progress_id, session_id,
           rating, state, metadata, previous_progress_snapshot, reviewed_at, track
         )
         SELECT $1, r.word_id, $2::uuid, r.id, NULL,
                NULL, r.previous_state,
                jsonb_build_object('action', 'card_removed'),
                jsonb_build_object('state', r.previous_state),
                now(), 'l1'
         FROM jsonb_to_recordset($3::jsonb) AS r(id uuid, word_id uuid, previous_state text)`,
        [
          input.userId,
          input.wordbookId,
          JSON.stringify(
            removed.map((row) => ({ id: row.id, word_id: row.word_id, previous_state: row.previous_state })),
          ),
        ],
      );
    }
    return removed.map((row) => row.word_id);
  }

  /**
   * 队列编辑（P1）：提前到期 —— 把指定词的 due_at 提到现在（只提前、从不延后）。
   *
   * `LEAST(COALESCE(due_at, now()), now())`：未来到期与 NULL（新卡）→ now()；
   * 已到期（含积压）的词由过滤条件排除、零写入（提前复习不应改动本来就在队列
   * 里的卡）。挂起词不改。候选池（findDueCandidates）排序 due_at ASC NULLS LAST
   * 使这批词先于其他新卡、并与到期卡同池。MUST be in a transaction。
   */
  async expireCardsByWordIds(input: ExpireCardsByWordIdsInput): Promise<string[]> {
    this.requireTx();
    if (input.wordIds.length === 0) return [];
    const rows = await this.query<{ word_id: string }>(
      `UPDATE user_word_progress
       SET due_at = LEAST(COALESCE(due_at, now()), now()), updated_at = now()
       WHERE user_id = $1 AND wordbook_id = $2::uuid
         AND word_id = ANY($3::uuid[])
         AND state <> 'suspended'
         AND (due_at IS NULL OR due_at > now())
       RETURNING word_id`,
      [input.userId, input.wordbookId, input.wordIds],
    );
    return rows.map((row) => row.word_id);
  }

  /**
   * 葫芦冲刺挂起恢复（ADR-0041 决策 5，第 10 个 state 写点）：快照回写。
   *
   * `jsonb_to_recordset` 展开 `{wordId: 挂起前 state}`，逐行回写**快照内的
   * state**，且仅当该行当前仍为 `suspended`（用户手动恢复过的词不动）。
   * **禁止**统一恢复成 `'review'` —— 那会让 new/learning/relearning 的行伪装成
   * review 态，改变 review 队列行为（完备设计 R1 的最重修正）。
   * **不写 review_logs**。scope 钉死 (user, wordbook)。MUST be in a transaction。
   */
  async restoreSuspendSnapshot(input: RestoreSuspendSnapshotInput): Promise<number> {
    this.requireTx();
    const entries = Object.entries(input.snapshot);
    if (entries.length === 0) return 0;
    const snapshotJson = JSON.stringify(
      entries.map(([wordId, state]) => ({ word_id: wordId, old_state: state })),
    );
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_progress u
       SET state = s.old_state, updated_at = now()
       FROM jsonb_to_recordset($3::jsonb) AS s(word_id uuid, old_state text)
       WHERE u.user_id = $1 AND u.wordbook_id = $2::uuid
         AND u.word_id = s.word_id
         AND u.state = 'suspended'
       RETURNING u.id`,
      [input.userId, input.wordbookId, snapshotJson],
    );
    return rows.length;
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
       -- 二级排序 rl.id（批次 1，2026-10-09）：同一时刻的多条（批量作答/导入）
       -- 此前顺序由物理序决定，每次查询可能漂移；补确定性 tiebreaker。
       ORDER BY rl.reviewed_at DESC, rl.id DESC
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
