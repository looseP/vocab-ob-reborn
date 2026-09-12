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
 *
 * 错题库加固（T11）：
 *   - 条目附**语境级聚合**（单次 LATERAL，与分页窗口无关）：wrongCount = 该语境
 *     全量 outcome='wrong' 计数；latestOutcome / latestAt = 该语境最近一次作答
 *     （不限 outcome）——修复"前端在 ≤100 条回看窗口内自算、超窗偏低/过期"。
 *   - 分页：cursor 纯新增（(created_at,id) 双列 keyset，复用 l3-cursor 范式），
 *     offset 参数保留；两者同时出现时以 cursor 为准（offset 被忽略）。
 *     两种模式均按 `limit + 1` 超取，据此判定 nextCursor。
 */
import type {
  L3PracticeAttemptPage,
  L3PracticeAttemptRow,
  L3PracticeErrorBookItem,
  L3PracticeErrorBookPage,
  L3PracticeOutcome,
} from "../domain";
import type {
  IL3PracticeRepository,
  L3AttemptLookup,
  NewL3PracticeAttempt,
} from "./interfaces";
import { decodeCursor, encodeCursor } from "./l3-cursor";
import { BaseRepository } from "./base";

/** 错题库行的 SQL 形态：attempt 行 + 聚合列（snake_case，映射时转 camelCase）。 */
interface L3ErrorBookSqlRow extends L3PracticeAttemptRow {
  wrong_count: number;
  latest_outcome: L3PracticeOutcome;
  latest_at: string;
}

/** SQL 行 → 错题库条目（聚合列转 camelCase；不限页窗口，逐行透传）。 */
function mapErrorBookItem(row: L3ErrorBookSqlRow): L3PracticeErrorBookItem {
  return {
    id: row.id,
    user_id: row.user_id,
    context_id: row.context_id,
    occurrence_id: row.occurrence_id,
    session_id: row.session_id,
    practice_type: row.practice_type,
    outcome: row.outcome,
    payload: row.payload,
    created_at: row.created_at,
    wrongCount: Number(row.wrong_count),
    latestOutcome: row.latest_outcome,
    latestAt: row.latest_at,
  };
}

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

  /**
   * 错题库：强制 outcome='wrong'（忽略入参 outcome，错题库口径唯一）。条目附
   * 语境级聚合（wrongCount / latestOutcome / latestAt）；cursor 给出时走
   * keyset 分页（offset 被忽略），否则保留 offset 兼容路径。两种模式都给出
   * nextCursor（null = 已到末页）。
   */
  async listWrongAttempts(input: L3AttemptLookup): Promise<L3PracticeErrorBookPage> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, "wrong"];
    let filterWhere = `WHERE a.user_id = $1::uuid AND a.outcome = $2`;
    if (input.space) {
      params.push(input.space);
      filterWhere += ` AND EXISTS (SELECT 1 FROM l3_source_spaces sp
                              WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`;
    }
    if (input.direction) {
      params.push(input.direction);
      filterWhere += ` AND s.direction = $${params.length}`;
    }

    const from = `FROM l3_practice_attempts a
       JOIN l3_contexts c ON c.id = a.context_id AND c.user_id = a.user_id
       LEFT JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id`;

    // 语境级聚合：单次 LATERAL 扫描该语境**全部** attempts（不受页大小/游标影响）。
    const aggregation = `JOIN LATERAL (
         SELECT count(*) FILTER (WHERE w.outcome = 'wrong')::int AS wrong_count,
                (array_agg(w.outcome ORDER BY w.created_at DESC, w.id DESC))[1] AS latest_outcome,
                (array_agg(w.created_at ORDER BY w.created_at DESC, w.id DESC))[1] AS latest_at
         FROM l3_practice_attempts w
         WHERE w.user_id = a.user_id AND w.context_id = a.context_id
       ) agg ON true`;

    const fetchParams = [...params];
    let fetchWhere = filterWhere;
    if (cursor) {
      fetchParams.push(cursor.createdAt, cursor.id);
      fetchWhere += ` AND (a.created_at, a.id) < ($${fetchParams.length - 1}::timestamptz, $${fetchParams.length}::uuid)`;
    }
    fetchParams.push(input.limit + 1);
    let paging = `LIMIT $${fetchParams.length}`;
    if (!cursor) {
      fetchParams.push(input.offset);
      paging += ` OFFSET $${fetchParams.length}`;
    }

    const rows = await this.query<L3ErrorBookSqlRow>(
      `SELECT a.*, agg.wrong_count, agg.latest_outcome, agg.latest_at ${from} ${aggregation} ${fetchWhere}
       ORDER BY a.created_at DESC, a.id DESC ${paging}`,
      fetchParams,
    );
    // total = 过滤条件下全量 wrong 计数（不含 cursor 谓词；跨窗口口径，与页无关）。
    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total ${from} ${filterWhere}`,
      params,
    );

    const items = rows.slice(0, input.limit).map(mapErrorBookItem);
    const last = items[items.length - 1];
    const hasMore = rows.length > input.limit && last !== undefined;
    return {
      items,
      total: Number(totalRow?.total ?? 0),
      limit: input.limit,
      offset: cursor ? 0 : input.offset,
      nextCursor: hasMore ? encodeCursor(last.created_at, last.id) : null,
    };
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
