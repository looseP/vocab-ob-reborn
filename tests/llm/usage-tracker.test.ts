import { describe, it, expect, vi } from "vitest";
import type { ILlmUsageRepository } from "@/repositories/interfaces";

// UsageTracker now depends on a repository contract — no DB pool to mock.
function makeRepo(overrides: Partial<ILlmUsageRepository> = {}): ILlmUsageRepository {
  return {
    getDailyUsage: vi.fn(async () => 0),
    reserveDailyTokens: vi.fn(async () => "reservation-1"),
    renewDailyTokens: vi.fn(async () => true),
    settleDailyTokens: vi.fn(async () => {}),
    releaseDailyTokens: vi.fn(async () => {}),
    expireReservations: vi.fn(async () => 0),
    getReservationMetrics: vi.fn(async () => ({
      pendingCount: 0,
      expiredPendingCount: 0,
      oldestPendingAgeSeconds: 0,
    })),
    record: vi.fn(async () => {}),
    ...overrides,
  };
}

import { UsageTracker } from "@/llm/usage-tracker";

describe("UsageTracker", () => {
  it("getDailyUsage delegates to the repository", async () => {
    const repo = makeRepo({ getDailyUsage: vi.fn(async () => 1250) });
    const tracker = new UsageTracker(repo, 50000);
    const total = await tracker.getDailyUsage();
    expect(total).toBe(1250);
    expect(repo.getDailyUsage).toHaveBeenCalledOnce();
  });

  it("isOverBudget returns true when usage reaches the configured limit", async () => {
    const repo = makeRepo({ getDailyUsage: vi.fn(async () => 1000) });
    const tracker = new UsageTracker(repo, 1000);
    const over = await tracker.isOverBudget();
    expect(over).toBe(true);
  });

  it("isOverBudget returns false when usage is below the limit", async () => {
    const repo = makeRepo({ getDailyUsage: vi.fn(async () => 500) });
    const tracker = new UsageTracker(repo, 1000);
    const over = await tracker.isOverBudget();
    expect(over).toBe(false);
  });

  it("reserve atomically delegates the UTC day, estimate, and budget", async () => {
    const repo = makeRepo();
    const tracker = new UsageTracker(repo, 1000, 250, 120);
    await expect(tracker.reserve()).resolves.toBe("reservation-1");
    expect(repo.reserveDailyTokens).toHaveBeenCalledWith(
      new Date().toISOString().slice(0, 10),
      250,
      1000,
      120,
    );
  });

  it("rejects a reservation TTL shorter than twice the provider timeout", () => {
    expect(() => new UsageTracker(makeRepo(), 1000, 250, 30, 20)).toThrow(/twice/);
  });

  it("renew, settle and release delegate reservation lifecycle", async () => {
    const repo = makeRepo();
    const tracker = new UsageTracker(repo, 1000, 250, 120);
    await expect(tracker.renew("reservation-0")).resolves.toBe(true);
    await tracker.settle("reservation-1", "openai", "gpt-4o", 120, 80);
    await tracker.release("reservation-2");
    expect(repo.renewDailyTokens).toHaveBeenCalledWith("reservation-0", 120);
    expect(repo.settleDailyTokens).toHaveBeenCalledWith(
      "reservation-1",
      "openai",
      "gpt-4o",
      120,
      80,
    );
    expect(repo.releaseDailyTokens).toHaveBeenCalledWith("reservation-2");
  });

  it("record delegates to the repository with the given token counts", async () => {
    const repo = makeRepo();
    const tracker = new UsageTracker(repo, 50000);
    await tracker.record("openai", "gpt-4o", 120, 80);
    expect(repo.record).toHaveBeenCalledWith("openai", "gpt-4o", 120, 80);
  });

  it("uses the env-configured budget by default when none is passed", async () => {
    const repo = makeRepo({ getDailyUsage: vi.fn(async () => 60000) });
    // No budget arg → reads LLM_DAILY_TOKEN_LIMIT (default 50000).
    const tracker = new UsageTracker(repo);
    const over = await tracker.isOverBudget();
    expect(over).toBe(true);
  });
});
