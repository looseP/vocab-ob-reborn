import type { Pool, PoolClient } from "pg";

export const DATA_LIFECYCLE_POLICY_VERSION = "2026-07-11";

export const DATA_LIFECYCLE_DEFAULTS = {
  outboxProcessedDays: 30,
  authSessionDays: 30,
  llmTerminalDays: 30,
  llmSettledDays: 400,
  reviewLogDays: 365,
  batchSize: 250,
  maxBatches: 100,
  maxRows: 25_000,
} as const;

const DATA_LIFECYCLE_MINIMUMS = {
  outboxProcessedDays: 14,
  authSessionDays: 7,
  llmTerminalDays: 7,
  llmSettledDays: 197,
  reviewLogDays: 180,
} as const;

export type DataLifecyclePolicy = {
  outboxProcessedDays: number;
  authSessionDays: number;
  llmTerminalDays: number;
  llmSettledDays: number;
  reviewLogDays: number;
  batchSize: number;
  maxBatches: number;
  maxRows: number;
};

export type LifecycleTarget =
  | "outboxProcessed"
  | "authSessions"
  | "llmTerminal"
  | "llmSettled"
  | "reviewLogs"
  | "drillOrphanSteps";

type LifecycleLimits = { batchSize: number; maxBatches: number; maxRows: number };

export type DataLifecycleResult = {
  policyVersion: string;
  eligible: Record<LifecycleTarget, number>;
  archived: Record<LifecycleTarget, number>;
  deleted: Record<LifecycleTarget, number>;
  cutoff: string;
  durationMs: number;
};

const TARGETS: LifecycleTarget[] = [
  "outboxProcessed", "authSessions", "llmTerminal", "llmSettled", "reviewLogs", "drillOrphanSteps",
];

function counters(): Record<LifecycleTarget, number> {
  return Object.fromEntries(TARGETS.map((target) => [target, 0])) as Record<LifecycleTarget, number>;
}

export function validateDataLifecyclePolicy(input: Partial<DataLifecyclePolicy> = {}): DataLifecyclePolicy {
  const policy = { ...DATA_LIFECYCLE_DEFAULTS, ...input };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  }
  if (policy.batchSize < 1 || policy.batchSize > 1000) {
    throw new Error("batchSize must be between 1 and 1000");
  }
  if (policy.maxBatches < 1 || policy.maxBatches > 10_000) {
    throw new Error("maxBatches must be between 1 and 10000");
  }
  if (policy.maxRows < 1 || policy.maxRows > 5_000_000) {
    throw new Error("maxRows must be between 1 and 5000000");
  }
  for (const name of Object.keys(DATA_LIFECYCLE_MINIMUMS) as Array<keyof typeof DATA_LIFECYCLE_MINIMUMS>) {
    if (policy[name] < DATA_LIFECYCLE_MINIMUMS[name]) {
      throw new Error(`${name} cannot be less than ${DATA_LIFECYCLE_MINIMUMS[name]}`);
    }
  }
  return policy;
}

export class DataLifecycleRepository {
  constructor(private readonly pool: Pool) {}

  async run(options: { cutoff: Date; dryRun?: boolean; allowWrite?: boolean; policy?: Partial<DataLifecyclePolicy> }): Promise<DataLifecycleResult> {
    const startedAt = Date.now();
    if (!(options.cutoff instanceof Date) || !Number.isFinite(options.cutoff.getTime())) {
      throw new Error("cutoff must be a valid Date");
    }
    if (options.cutoff.getTime() > startedAt) {
      throw new Error("cutoff cannot be in the future");
    }
    const cutoff = options.cutoff.toISOString();
    const cutoffTime = options.cutoff.getTime();
    const policy = validateDataLifecyclePolicy(options.policy);
    if (!options.dryRun && !options.allowWrite) {
      throw new Error("allowWrite must be true for lifecycle mutations");
    }
    const cutoffs = {
      outboxProcessed: new Date(cutoffTime - policy.outboxProcessedDays * 86_400_000),
      authSessions: new Date(cutoffTime - policy.authSessionDays * 86_400_000),
      llmTerminal: new Date(cutoffTime - policy.llmTerminalDays * 86_400_000),
      llmSettled: new Date(cutoffTime - policy.llmSettledDays * 86_400_000),
      reviewLogs: new Date(cutoffTime - policy.reviewLogDays * 86_400_000),
      // 孤儿步不依赖时间 cutoff，此处仅满足类型契约。
      drillOrphanSteps: new Date(cutoffTime),
    };
    const eligible = await this.countEligible(cutoffs);
    const archived = counters();
    const deleted = counters();

    if (!options.dryRun) {
      const limits = { batchSize: policy.batchSize, maxBatches: policy.maxBatches, maxRows: policy.maxRows };
      deleted.outboxProcessed = await this.deleteOutboxBatches(cutoffs.outboxProcessed, limits);
      deleted.authSessions = await this.deleteAuthSessionBatches(cutoffs.authSessions, limits);
      deleted.llmTerminal = await this.deleteLlmTerminalBatches(cutoffs.llmTerminal, limits);
      deleted.llmSettled = await this.deleteLlmSettledBatches(cutoffs.llmSettled, limits);
      const review = await this.archiveReviewBatches(cutoffs.reviewLogs, limits);
      archived.reviewLogs = review.archived;
      deleted.reviewLogs = review.deleted;
      // L2 drill 孤儿 pending 步：删除所属会话已结束（ended_at IS NOT NULL）且仍
      // pending 的步。会话结束即无读取路径（getQueue 只恢复活跃会话的 pending
      // 产出步），纯孤儿；不依赖时间 cutoff（与会话结束状态强相关）。
      deleted.drillOrphanSteps = await this.deleteDrillOrphanBatches(limits);
    }

    return { policyVersion: DATA_LIFECYCLE_POLICY_VERSION, eligible, archived, deleted, cutoff, durationMs: Date.now() - startedAt };
  }

  private async countEligible(cutoffs: Record<LifecycleTarget, Date>): Promise<Record<LifecycleTarget, number>> {
    const result = counters();
    const queries: Array<[LifecycleTarget, string, unknown[]]> = [
      ["outboxProcessed", "SELECT count(*)::int AS count FROM outbox_events WHERE status = 'processed' AND processed_at < $1", [cutoffs.outboxProcessed]],
      ["authSessions", "SELECT count(*)::int AS count FROM auth_sessions WHERE expires_at < $1 OR revoked_at < $1", [cutoffs.authSessions]],
      ["llmTerminal", "SELECT count(*)::int AS count FROM llm_usage WHERE status IN ('released', 'expired') AND finalized_at < $1", [cutoffs.llmTerminal]],
      ["llmSettled", "SELECT count(*)::int AS count FROM llm_usage WHERE status = 'settled' AND created_at < $1", [cutoffs.llmSettled]],
      ["reviewLogs", "SELECT count(*)::int AS count FROM review_logs WHERE reviewed_at < $1", [cutoffs.reviewLogs]],
      // 孤儿步判定与会话结束状态强相关，不依赖时间 cutoff → 无参。
      ["drillOrphanSteps", `SELECT count(*)::int AS count
        FROM l2_drill_session_steps s
        JOIN sessions ssn ON ssn.id = s.session_id
        WHERE s.status = 'pending' AND ssn.ended_at IS NOT NULL`, []],
    ];
    const rows = await Promise.all(queries.map(async ([target, text, params]) => {
      const query = await this.pool.query<{ count: number }>(text, params);
      return [target, query.rows[0]?.count ?? 0] as const;
    }));
    for (const [target, count] of rows) result[target] = count;
    return result;
  }

  private deleteOutboxBatches(cutoff: Date, limits: LifecycleLimits): Promise<number> {
    return this.executeDeleteBatches(`WITH candidates AS (
      SELECT id FROM outbox_events WHERE status = 'processed' AND processed_at < $1
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
    ) DELETE FROM outbox_events target USING candidates WHERE target.id = candidates.id`, cutoff, limits);
  }

  private deleteAuthSessionBatches(cutoff: Date, limits: LifecycleLimits): Promise<number> {
    return this.executeDeleteBatches(`WITH candidates AS (
      SELECT id FROM auth_sessions WHERE expires_at < $1 OR revoked_at < $1
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
    ) DELETE FROM auth_sessions target USING candidates WHERE target.id = candidates.id`, cutoff, limits);
  }

  private deleteLlmTerminalBatches(cutoff: Date, limits: LifecycleLimits): Promise<number> {
    return this.executeDeleteBatches(`WITH candidates AS (
      SELECT id FROM llm_usage WHERE status IN ('released', 'expired') AND finalized_at < $1
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
    ) DELETE FROM llm_usage target USING candidates WHERE target.id = candidates.id`, cutoff, limits);
  }

  private deleteLlmSettledBatches(cutoff: Date, limits: LifecycleLimits): Promise<number> {
    return this.executeDeleteBatches(`WITH candidates AS (
      SELECT id FROM llm_usage WHERE status = 'settled' AND created_at < $1
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
    ) DELETE FROM llm_usage target USING candidates WHERE target.id = candidates.id`, cutoff, limits);
  }

  private async executeDeleteBatches(statement: string, cutoff: Date, limits: LifecycleLimits): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < limits.maxBatches && total < limits.maxRows; batch += 1) {
      const limit = Math.min(limits.batchSize, limits.maxRows - total);
      const client = await this.pool.connect();
      let rowCount = 0;
      try {
        await client.query("BEGIN");
        await this.setBatchTimeouts(client);
        const result = await client.query(statement, [cutoff, limit]);
        rowCount = result.rowCount ?? 0;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      total += rowCount;
      if (rowCount < limit) return total;
    }
    return total;
  }

  /**
   * 删除 L2 drill 孤儿 pending 步：所属会话已结束（ended_at IS NOT NULL）且步仍
   * pending。会话结束即无读取路径（getQueue 的 M8 恢复只覆盖活跃会话的 pending
   * 产出步），纯孤儿，可安全删除。无时间 cutoff 依赖，批内 FOR UPDATE SKIP LOCKED
   * 避免与并发作业互相阻塞。
   */
  private async deleteDrillOrphanBatches(limits: LifecycleLimits): Promise<number> {
    let total = 0;
    const statement = `WITH candidates AS (
      SELECT s.id
      FROM l2_drill_session_steps s
      JOIN sessions ssn ON ssn.id = s.session_id
      WHERE s.status = 'pending' AND ssn.ended_at IS NOT NULL
      ORDER BY s.id FOR UPDATE SKIP LOCKED LIMIT $1
    ) DELETE FROM l2_drill_session_steps target USING candidates WHERE target.id = candidates.id`;
    for (let batch = 0; batch < limits.maxBatches && total < limits.maxRows; batch += 1) {
      const limit = Math.min(limits.batchSize, limits.maxRows - total);
      const client = await this.pool.connect();
      let rowCount = 0;
      try {
        await client.query("BEGIN");
        await this.setBatchTimeouts(client);
        const result = await client.query(statement, [limit]);
        rowCount = result.rowCount ?? 0;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      total += rowCount;
      if (rowCount < limit) return total;
    }
    return total;
  }

  private async archiveReviewBatches(cutoff: Date, limits: { batchSize: number; maxBatches: number; maxRows: number }): Promise<{ archived: number; deleted: number }> {
    let archived = 0;
    let deleted = 0;
    for (let batch = 0; batch < limits.maxBatches && deleted < limits.maxRows; batch += 1) {
      const client = await this.pool.connect();
      const limit = Math.min(limits.batchSize, limits.maxRows - deleted);
      try {
        await client.query("BEGIN");
        await this.setBatchTimeouts(client);
        const result = await this.archiveReviewBatch(client, cutoff, limit);
        await client.query("COMMIT");
        archived += result.archived;
        deleted += result.deleted;
        if (result.selected < limit) return { archived, deleted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return { archived, deleted };
  }

  private async setBatchTimeouts(client: PoolClient): Promise<void> {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
  }

  private async archiveReviewBatch(client: PoolClient, cutoff: Date, batchSize: number): Promise<{ selected: number; archived: number; deleted: number }> {
    const result = await client.query<{ selected: number; archived: number; deleted: number }>(
      `WITH candidates AS MATERIALIZED (
         SELECT * FROM review_logs
         WHERE reviewed_at < $1
         ORDER BY reviewed_at, id FOR UPDATE SKIP LOCKED LIMIT $2
       ), inserted AS (
         INSERT INTO review_logs_archive
           (id, user_id, word_id, progress_id, session_id, rating, state, reviewed_at, due_at, elapsed_days,
            scheduled_days, stability, difficulty, metadata, created_at, wordbook_id,
            previous_progress_snapshot, undone, undone_at, idempotency_key, track)
         SELECT id, user_id, word_id, progress_id, session_id, rating, state, reviewed_at, due_at, elapsed_days,
                scheduled_days, stability, difficulty, metadata, created_at, wordbook_id,
                previous_progress_snapshot, undone, undone_at, idempotency_key, track
         FROM candidates ON CONFLICT (id) DO NOTHING
         RETURNING id
       ), validated AS (
         SELECT candidates.id
         FROM candidates
         JOIN inserted USING (id)
         UNION
         SELECT candidates.id
         FROM candidates
         JOIN review_logs_archive AS archive USING (id)
         WHERE ROW(candidates.user_id, candidates.word_id, candidates.progress_id, candidates.session_id,
                   candidates.rating::text, candidates.state, candidates.reviewed_at, candidates.due_at,
                   candidates.elapsed_days, candidates.scheduled_days, candidates.stability, candidates.difficulty,
                   candidates.metadata, candidates.created_at, candidates.wordbook_id,
                   candidates.previous_progress_snapshot, candidates.undone, candidates.undone_at,
                   candidates.idempotency_key, candidates.track)
           IS NOT DISTINCT FROM
               ROW(archive.user_id, archive.word_id, archive.progress_id, archive.session_id,
                   archive.rating, archive.state, archive.reviewed_at, archive.due_at,
                   archive.elapsed_days, archive.scheduled_days, archive.stability, archive.difficulty,
                   archive.metadata, archive.created_at, archive.wordbook_id,
                   archive.previous_progress_snapshot, archive.undone, archive.undone_at,
                   archive.idempotency_key, archive.track)
       ), removed AS (
         DELETE FROM review_logs AS logs USING validated
         WHERE logs.id = validated.id
         RETURNING logs.id
       )
       SELECT (SELECT count(*)::int FROM candidates) AS selected,
              (SELECT count(*)::int FROM validated) AS archived,
              (SELECT count(*)::int FROM removed) AS deleted`,
      [cutoff, batchSize],
    );
    return result.rows[0] ?? { selected: 0, archived: 0, deleted: 0 };
  }
}
