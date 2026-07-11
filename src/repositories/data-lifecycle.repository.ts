import type { Pool, PoolClient } from "pg";

export const DATA_LIFECYCLE_DEFAULTS = {
  outboxProcessedDays: 14,
  authSessionDays: 7,
  llmTerminalDays: 7,
  llmSettledDays: 395,
  reviewLogDays: 90,
  reviewArchiveDays: 730,
  batchSize: 250,
  maxBatches: 100,
  maxRows: 25_000,
} as const;

export type DataLifecyclePolicy = {
  outboxProcessedDays: number;
  authSessionDays: number;
  llmTerminalDays: number;
  llmSettledDays: number;
  reviewLogDays: number;
  reviewArchiveDays: number;
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
  | "reviewArchive";

type LifecycleLimits = { batchSize: number; maxBatches: number; maxRows: number };

export type DataLifecycleResult = {
  eligible: Record<LifecycleTarget, number>;
  archived: Record<LifecycleTarget, number>;
  deleted: Record<LifecycleTarget, number>;
  cutoff: string;
  durationMs: number;
};

const TARGETS: LifecycleTarget[] = [
  "outboxProcessed", "authSessions", "llmTerminal", "llmSettled", "reviewLogs", "reviewArchive",
];

function counters(): Record<LifecycleTarget, number> {
  return Object.fromEntries(TARGETS.map((target) => [target, 0])) as Record<LifecycleTarget, number>;
}

export function validateDataLifecyclePolicy(input: Partial<DataLifecyclePolicy> = {}): DataLifecyclePolicy {
  const policy = { ...DATA_LIFECYCLE_DEFAULTS, ...input };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  }
  if (policy.batchSize < 100 || policy.batchSize > 500) {
    throw new Error("batchSize must be between 100 and 500");
  }
  if (policy.maxBatches < 1 || policy.maxBatches > 10_000) {
    throw new Error("maxBatches must be between 1 and 10000");
  }
  if (policy.maxRows < 1 || policy.maxRows > 5_000_000) {
    throw new Error("maxRows must be between 1 and 5000000");
  }
  for (const name of [
    "outboxProcessedDays", "authSessionDays", "llmTerminalDays", "llmSettledDays", "reviewLogDays", "reviewArchiveDays",
  ] as const) {
    if (policy[name] < Math.ceil(DATA_LIFECYCLE_DEFAULTS[name] / 2)) {
      throw new Error(`${name} cannot be less than half its default`);
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
    const cutoff = options.cutoff.toISOString();
    const cutoffTime = options.cutoff.getTime();
    const policy = validateDataLifecyclePolicy(options.policy);
    const cutoffs = {
      outboxProcessed: new Date(cutoffTime - policy.outboxProcessedDays * 86_400_000),
      authSessions: new Date(cutoffTime - policy.authSessionDays * 86_400_000),
      llmTerminal: new Date(cutoffTime - policy.llmTerminalDays * 86_400_000),
      llmSettled: new Date(cutoffTime - policy.llmSettledDays * 86_400_000),
      reviewLogs: new Date(cutoffTime - policy.reviewLogDays * 86_400_000),
      reviewArchive: new Date(cutoffTime - policy.reviewArchiveDays * 86_400_000),
    };
    const eligible = await this.countEligible(cutoffs);
    const archived = counters();
    const deleted = counters();

    if (!options.dryRun) {
      if (!options.allowWrite) throw new Error("allowWrite must be true for lifecycle mutations");
      const limits = { batchSize: policy.batchSize, maxBatches: policy.maxBatches, maxRows: policy.maxRows };
      deleted.outboxProcessed = await this.deleteOutboxBatches(cutoffs.outboxProcessed, limits);
      deleted.authSessions = await this.deleteAuthSessionBatches(cutoffs.authSessions, limits);
      deleted.llmTerminal = await this.deleteLlmTerminalBatches(cutoffs.llmTerminal, limits);
      deleted.llmSettled = await this.deleteLlmSettledBatches(cutoffs.llmSettled, limits);
      const review = await this.archiveReviewBatches(cutoffs.reviewLogs, limits);
      archived.reviewLogs = review.archived;
      deleted.reviewLogs = review.deleted;
      deleted.reviewArchive = await this.deleteReviewArchiveBatches(cutoffs.reviewArchive, limits);
    }

    return { eligible, archived, deleted, cutoff, durationMs: Date.now() - startedAt };
  }

  private async countEligible(cutoffs: Record<LifecycleTarget, Date>): Promise<Record<LifecycleTarget, number>> {
    const result = counters();
    const queries: Array<[LifecycleTarget, string]> = [
      ["outboxProcessed", "SELECT count(*)::int AS count FROM outbox_events WHERE status = 'processed' AND processed_at < $1"],
      ["authSessions", "SELECT count(*)::int AS count FROM auth_sessions WHERE expires_at < $1 OR revoked_at < $1"],
      ["llmTerminal", "SELECT count(*)::int AS count FROM llm_usage WHERE status IN ('released', 'expired') AND finalized_at < $1"],
      ["llmSettled", "SELECT count(*)::int AS count FROM llm_usage WHERE status = 'settled' AND created_at < $1"],
      ["reviewLogs", "SELECT count(*)::int AS count FROM review_logs WHERE reviewed_at < $1"],
      ["reviewArchive", "SELECT count(*)::int AS count FROM review_logs_archive WHERE reviewed_at < $1"],
    ];
    const rows = await Promise.all(queries.map(async ([target, text]) => {
      const query = await this.pool.query<{ count: number }>(text, [cutoffs[target]]);
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

  private deleteReviewArchiveBatches(cutoff: Date, limits: LifecycleLimits): Promise<number> {
    return this.executeDeleteBatches(`WITH candidates AS (
      SELECT id FROM review_logs_archive WHERE reviewed_at < $1
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
    ) DELETE FROM review_logs_archive target USING candidates WHERE target.id = candidates.id`, cutoff, limits);
  }

  private async executeDeleteBatches(statement: string, cutoff: Date, limits: LifecycleLimits): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < limits.maxBatches && total < limits.maxRows; batch += 1) {
      const limit = Math.min(limits.batchSize, limits.maxRows - total);
      const result = await this.pool.query(statement, [cutoff, limit]);
      total += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < limit) return total;
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
         FROM candidates ON CONFLICT (id) DO UPDATE SET
           user_id = EXCLUDED.user_id, word_id = EXCLUDED.word_id, progress_id = EXCLUDED.progress_id,
           session_id = EXCLUDED.session_id, rating = EXCLUDED.rating, state = EXCLUDED.state,
           reviewed_at = EXCLUDED.reviewed_at, due_at = EXCLUDED.due_at, elapsed_days = EXCLUDED.elapsed_days,
           scheduled_days = EXCLUDED.scheduled_days, stability = EXCLUDED.stability,
           difficulty = EXCLUDED.difficulty, metadata = EXCLUDED.metadata, created_at = EXCLUDED.created_at,
           wordbook_id = EXCLUDED.wordbook_id, previous_progress_snapshot = EXCLUDED.previous_progress_snapshot,
           undone = EXCLUDED.undone, undone_at = EXCLUDED.undone_at,
           idempotency_key = EXCLUDED.idempotency_key, track = EXCLUDED.track
         RETURNING id
       ), removed AS (
         DELETE FROM review_logs AS logs USING candidates
         WHERE logs.id = candidates.id
           AND EXISTS (SELECT 1 FROM review_logs_archive archive WHERE archive.id = candidates.id)
         RETURNING logs.id
       )
       SELECT (SELECT count(*)::int FROM candidates) AS selected,
              (SELECT count(*)::int FROM inserted) AS archived,
              (SELECT count(*)::int FROM removed) AS deleted`,
      [cutoff, batchSize],
    );
    return result.rows[0] ?? { selected: 0, archived: 0, deleted: 0 };
  }
}
