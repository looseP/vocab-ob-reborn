/**
 * L3SessionRepository — L3 会话持久化（ADR-0019 §2："慢学习容器"）。
 *
 * 边界（ADR-0004 §6 / ADR-0005）：
 *   - 只写 `l3_sessions`（owner RLS own_all），零 FSRS：不碰 user_word_* / review_logs。
 *   - `plan` 只存实体 id 引用 + version（**不存文本/HTML 冻结产物**）——每次打开现拉现渲染。
 *   - `sampleContextIds` 用 `ORDER BY md5(c.id::text || seed)` 排序：**同 seed 恒同结果**，
 *     所以把 seed 存进 plan 后，getSession re-render 的抽样恒可复现。
 */

import type {
  L3SessionContextSummary,
  L3SessionRow,
  L3SessionStatus,
} from "../domain";
import type {
  IL3SessionRepository,
  L3SessionContextLookup,
  NewL3Session,
} from "./interfaces";
import { BaseRepository } from "./base";

export class L3SessionRepository extends BaseRepository implements IL3SessionRepository {
  async insertSession(input: NewL3Session): Promise<L3SessionRow> {
    const row = await this.queryOne<L3SessionRow>(
      `INSERT INTO l3_sessions (user_id, type, title, plan, version)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [input.user_id, input.type, input.title, JSON.stringify(input.plan), input.version],
    );
    if (!row) throw new Error("L3 session insert returned no row");
    return row;
  }

  async findSessionByIdForUser(userId: string, sessionId: string): Promise<L3SessionRow | null> {
    return this.queryOne<L3SessionRow>(
      `SELECT * FROM l3_sessions WHERE id = $1::uuid AND user_id = $2::uuid`,
      [sessionId, userId],
    );
  }

  async updateStatus(
    userId: string,
    sessionId: string,
    status: L3SessionStatus,
    options: { ended: boolean },
  ): Promise<L3SessionRow | null> {
    return this.queryOne<L3SessionRow>(
      `UPDATE l3_sessions
       SET status = $3,
           ended_at = CASE WHEN $4::boolean THEN now() ELSE ended_at END
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [sessionId, userId, status, options.ended],
    );
  }

  async sampleContextIds(input: L3SessionContextLookup): Promise<string[]> {
    const params: unknown[] = [input.userId];
    let where = `WHERE c.user_id = $1::uuid`;
    if (input.space) {
      params.push(input.space);
      where += ` AND EXISTS (SELECT 1 FROM l3_source_spaces sp
                              WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`;
    }
    if (input.direction) {
      params.push(input.direction);
      where += ` AND s.direction = $${params.length}`;
    }
    params.push(input.seed);
    const seedParam = params.length;
    params.push(input.limit);
    const limitParam = params.length;

    const rows = await this.query<{ id: string }>(
      `SELECT c.id
         FROM l3_contexts c
         JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
         ${where}
        ORDER BY md5(c.id::text || $${seedParam})
        LIMIT $${limitParam}`,
      params,
    );
    return rows.map((row) => row.id);
  }

  async findContextsByIds(userId: string, contextIds: string[]): Promise<L3SessionContextSummary[]> {
    if (contextIds.length === 0) return [];
    return this.query<L3SessionContextSummary>(
      `SELECT c.id, c.text, c.context_type, c.source_id, s.title AS source_title
         FROM l3_contexts c
         JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
        WHERE c.user_id = $1::uuid AND c.id = ANY($2::uuid[])`,
      [userId, contextIds],
    );
  }
}
