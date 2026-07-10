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
             AND created_at < ($1::date + interval '1 day')`
        : `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
           FROM llm_usage WHERE created_at >= CURRENT_DATE`,
      dayKey ? [dayKey] : [],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async reserveDailyTokens(
    dayKey: string,
    tokens: number,
    dailyBudget: number,
  ): Promise<string | null> {
    const { rows } = await this.executor.query(
      `WITH locked AS (
         SELECT pg_advisory_xact_lock(hashtext('llm_daily_budget:' || $1))
       ), current_usage AS (
         SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS total
         FROM llm_usage, locked
         WHERE created_at >= $1::date
           AND created_at < ($1::date + interval '1 day')
       ), inserted AS (
         INSERT INTO llm_usage (provider, model, prompt_tokens, completion_tokens)
         SELECT '__reservation__', $1, $2, 0
         FROM current_usage
         WHERE total + $2 <= $3
         RETURNING id
       )
       SELECT id FROM inserted`,
      [dayKey, tokens, dailyBudget],
    );
    return typeof rows[0]?.id === "string" ? rows[0].id : null;
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
       SET provider = $2, model = $3, prompt_tokens = $4, completion_tokens = $5
       WHERE id = $1 AND provider = '__reservation__'`,
      [reservationId, provider, model, promptTokens, completionTokens],
    );
    if (rowCount !== 1) {
      throw new Error("LLM usage reservation not found");
    }
  }

  async releaseDailyTokens(reservationId: string): Promise<void> {
    await this.executor.query(
      `DELETE FROM llm_usage WHERE id = $1 AND provider = '__reservation__'`,
      [reservationId],
    );
  }

  /** Persist a single LLM call's token usage. */
  async record(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    await this.executor.query(
      `INSERT INTO llm_usage (provider, model, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4)`,
      [provider, model, promptTokens, completionTokens],
    );
  }
}
