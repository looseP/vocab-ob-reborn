import { describe, expect, it, vi } from "vitest";
import { LlmReservationReaper } from "@/llm/reservation-reaper";
import type { ILlmUsageRepository } from "@/repositories/interfaces";

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

describe("LlmReservationReaper", () => {
  it("expires one bounded batch", async () => {
    const repo = makeRepo({ expireReservations: vi.fn(async () => 7) });
    const reaper = new LlmReservationReaper(repo, { batchSize: 25 });

    await expect(reaper.processBatch()).resolves.toBe(7);
    expect(repo.expireReservations).toHaveBeenCalledWith(25);
  });

  it("exposes repository metrics", async () => {
    const metrics = { pendingCount: 3, expiredPendingCount: 1, oldestPendingAgeSeconds: 90 };
    const repo = makeRepo({ getReservationMetrics: vi.fn(async () => metrics) });
    const reaper = new LlmReservationReaper(repo);

    await expect(reaper.getMetrics()).resolves.toEqual(metrics);
  });

  it("rejects unsafe batch sizes", () => {
    expect(() => new LlmReservationReaper(makeRepo(), { batchSize: 0 })).toThrow(/batchSize/);
    expect(() => new LlmReservationReaper(makeRepo(), { batchSize: 1_001 })).toThrow(/batchSize/);
  });
});
