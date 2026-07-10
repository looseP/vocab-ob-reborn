/**
 * LlmUsageRepository — persists LLM token usage rows for budget enforcement.
 *
 * Moved here from src/llm/usage-tracker.ts during the Phase 2B architecture
 * cleanup so that src/llm no longer depends on @/db/connection directly.
 * The UsageTracker (src/llm) now consumes this repository via the
 * {@link ILlmUsageRepository} contract — the DB stays behind the repository
 * boundary per ADR-001.
 */

import type { ILlmUsageRepository } from "./interfaces";
import { BaseRepository } from "./base";

export class LlmUsageRepository extends BaseRepository implements ILlmUsageRepository {
  /**
   * Total tokens (prompt + completion) consumed since the start of the
   * current UTC day. Returns 0 when no rows exist.
   *
   * @param dayKey ISO date string (YYYY-MM-DD) in UTC. When omitted, sums
   *   usage for the current UTC day (matching the original CURRENT_DATE
   *   semantics).
   */
  async getDailyUsage(dayKey?: string): Promise<number> {
    const { rows } = await this.executor.query(
      dayKey
        ? `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
           FROM llm_usage WHERE created_at >= $1::date
             AND created_at < ($1::date + interval '1 day')
             AND (status = 'settled' OR (status = 'pending' AND expires_at > now()))`
        : `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
           FROM llm_usage WHERE created_at >= CURRENT_DATE
             AND (status = 'settled' OR (status = 'pending' AND expires_at > now()))`,
      dayKey ? [dayKey] : [],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async reserveDailyTokens(
    dayKey: string,
    tokens: number,
    dailyBudget: number,
    ttlSeconds = 300,
  ): Promise<string | null> {
    const { rows } = await this.executor.query(
      `WITH locked AS (
         SELECT pg_advisory_xact_lock(hashtext('llm_daily_budget:' || $1))
       ), current_usage AS (
         SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS total
         FROM llm_usage, locked
         WHERE created_at >= $1::date
           AND created_at < ($1::date + interval '1 day')
           AND (status = 'settled' OR (status = 'pending' AND expires_at > now()))
       ), inserted AS (
         INSERT INTO llm_usage
           (provider, model, prompt_tokens, completion_tokens, status, expires_at)
         SELECT '__reservation__', $1, $2, 0, 'pending',
                now() + make_interval(secs => $4)
         FROM current_usage
         WHERE total + $2 <= $3
         RETURNING id
       )
       SELECT id FROM inserted`,
      [dayKey, tokens, dailyBudget, ttlSeconds],
    );
    return typeof rows[0]?.id === "string" ? rows[0].id : null;
  }

  async renewDailyTokens(reservationId: string, ttlSeconds: number): Promise<boolean> {
    const { rowCount } = await this.executor.query(
      `UPDATE llm_usage
       SET expires_at = now() + make_interval(secs => $2)
       WHERE id = $1 AND status = 'pending'`,
      [reservationId, ttlSeconds],
    );
    return rowCount === 1;
  }

  async settleDailyTokens(
    reservationId: string,
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    const { rowCount } = await this.executor.query(
      `UPDATE llm_usage
       SET provider = $2, model = $3, prompt_tokens = $4, completion_tokens = $5,
           status = 'settled', expires_at = NULL, finalized_at = now()
       WHERE id = $1 AND status IN ('pending', 'expired')`,
      [reservationId, provider, model, promptTokens, completionTokens],
    );
    if (rowCount !== 1) {
      throw new Error("LLM usage reservation not found");
    }
  }

  async releaseDailyTokens(reservationId: string): Promise<void> {
    await this.executor.query(
      `UPDATE llm_usage
       SET status = 'released', finalized_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [reservationId],
    );
  }

  async expireReservations(limit: number): Promise<number> {
    const { rowCount } = await this.executor.query(
      `WITH candidates AS (
         SELECT id
         FROM llm_usage
         WHERE status = 'pending' AND expires_at <= now()
         ORDER BY expires_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE llm_usage AS usage
       SET status = 'expired', finalized_at = now()
       FROM candidates
       WHERE usage.id = candidates.id`,
      [limit],
    );
    return rowCount ?? 0;
  }

  async getReservationMetrics(): Promise<{
    pendingCount: number;
    expiredPendingCount: number;
    oldestPendingAgeSeconds: number;
  }> {
    const { rows } = await this.executor.query(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         count(*) FILTER (WHERE status = 'pending' AND expires_at <= now())::int AS expired_pending_count,
         COALESCE(EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0)::bigint AS oldest_pending_age_seconds
       FROM llm_usage`,
    );
    return {
      pendingCount: Number(rows[0]?.pending_count ?? 0),
      expiredPendingCount: Number(rows[0]?.expired_pending_count ?? 0),
      oldestPendingAgeSeconds: Number(rows[0]?.oldest_pending_age_seconds ?? 0),
    };
  }

  /** Persist a single LLM call's token usage. */
  async record(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO llm_usage
         (provider, model, prompt_tokens, completion_tokens, status, finalized_at)
       VALUES ($1, $2, $3, $4, 'settled', now())`,
      [provider, model, promptTokens, completionTokens],
    );
  }
}
