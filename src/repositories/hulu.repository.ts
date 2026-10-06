/**
 * HuluRepository — 葫芦冲刺计划容器持久化（ADR-0041）。
 *
 * 边界（ADR-0041 / 完备设计 §四 / 修订轮 R9）：
 *   - 只写 `hulu_plans` / `hulu_rounds` 两张新表（owner RLS own_all），
 *     **不改任何已有表**；零 FSRS **写入**：不写 user_word_progress /
 *     review_logs / sessions / l3_sessions。
 *   - 定格取词（`listReviewDeckWordIds`）**只读** `user_word_progress` —— 这是
 *     本层唯一的 FSRS 可见面接触，且只读（修订轮 D-A「先学后刷」：池源从几乎
 *     为空的 `wordbook_items` 改为复习牌堆）。稳定序（created_at ASC,
 *     word_id ASC）——同词书同刻恒同序，计划的 word_ids 因此可复现。
 *   - 「全计划至多一个未收尾轮」由**服务层**在事务内保证（`lockPlanForUpdate`
 *     先锁计划行再判断），本层不建部分唯一索引（完备设计 §4.2）。
 *
 * 事务：多语句方法（insertPlan 的唯一索引兜底读回、setPlanStatus 的读改写）
 * 走 requireTx —— 服务层统一经 withTransaction(..., { actorId }) 调用。
 */

import type { HuluPageWordRow, HuluPlanRow, HuluPlanStatus, HuluRoundRow } from "../domain/hulu-sprint";
import type { IHuluRepository, NewHuluPlan, NewHuluRound } from "./interfaces";
import { BaseRepository } from "./base";
import { todayKeyInDisplayTz } from "../db/timezone";

/** PostgreSQL unique_violation —— 并发撞 idx_hulu_plans_one_active 的判据。 */
export const UNIQUE_VIOLATION_SQLSTATE = "23505";

/** 该错误是否为 unique_violation（服务层据此重查并返回既有计划）。 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE
  );
}

export class HuluRepository extends BaseRepository implements IHuluRepository {
  /**
   * 插入计划行。并发撞 `idx_hulu_plans_one_active` 时抛 unique_violation
   * （服务层捕获后重查并返回既有计划，实现幂等创建）。
   */
  async insertPlan(input: NewHuluPlan): Promise<HuluPlanRow> {
    const row = await this.queryOne<HuluPlanRow>(
      `INSERT INTO hulu_plans
         (user_id, wordbook_id, direction, exam_date, target_rounds, page_size,
          gate_ratio, word_ids, protocol_version, include_new_words, suspend_review, suspend_snapshot)
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid[], $9, $10, $11, $12::jsonb)
       RETURNING *`,
      [
        input.user_id,
        input.wordbook_id,
        input.direction,
        input.exam_date,
        input.target_rounds,
        input.page_size,
        input.gate_ratio,
        input.word_ids,
        input.protocol_version,
        input.include_new_words,
        input.suspend_review,
        input.suspend_snapshot === null ? null : JSON.stringify(input.suspend_snapshot),
      ],
    );
    if (!row) throw new Error("hulu plan insert returned no row");
    return row;
  }

  async findPlanById(userId: string, planId: string): Promise<HuluPlanRow | null> {
    return this.queryOne<HuluPlanRow>(
      `SELECT * FROM hulu_plans WHERE id = $1::uuid AND user_id = $2::uuid`,
      [planId, userId],
    );
  }

  /** 计划行加锁（SELECT ... FOR UPDATE）：串行化「至多一个未收尾轮」的判断。 */
  async lockPlanForUpdate(userId: string, planId: string): Promise<HuluPlanRow | null> {
    this.requireTx();
    return this.queryOne<HuluPlanRow>(
      `SELECT * FROM hulu_plans WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
      [planId, userId],
    );
  }

  /**
   * 同词书是否已有 active 计划（幂等创建的判据）。部分唯一索引保证至多一行，
   * 仍用 ORDER BY 兜住索引外的历史数据（防御性；不改变语义）。
   */
  async findActivePlanByWordbook(userId: string, wordbookId: string): Promise<HuluPlanRow | null> {
    return this.queryOne<HuluPlanRow>(
      `SELECT * FROM hulu_plans
        WHERE user_id = $1::uuid AND wordbook_id = $2::uuid AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId, wordbookId],
    );
  }

  /**
   * 置计划状态。`ended_at` 由 `ended` 决定写 now() 还是保留原值（照
   * L3SessionRepository.updateStatus 形状）。MUST be in a transaction。
   */
  async setPlanStatus(
    userId: string,
    planId: string,
    status: HuluPlanStatus,
    options: { ended: boolean; suspendSnapshot?: Record<string, string> | null },
  ): Promise<HuluPlanRow | null> {
    this.requireTx();
    const clearSnapshot = options.suspendSnapshot === null;
    return this.queryOne<HuluPlanRow>(
      `UPDATE hulu_plans
          SET status = $3,
              ended_at = CASE WHEN $4::boolean THEN now() ELSE ended_at END,
              suspend_snapshot = CASE WHEN $5::boolean THEN NULL ELSE suspend_snapshot END
        WHERE id = $1::uuid AND user_id = $2::uuid
        RETURNING *`,
      [planId, userId, status, options.ended, clearSnapshot],
    );
  }

  /**
   * 写回挂起快照（创建事务的第二步：插计划行 → 挂起 → 快照落库）。
   *
   * 快照内容来自 `ReviewRepository.bulkSuspendByWordIds` 的回返（逐行「挂起前
   * state」），本层只负责把它落到计划行，不解释语义。MUST be in a transaction。
   */
  async saveSuspendSnapshot(
    userId: string,
    planId: string,
    snapshot: Record<string, string>,
  ): Promise<HuluPlanRow | null> {
    this.requireTx();
    return this.queryOne<HuluPlanRow>(
      `UPDATE hulu_plans
          SET suspend_snapshot = $3::jsonb
        WHERE id = $1::uuid AND user_id = $2::uuid
        RETURNING *`,
      [planId, userId, JSON.stringify(snapshot)],
    );
  }

  async findRoundsByPlan(userId: string, planId: string): Promise<HuluRoundRow[]> {
    return this.query<HuluRoundRow>(
      `SELECT * FROM hulu_rounds
        WHERE plan_id = $1::uuid AND user_id = $2::uuid
        ORDER BY round_no ASC`,
      [planId, userId],
    );
  }

  async insertRound(input: NewHuluRound): Promise<HuluRoundRow> {
    const row = await this.queryOne<HuluRoundRow>(
      `INSERT INTO hulu_rounds (plan_id, user_id, round_no, started_at, words_total, kind)
       VALUES ($1::uuid, $2::uuid, $3, COALESCE($4::timestamptz, now()), $5, $6)
       RETURNING *`,
      [input.plan_id, input.user_id, input.round_no, input.started_at, input.words_total, input.kind],
    );
    if (!row) throw new Error("hulu round insert returned no row");
    return row;
  }

  /** 当前未收尾轮（`ended_at IS NULL`）。至多一行由服务层保证。 */
  async findOpenRound(userId: string, planId: string): Promise<HuluRoundRow | null> {
    return this.queryOne<HuluRoundRow>(
      `SELECT * FROM hulu_rounds
        WHERE plan_id = $1::uuid AND user_id = $2::uuid AND ended_at IS NULL
        ORDER BY round_no DESC
        LIMIT 1`,
      [planId, userId],
    );
  }

  async findRoundByNo(userId: string, planId: string, roundNo: number): Promise<HuluRoundRow | null> {
    return this.queryOne<HuluRoundRow>(
      `SELECT * FROM hulu_rounds
        WHERE plan_id = $1::uuid AND user_id = $2::uuid AND round_no = $3
        LIMIT 1`,
      [planId, userId, roundNo],
    );
  }

  /**
   * 页结算（R7 原文）：**单条条件 UPDATE**，`pages_passed` 即页游标。
   *
   *   rowcount = 1 → 结算成功（返回更新后的行）；
   *   rowcount = 0 → 调用方按游标判据分流（`> pageIndex` 幂等返回现状、`<` 跳页 409、
   *   `=` 而 0 行只能是本轮已收尾）—— 本层不做业务判断。
   *
   * 原子且并发安全，不需要页级明细表：两个并发请求里只有一个能命中
   * `pages_passed = $pageIndex`，另一个的 rowcount 为 0。MUST be in a transaction。
   */
  async settlePage(input: {
    userId: string;
    roundId: string;
    pageIndex: number;
    passed: number;
  }): Promise<HuluRoundRow | null> {
    this.requireTx();
    return this.queryOne<HuluRoundRow>(
      `UPDATE hulu_rounds
          SET pages_passed = pages_passed + 1, words_passed = words_passed + $4
        WHERE id = $1::uuid AND user_id = $2::uuid AND ended_at IS NULL AND pages_passed = $3
        RETURNING *`,
      [input.roundId, input.userId, input.pageIndex, input.passed],
    );
  }

  /**
   * 轮次收尾：条件 UPDATE（`ended_at IS NULL`）—— 并发双收尾只有一个写生效，
   * 另一个 rowcount 为 0，服务层据此幂等返回现状。MUST be in a transaction。
   */
  async finishRound(input: {
    userId: string;
    roundId: string;
    endedAt: string;
    elapsedSeconds: number;
    wordSetFingerprint: string | null;
  }): Promise<HuluRoundRow | null> {
    this.requireTx();
    return this.queryOne<HuluRoundRow>(
      `UPDATE hulu_rounds
          SET ended_at = $3::timestamptz, elapsed_seconds = $4, word_set_fingerprint = $5
        WHERE id = $1::uuid AND user_id = $2::uuid AND ended_at IS NULL
        RETURNING *`,
      [input.roundId, input.userId, input.endedAt, input.elapsedSeconds, input.wordSetFingerprint],
    );
  }

  /**
   * 词书归属显式检查（照 insertNewCard 的先例，review.repository.ts:298-311）：
   * 返回该词书 id 当且仅当属于该 user；否则 null（服务层抛 NotFound）。
   */
  async assertWordbookOwned(userId: string, wordbookId: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `SELECT id FROM wordbooks WHERE id = $1::uuid AND user_id = $2::uuid`,
      [wordbookId, userId],
    );
    return row !== null;
  }

  /**
   * 显示时区的今天（YYYY-MM-DD）。风险校验的 `left = exam_date - today` 以此为基准。
   *
   * 放在仓库层是分层纪律的结果：`db/timezone` 只允许 repositories 及以下依赖
   * （.dependency-cruiser.cjs 的 services-no-raw-db-access），服务层不直接读时钟。
   * 纯函数、零 IO —— 名字带 find 前缀只是为了让它在接口里与其它读方法同族。
   */
  findTodayKeyInDisplayTz(): string {
    return todayKeyInDisplayTz();
  }

  /**
   * 定格取词（R9 / 修订轮 D-A「先学后刷」；R12 加可选「含未学词」）：
   * 该词书**复习牌堆**里已评分过的词，稳定序 `created_at ASC, word_id ASC`
   * （加入复习的顺序，贴近"从头到尾过一遍"）。
   *
   * 池源为什么不是 `wordbook_items`：真实库里它几乎为空、且 app 没有写入口
   * （真机验收坐实「复习牌堆 492 到期卡 vs 定格 1 词」的错位）。改为读
   * `user_word_progress` 后，定格词集 = 用户实际在学的词。
   *
   * 入池条件（两档，`opts.includeNew` 决定是否放行 `new`）：
   *   - `includeNew` 缺省/false（R9 先学后刷，默认档）：排除 `new` —— 没见过的词
   *     不逼"回忆"；
   *   - `includeNew` true（R12 曝光轮档）：四态全收 —— 没学过的词先过一遍曝光
   *     再进复习轮；
   *   - 两档都排除 `suspended`：用户主动放下的，冲刺不替他捡回来。
   *
   * 稳定序**两档一致**（同一 SQL 只换 state 白名单）：同词书同刻恒同序，计划的
   * `word_ids` 因此可复现。
   *
   * **只读**：这是本层唯一的 FSRS 可见面接触，仅 SELECT、零写入。RLS policy
   * （progress_own_all）按 auth.uid() 限定到 actor 自己的行，SQL 另显式带
   * user_id 谓词；服务层已以 assertWordbookOwned 预检归属。
   *
   * MUST be in a transaction：owner-RLS 表在无 actor claim 的连接上会静默返回
   * 空集（把「有词可冲刺」误判成「没有词」），requireTx 让误用当场炸而不是
   * 变成一个难查的空池。
   */
  async listReviewDeckWordIds(
    userId: string,
    wordbookId: string,
    opts: { includeNew?: boolean } = {},
  ): Promise<string[]> {
    this.requireTx();
    const states = opts.includeNew
      ? ["new", "learning", "review", "relearning"]
      : ["learning", "review", "relearning"];
    const rows = await this.query<{ word_id: string }>(
      `SELECT word_id FROM user_word_progress
        WHERE user_id = $1::uuid AND wordbook_id = $2::uuid
          AND state = ANY($3::text[])
        ORDER BY created_at ASC, word_id ASC`,
      [userId, wordbookId, states],
    );
    return rows.map((row) => row.word_id);
  }

  /**
   * 页载荷取词（R10 / 修订轮 D-B 卡面精致化）：按 id 批量取**卡面全字段**。
   *
   * 与 `ReviewRepository.findWordsByIds`（preview 队列在用，**不动**）的分工：
   * 那个是队列取词的最小集，这个是**页载荷唯一取数方式**——卡面五层（Tier0 短释 /
   * 义项 / 助记锚 / 例句 / Tier2 语义链）要的全部字段一次带下，单卡路径因此零请求。
   *
   * 返回序由 DB 决定：服务层按**切片序**重排（定格序才是「只缩不换」的语义所在）。
   * 只读 `words` 一张表（公开读策略 words_public_read），零副作用。
   */
  async findHuluPageWords(wordIds: string[]): Promise<HuluPageWordRow[]> {
    if (wordIds.length === 0) return [];
    const rows = await this.query<HuluPageWordRow>(
      `SELECT id, slug, title, lemma, ipa, pos, cefr, short_definition,
              core_definitions, definition_md, examples, prototype_text,
              COALESCE(metadata->>'mnemonic_text', metadata->>'mnemonic') AS mnemonic_text,
              metadata->>'mnemonic_type' AS mnemonic_type,
              metadata->>'semantic_chain' AS semantic_chain
         FROM words
        WHERE id = ANY($1::uuid[]) AND is_published = true AND is_deleted = false`,
      [wordIds],
    );
    return rows.map((row) => ({
      ...row,
      core_definitions: Array.isArray(row.core_definitions) ? row.core_definitions : [],
      examples: Array.isArray(row.examples) ? row.examples : [],
    }));
  }
}
