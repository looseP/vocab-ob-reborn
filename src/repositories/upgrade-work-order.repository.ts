/**
 * UpgradeWorkOrderRepository — ADR-0018 升级工单（用户主动提前升级）的持久化。
 *
 * 表：upgrade_work_orders（0028）。owner-scoped（RLS own_all），所有方法都必须
 * 在携带 actorId 的事务内执行（createRepositories(tx) + withTransaction）。
 *
 * 状态机：标记中 → 升级中 → 已完成；进行中态可 → 已取消。部分唯一索引
 * idx_upgrade_work_orders_one_active 保证同 (user, word, wordbook) 至多一张
 * 进行中工单——insert 撞索引时抛 23505，由调用方决定是复用既有行还是报错。
 */

import type { Direction, Json, UpgradeWorkOrderRow } from "../domain";
import type { IUpgradeWorkOrderRepository, NewUpgradeWorkOrder } from "./interfaces";
import { BaseRepository } from "./base";

const ACTIVE_STATUSES = ["标记中", "升级中"] as const;

export class UpgradeWorkOrderRepository extends BaseRepository implements IUpgradeWorkOrderRepository {
  async insert(data: NewUpgradeWorkOrder): Promise<UpgradeWorkOrderRow> {
    const row = await this.queryOne<UpgradeWorkOrderRow>(
      `INSERT INTO upgrade_work_orders
         (user_id, word_id, wordbook_id, direction, status, suggestion_snapshot)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        data.user_id,
        data.word_id,
        data.wordbook_id,
        data.direction,
        data.status ?? "标记中",
        data.suggestion_snapshot != null ? JSON.stringify(data.suggestion_snapshot) : null,
      ],
    );
    if (!row) throw new Error("Upgrade work order insert returned no row");
    return row;
  }

  async updateSuggestion(
    userId: string,
    workOrderId: string,
    direction: Direction,
    suggestionSnapshot: Json,
  ): Promise<UpgradeWorkOrderRow | null> {
    return this.queryOne<UpgradeWorkOrderRow>(
      `UPDATE upgrade_work_orders
          SET direction = $3,
              suggestion_snapshot = $4::jsonb,
              updated_at = now()
        WHERE id = $2::uuid AND user_id = $1::uuid
        RETURNING *`,
      [userId, workOrderId, direction, JSON.stringify(suggestionSnapshot)],
    );
  }

  async findActiveByScope(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<UpgradeWorkOrderRow | null> {
    return this.queryOne<UpgradeWorkOrderRow>(
      `SELECT * FROM upgrade_work_orders
        WHERE user_id = $1::uuid
          AND wordbook_id = $2::uuid
          AND word_id = $3::uuid
          AND status = ANY($4::text[])
        ORDER BY created_at DESC, id
        LIMIT 1`,
      [userId, wordbookId, wordId, [...ACTIVE_STATUSES]],
    );
  }

  async findByIdForUser(userId: string, workOrderId: string): Promise<UpgradeWorkOrderRow | null> {
    return this.queryOne<UpgradeWorkOrderRow>(
      `SELECT * FROM upgrade_work_orders
        WHERE id = $2::uuid AND user_id = $1::uuid`,
      [userId, workOrderId],
    );
  }

  async listPending(userId: string, wordbookId: string, limit: number): Promise<UpgradeWorkOrderRow[]> {
    return this.query<UpgradeWorkOrderRow>(
      `SELECT * FROM upgrade_work_orders
        WHERE user_id = $1::uuid
          AND wordbook_id = $2::uuid
          AND status = ANY($3::text[])
        ORDER BY created_at DESC, id
        LIMIT $4`,
      [userId, wordbookId, [...ACTIVE_STATUSES], limit],
    );
  }

  async updateStatus(
    userId: string,
    workOrderId: string,
    status: string,
    options?: { completed?: boolean },
  ): Promise<UpgradeWorkOrderRow | null> {
    return this.queryOne<UpgradeWorkOrderRow>(
      `UPDATE upgrade_work_orders
          SET status = $3,
              completed_at = CASE WHEN $4::boolean THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = $2::uuid AND user_id = $1::uuid
        RETURNING *`,
      [userId, workOrderId, status, options?.completed === true],
    );
  }
}
