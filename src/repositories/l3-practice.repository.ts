/**
 * L3PracticeRepository — L3 练习记录持久化（ADR-0019 §1/§3）。
 *
 * 边界（ADR-0004 §6 / ADR-0005）：
 *   - 只写 `l3_practice_attempts`（owner RLS own_all），不碰任何 L1/L2 调度表。
 *   - **零 FSRS**：绝不读写 user_word_progress / user_word_l2_progress / review_logs。
 *   - 错题库是 `attempts(outcome='wrong')` 的**派生查询**（listWrongAttempts），
 *     不建第二真相源、不加表。
 *
 * 两轴过滤（space 子空间 × direction 方向）：
 *   FROM l3_practice_attempts a
 *   JOIN l3_contexts c ON c.id = a.context_id AND c.user_id = a.user_id
 *   LEFT JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
 *   [space]     EXISTS (SELECT 1 FROM l3_source_spaces sp
 *                       WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $n)
 *   [direction] s.direction = $n
 */

import type {
  L3PracticeAttemptPage,
  L3PracticeAttemptRow,
} from "../domain";
import type {
  IL3PracticeRepository,
  L3AttemptLookup,
  NewL3PracticeAttempt,
} from "./interfaces";
import { BaseRepository } from "./base";

export class L3PracticeRepository extends BaseRepository implements IL3PracticeRepository {
  async insertAttempt(input: NewL3PracticeAttempt): Promise<L3PracticeAttemptRow> {
    const row = await this.queryOne<L3PracticeAttemptRow>(
      `INSERT INTO l3_practice_attempts
         (user_id, context_id, occurrence_id, session_id, practice_type, outcome, payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        input.user_id,
        input.context_id,
        input.occurrence_id,
        input.session_id,
        input.practice_type,
        input.outcome,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    if (!row) throw new Error("L3 practice attempt insert returned no row");
    return row;
  }

  /**
   * 幂等身份锁（taskId 维度）：同一 (user, taskId) 的并发 recordAttempt 串行化，
   * 把 SELECT-then-INSERT 的竞态收敛为"命中即返回既有行"。
   * MUST be in a transaction（advisory xact lock 随事务释放）。
   */
  async lockAttemptIdentity(userId: string, taskId: string): Promise<void> {
    this.requireTx();
    await this.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [userId, taskId],
    );
  }

  async findAttemptByTaskId(userId: string, taskId: string): Promise<L3PracticeAttemptRow | null> {
    return this.queryOne<L3PracticeAttemptRow>(
      `SELECT * FROM l3_practice_attempts
       WHERE user_id = $1::uuid AND payload->>'taskId' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, taskId],
    );
  }

  async listAttempts(input: L3AttemptLookup): Promise<L3PracticeAttemptPage> {
    return this.listAttemptsInternal(input, input.outcome ?? null);
  }

  /** 错题库：强制 outcome='wrong'（忽略入参 outcome，错题库口径唯一）。 */
  async listWrongAttempts(input: L3AttemptLookup): Promise<L3PracticeAttemptPage> {
    return this.listAttemptsInternal(input, "wrong");
  }

  private async listAttemptsInternal(
    input: L3AttemptLookup,
    outcome: string | null,
  ): Promise<L3PracticeAttemptPage> {
    const params: unknown[] = [input.userId];
    let where = `WHERE a.user_id = $1::uuid`;
    if (input.practiceType) {
      params.push(input.practiceType);
      where += ` AND a.practice_type = $${params.length}`;
    }
    if (outcome) {
      params.push(outcome);
      where += ` AND a.outcome = $${params.length}`;
    }
    if (input.space) {
      params.push(input.space);
      where += ` AND EXISTS (SELECT 1 FROM l3_source_spaces sp
                              WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`;
    }
    if (input.direction) {
      params.push(input.direction);
      where += ` AND s.direction = $${params.length}`;
    }

    const from = `FROM l3_practice_attempts a
       JOIN l3_contexts c ON c.id = a.context_id AND c.user_id = a.user_id
       LEFT JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id`;

    const rows = await this.query<L3PracticeAttemptRow>(
      `SELECT a.* ${from} ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.limit, input.offset],
    );
    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total ${from} ${where}`,
      params,
    );

    return {
      items: rows,
      total: Number(totalRow?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }
}
