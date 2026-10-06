/**
 * HuluRepository — 葫芦冲刺计划容器持久化（ADR-0041）。
 *
 * 边界（ADR-0041 / 完备设计 §四）：
 *   - 只写 `hulu_plans` / `hulu_rounds` 两张新表（owner RLS own_all），
 *     **不改任何已有表**；零 FSRS：不碰 user_word_progress / review_logs /
 *     sessions / l3_sessions。
 *   - 定格取词（`listWordIdsByWordbook`）**只读** `wordbook_items` + `words`，
 *     稳定序（created_at ASC, word_id ASC）——同词书同刻恒同序，计划的
 *     word_ids 因此可复现。
 *   - 「全计划至多一个未收尾轮」由**服务层**在事务内保证（`lockPlanForUpdate`
 *     先锁计划行再判断），本层不建部分唯一索引（完备设计 §4.2）。
 *
 * 事务：多语句方法（insertPlan 的唯一索引兜底读回、setPlanStatus 的读改写）
 * 走 requireTx —— 服务层统一经 withTransaction(..., { actorId }) 调用。
 */

import type { HuluPlanRow, HuluPlanStatus, HuluRoundRow } from "../domain/hulu-sprint";
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
          gate_ratio, word_ids, suspend_review, suspend_snapshot)
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid[], $9, $10::jsonb)
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
      `INSERT INTO hulu_rounds (plan_id, user_id, round_no, started_at, words_total)
       VALUES ($1::uuid, $2::uuid, $3, COALESCE($4::timestamptz, now()), $5)
       RETURNING *`,
      [input.plan_id, input.user_id, input.round_no, input.started_at, input.words_total],
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
   * 定格取词（R6 / 完备设计 §七）：整本词书的已发布未删词，稳定序。
   *
   * `ORDER BY wi.created_at ASC, wi.word_id ASC` —— 同词书同刻恒同序；词的
   * 增删只影响后续读取，已定格计划不受影响（只缩不换）。
   *
   * `userId` 不参与 SQL：`wordbook_items` 的 RLS policy（via_wordbook）已按
   * auth.uid() 限定到 actor 自己的词书，服务层另以 assertWordbookOwned 显式
   * 预检归属（越权访问表现为 404 而非空集）。保留入参以对齐服务层的调用形状。
   */
  async listWordIdsByWordbook(userId: string, wordbookId: string): Promise<string[]> {
    void userId;
    const rows = await this.query<{ word_id: string }>(
      `SELECT wi.word_id
         FROM wordbook_items wi
         JOIN words w ON w.id = wi.word_id
        WHERE wi.wordbook_id = $1::uuid
          AND w.is_published = true
          AND w.is_deleted = false
        ORDER BY wi.created_at ASC, wi.word_id ASC`,
      [wordbookId],
    );
    return rows.map((row) => row.word_id);
  }
}
