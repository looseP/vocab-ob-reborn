/**
 * UsageTracker — LLM token usage tracking & daily budget enforcement.
 *
 * Phase 2B architecture cleanup: this class no longer touches the DB. It
 * depends on an {@link ILlmUsageRepository} (injected via the constructor),
 * so src/llm stays a pure LLM capability layer. The repository + budget
 * are wired up by the service/server composition root (createServices /
 * buildLlmDeps).
 *
 * Budget admission uses a database-backed reservation. The repository takes
 * a day-scoped advisory transaction lock, checks usage, and inserts the
 * reservation atomically, so concurrent processes cannot all pass a separate
 * check-before-call window. The reserved amount is a configurable conservative
 * estimate; actual usage replaces it after the provider returns.
 */

import type { ILlmUsageRepository } from "../repositories/interfaces";

export class UsageTracker {
  /**
   * @param repo      LLM usage persistence (repository boundary — owns the DB).
   * @param dailyBudget Daily token limit (prompt+completion). Reached-or-
   *   exceeded ⇒ isOverBudget() returns true. Defaults to the env-configured
   *   LLM_DAILY_TOKEN_LIMIT (50000) so server.ts can omit it.
   */
  constructor(
    private readonly repo: ILlmUsageRepository,
    private readonly dailyBudget: number = parseInt(
      process.env.LLM_DAILY_TOKEN_LIMIT ?? "50000",
      10,
    ),
    private readonly reservationTokens: number = parseInt(
      process.env.LLM_TOKEN_RESERVATION ?? process.env.LLM_MAX_TOKENS ?? "2048",
      10,
    ),
  ) {}

  /** Total tokens consumed since the start of the current UTC day. */
  async getDailyUsage(): Promise<number> {
    return this.repo.getDailyUsage();
  }

  /** True when today's usage has reached (or exceeded) the daily limit. */
  async isOverBudget(): Promise<boolean> {
    return (await this.getDailyUsage()) >= this.dailyBudget;
  }

  async reserve(): Promise<string | null> {
    const dayKey = new Date().toISOString().slice(0, 10);
    return this.repo.reserveDailyTokens(dayKey, this.reservationTokens, this.dailyBudget);
  }

  async settle(
    reservationId: string,
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    await this.repo.settleDailyTokens(
      reservationId,
      provider,
      model,
      promptTokens,
      completionTokens,
    );
  }

  async release(reservationId: string): Promise<void> {
    await this.repo.releaseDailyTokens(reservationId);
  }

  /**
   * Persist a single LLM call's token usage. Fire-and-forget style —
   * callers may await for strictness or `.catch()` to avoid blocking
   * the main flow on observability failures.
   */
  async record(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    await this.repo.record(provider, model, promptTokens, completionTokens);
  }
}
