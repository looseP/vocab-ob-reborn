import type { Pool, PoolClient } from "pg";

export const DATA_LIFECYCLE_DEFAULTS = {
  outboxProcessedDays: 14,
  authSessionDays: 7,
  llmTerminalDays: 7,
  llmSettledDays: 395,
  reviewLogDays: 90,
  reviewArchiveDays: 730,
  batchSize: 250,
} as const;

export type DataLifecyclePolicy = {
  outboxProcessedDays: number;
  authSessionDays: number;
  llmTerminalDays: number;
  llmSettledDays: number;
  reviewLogDays: number;
  reviewArchiveDays: number;
  batchSize: number;
};

export type LifecycleTarget =
  | "outboxProcessed"
  | "authSessions"
  | "llmTerminal"
  | "llmSettled"
  | "reviewLogs"
  | "reviewArchive";

export type DataLifecycleResult = {
  eligible: Record<LifecycleTarget, number>;
  archived: Record<LifecycleTarget, number>;
  deleted: Record<LifecycleTarget, number>;
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

  async run(options: { dryRun?: boolean; policy?: Partial<DataLifecyclePolicy> } = {}): Promise<DataLifecycleResult> {
    const startedAt = Date.now();
    const policy = validateDataLifecyclePolicy(options.policy);
    const eligible = await this.countEligible(policy);
    const archived = counters();
    const deleted = counters();

    if (!options.dryRun) {
      deleted.outboxProcessed = await this.deleteBatches("outbox_events", "status = 'processed' AND processed_at < now() - ($1::int * interval '1 day')", policy.outboxProcessedDays, policy.batchSize);
      deleted.authSessions = await this.deleteBatches("auth_sessions", "(expires_at < now() - ($1::int * interval '1 day') OR revoked_at < now() - ($1::int * interval '1 day'))", policy.authSessionDays, policy.batchSize);
      deleted.llmTerminal = await this.deleteBatches("llm_usage", "status IN ('released', 'expired') AND finalized_at < now() - ($1::int * interval '1 day')", policy.llmTerminalDays, policy.batchSize);
      deleted.llmSettled = await this.deleteBatches("llm_usage", "status = 'settled' AND created_at < now() - ($1::int * interval '1 day')", policy.llmSettledDays, policy.batchSize);
      const review = await this.archiveReviewBatches(policy.reviewLogDays, policy.batchSize);
      archived.reviewLogs = review.archived;
      deleted.reviewLogs = review.deleted;
      deleted.reviewArchive = await this.deleteBatches("review_logs_archive", "reviewed_at < now() - ($1::int * interval '1 day')", policy.reviewArchiveDays, policy.batchSize);
    }

    return { eligible, archived, deleted, durationMs: Date.now() - startedAt };
  }

  private async countEligible(policy: DataLifecyclePolicy): Promise<Record<LifecycleTarget, number>> {
    const result = counters();
    const queries: Array<[LifecycleTarget, string, number]> = [
      ["outboxProcessed", "SELECT count(*)::int AS count FROM outbox_events WHERE status = 'processed' AND processed_at < now() - ($1::int * interval '1 day')", policy.outboxProcessedDays],
      ["authSessions", "SELECT count(*)::int AS count FROM auth_sessions WHERE expires_at < now() - ($1::int * interval '1 day') OR revoked_at < now() - ($1::int * interval '1 day')", policy.authSessionDays],
      ["llmTerminal", "SELECT count(*)::int AS count FROM llm_usage WHERE status IN ('released', 'expired') AND finalized_at < now() - ($1::int * interval '1 day')", policy.llmTerminalDays],
      ["llmSettled", "SELECT count(*)::int AS count FROM llm_usage WHERE status = 'settled' AND created_at < now() - ($1::int * interval '1 day')", policy.llmSettledDays],
      ["reviewLogs", "SELECT count(*)::int AS count FROM review_logs WHERE reviewed_at < now() - ($1::int * interval '1 day')", policy.reviewLogDays],
      ["reviewArchive", "SELECT count(*)::int AS count FROM review_logs_archive WHERE reviewed_at < now() - ($1::int * interval '1 day')", policy.reviewArchiveDays],
    ];
    const rows = await Promise.all(queries.map(async ([target, text, days]) => {
      const query = await this.pool.query<{ count: number }>(text, [days]);
      return [target, query.rows[0]?.count ?? 0] as const;
    }));
    for (const [target, count] of rows) result[target] = count;
    return result;
  }

  private async deleteBatches(table: string, predicate: string, days: number, batchSize: number): Promise<number> {
    let total = 0;
    while (true) {
      const result = await this.pool.query(
        `WITH candidates AS (
           SELECT id FROM ${table} WHERE ${predicate}
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
         )
         DELETE FROM ${table} AS target USING candidates
         WHERE target.id = candidates.id`,
        [days, batchSize],
      );
      total += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < batchSize) return total;
    }
  }

  private async archiveReviewBatches(days: number, batchSize: number): Promise<{ archived: number; deleted: number }> {
    let archived = 0;
    let deleted = 0;
    while (true) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.archiveReviewBatch(client, days, batchSize);
        await client.query("COMMIT");
        archived += result.archived;
        deleted += result.deleted;
        if (result.selected < batchSize) return { archived, deleted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private async archiveReviewBatch(client: PoolClient, days: number, batchSize: number): Promise<{ selected: number; archived: number; deleted: number }> {
    const result = await client.query<{ selected: number; archived: number; deleted: number }>(
      `WITH candidates AS MATERIALIZED (
         SELECT * FROM review_logs
         WHERE reviewed_at < now() - ($1::int * interval '1 day')
         ORDER BY reviewed_at, id FOR UPDATE SKIP LOCKED LIMIT $2
       ), inserted AS (
         INSERT INTO review_logs_archive
           (id, user_id, word_id, progress_id, rating, state, reviewed_at, due_at, elapsed_days,
            scheduled_days, stability, difficulty, metadata, created_at, wordbook_id)
         SELECT id, user_id, word_id, progress_id, rating, state, reviewed_at, due_at, elapsed_days,
                scheduled_days, stability, difficulty, metadata, created_at, wordbook_id
         FROM candidates ON CONFLICT (id) DO NOTHING RETURNING id
       ), removed AS (
         DELETE FROM review_logs AS logs USING candidates
         WHERE logs.id = candidates.id
           AND EXISTS (SELECT 1 FROM review_logs_archive archive WHERE archive.id = candidates.id)
         RETURNING logs.id
       )
       SELECT (SELECT count(*)::int FROM candidates) AS selected,
              (SELECT count(*)::int FROM inserted) AS archived,
              (SELECT count(*)::int FROM removed) AS deleted`,
      [days, batchSize],
    );
    return result.rows[0] ?? { selected: 0, archived: 0, deleted: 0 };
  }
}
