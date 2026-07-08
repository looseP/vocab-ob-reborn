/**
 * UsageTracker — LLM token usage tracking & daily budget enforcement.
 *
 * Phase 2B architecture cleanup: this class no longer touches the DB. It
 * depends on an {@link ILlmUsageRepository} (injected via the constructor),
 * so src/llm stays a pure LLM capability layer. The repository + budget
 * are wired up by the service/server composition root (createServices /
 * buildLlmDeps).
 *
 * Behavior preserved from the pre-refactor version:
 *  - getDailyUsage() sums prompt+completion tokens for the current UTC day.
 *  - isOverBudget() is true when today's usage has reached/exceeded the
 *    configured daily limit.
 *  - record() persists a single LLM call's usage (best-effort: callers may
 *    await or .catch() to avoid blocking the draft flow on observability
 *    failures).
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
  ) {}

  /** Total tokens consumed since the start of the current UTC day. */
  async getDailyUsage(): Promise<number> {
    return this.repo.getDailyUsage();
  }

  /** True when today's usage has reached (or exceeded) the daily limit. */
  async isOverBudget(): Promise<boolean> {
    return (await this.getDailyUsage()) >= this.dailyBudget;
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
