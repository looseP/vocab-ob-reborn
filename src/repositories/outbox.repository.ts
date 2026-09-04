import type {
  EnqueueOutboxEventInput,
  IOutboxRepository,
  OutboxEventRow,
  OutboxMetrics,
  OutboxStatus,
} from "./interfaces";
import { BaseRepository } from "./base";

export class OutboxRepository extends BaseRepository implements IOutboxRepository {
  async enqueue(input: EnqueueOutboxEventInput): Promise<{ id: string; inserted: boolean }> {
    this.requireTx();
    const row = await this.queryOne<{ id: string; inserted: boolean }>(
      `INSERT INTO outbox_events
         (aggregate_type, aggregate_id, event_type, payload, dedupe_key, max_attempts)
       VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6)
       ON CONFLICT (dedupe_key) DO UPDATE
         SET dedupe_key = EXCLUDED.dedupe_key
       RETURNING id, (xmax = 0) AS inserted`,
      [
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        JSON.stringify(input.payload),
        input.dedupeKey,
        input.maxAttempts ?? 8,
      ],
    );
    if (!row) throw new Error("outbox enqueue returned no row");
    return row;
  }

  async recoverExpiredLeases(): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `UPDATE outbox_events
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
           available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE now() END,
           locked_at = NULL,
           locked_until = NULL,
           locked_by = NULL,
           last_error = COALESCE(last_error, 'worker lease expired'),
           updated_at = now()
       WHERE status = 'processing'
         AND locked_until < now()
       RETURNING id`,
    );
    return rows.length;
  }

  async claimBatch(workerId: string, limit: number, leaseSeconds: number): Promise<OutboxEventRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("outbox claim limit must be between 1 and 100");
    }
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
      throw new Error("outbox leaseSeconds must be between 5 and 3600");
    }
    return this.query<OutboxEventRow>(
      `WITH candidates AS (
         SELECT id
         FROM outbox_events
         WHERE status IN ('pending', 'retry')
           AND available_at <= now()
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE outbox_events AS event
       SET status = 'processing',
           attempts = event.attempts + 1,
           locked_at = now(),
           locked_until = now() + ($3::int * interval '1 second'),
           locked_by = $1,
           updated_at = now()
       FROM candidates
       WHERE event.id = candidates.id
       RETURNING event.*`,
      [workerId, limit, leaseSeconds],
    );
  }

  async beginEffect(eventId: string, effectName: string, workerId: string): Promise<boolean> {
    this.requireTx();
    const event = await this.queryOne<{ id: string }>(
      `SELECT id
       FROM outbox_events
       WHERE id = $1::uuid
         AND status = 'processing'
         AND locked_by = $2
         AND locked_until > now()
       FOR UPDATE`,
      [eventId, workerId],
    );
    if (!event) throw new Error(`outbox event ${eventId} is not leased by worker ${workerId}`);

    const receipt = await this.queryOne<{ completed: boolean }>(
      `SELECT true AS completed
       FROM outbox_effect_receipts
       WHERE event_id = $1::uuid AND effect_name = $2`,
      [eventId, effectName],
    );
    return receipt?.completed !== true;
  }

  async completeEffect(eventId: string, effectName: string): Promise<void> {
    this.requireTx();
    await this.query(
      `INSERT INTO outbox_effect_receipts (event_id, effect_name)
       VALUES ($1::uuid, $2)
       ON CONFLICT (event_id, effect_name) DO NOTHING`,
      [eventId, effectName],
    );
  }

  async markProcessed(eventId: string, workerId: string): Promise<void> {
    const row = await this.queryOne<{ id: string }>(
      `UPDATE outbox_events
       SET status = 'processed',
           processed_at = now(),
           locked_at = NULL,
           locked_until = NULL,
           locked_by = NULL,
           last_error = NULL,
           updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND locked_by = $2
       RETURNING id`,
      [eventId, workerId],
    );
    if (!row) throw new Error(`outbox event ${eventId} cannot be marked processed by ${workerId}`);
  }

  async markFailed(
    eventId: string,
    workerId: string,
    errorMessage: string,
    retryDelaySeconds: number,
  ): Promise<OutboxStatus> {
    const row = await this.queryOne<{ status: OutboxStatus }>(
      `UPDATE outbox_events
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
           available_at = CASE
             WHEN attempts >= max_attempts THEN available_at
             ELSE now() + ($4::int * interval '1 second')
           END,
           locked_at = NULL,
           locked_until = NULL,
           locked_by = NULL,
           last_error = left($3, 4000),
           updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND locked_by = $2
       RETURNING status`,
      [eventId, workerId, errorMessage, retryDelaySeconds],
    );
    if (!row) throw new Error(`outbox event ${eventId} cannot be marked failed by ${workerId}`);
    return row.status;
  }

  async replayDeadLetter(eventId: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `UPDATE outbox_events
       SET status = 'pending',
           attempts = 0,
           available_at = now(),
           locked_at = NULL,
           locked_until = NULL,
           locked_by = NULL,
           last_error = NULL,
           processed_at = NULL,
           updated_at = now()
       WHERE id = $1::uuid AND status = 'dead_letter'
       RETURNING id`,
      [eventId],
    );
    return row != null;
  }

  async getMetrics(): Promise<OutboxMetrics> {
    const row = await this.queryOne<{
      pending: number;
      processing: number;
      dead_letter: number;
      oldest_pending_age_seconds: number | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('pending', 'retry'))::int AS pending,
         count(*) FILTER (WHERE status = 'processing')::int AS processing,
         count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
         extract(epoch FROM (now() - min(created_at) FILTER (WHERE status IN ('pending', 'retry'))))::int
           AS oldest_pending_age_seconds
       FROM outbox_events`,
    );
    return {
      pending: row?.pending ?? 0,
      processing: row?.processing ?? 0,
      deadLetter: row?.dead_letter ?? 0,
      oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? null,
    };
  }
}
