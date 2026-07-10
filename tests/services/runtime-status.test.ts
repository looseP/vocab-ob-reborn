import { describe, expect, it, vi } from "vitest";
import { RuntimeStatusService } from "@/services/runtime-status.service";
import type { ILlmUsageRepository, IOutboxRepository } from "@/repositories/interfaces";

function makeService(options: {
  checkDatabase?: () => Promise<{ ok: boolean; totalCount: number; idleCount: number; waitingCount: number }>;
  now?: () => number;
} = {}) {
  const outbox = {
    getMetrics: vi.fn(async () => ({
      pending: 2,
      processing: 1,
      deadLetter: 0,
      oldestPendingAgeSeconds: 12,
    })),
  } as unknown as IOutboxRepository;
  const llmUsage = {
    getReservationMetrics: vi.fn(async () => ({
      pendingCount: 3,
      expiredPendingCount: 1,
      oldestPendingAgeSeconds: 25,
    })),
  } as unknown as ILlmUsageRepository;
  const checkDatabase = options.checkDatabase ?? vi.fn(async () => ({
    ok: true,
    totalCount: 4,
    idleCount: 2,
    waitingCount: 0,
  }));

  return {
    service: new RuntimeStatusService(checkDatabase, outbox, llmUsage, 100, 1_000, options.now ?? (() => 2_000)),
    checkDatabase,
    outbox,
    llmUsage,
  };
}

describe("RuntimeStatusService", () => {
  it("reports ready when the database probe succeeds", async () => {
    const { service } = makeService();
    await expect(service.getReadiness()).resolves.toEqual({
      status: "ready",
      checks: {
        process: { status: "up" },
        database: { status: "up", latencyMs: 0 },
      },
    });
  });

  it("fails closed when the database probe rejects", async () => {
    const { service } = makeService({ checkDatabase: vi.fn(async () => { throw new Error("secret connection failure"); }) });
    const result = await service.getReadiness();
    expect(result.status).toBe("not_ready");
    expect(JSON.stringify(result)).not.toContain("secret connection failure");
  });

  it("returns draining immediately without probing the database", async () => {
    const checkDatabase = vi.fn(async () => ({ ok: true, totalCount: 1, idleCount: 1, waitingCount: 0 }));
    const { service } = makeService({ checkDatabase });
    service.setDraining();
    const result = await service.getReadiness();
    expect(result.checks.process.status).toBe("draining");
    expect(checkDatabase).not.toHaveBeenCalled();
  });

  it("coalesces concurrent readiness checks and caches successful results", async () => {
    let resolveProbe!: (value: { ok: boolean; totalCount: number; idleCount: number; waitingCount: number }) => void;
    const checkDatabase = vi.fn(() => new Promise<{
      ok: boolean;
      totalCount: number;
      idleCount: number;
      waitingCount: number;
    }>((resolve) => { resolveProbe = resolve; }));
    const { service } = makeService({ checkDatabase });
    const first = service.getReadiness();
    const second = service.getReadiness();
    expect(checkDatabase).toHaveBeenCalledTimes(1);
    resolveProbe({ ok: true, totalCount: 1, idleCount: 1, waitingCount: 0 });
    await Promise.all([first, second]);
    await service.getReadiness();
    expect(checkDatabase).toHaveBeenCalledTimes(1);
  });

  it("never returns a successful in-flight probe after draining starts", async () => {
    let resolveProbe!: (value: { ok: boolean; totalCount: number; idleCount: number; waitingCount: number }) => void;
    const checkDatabase = vi.fn(() => new Promise<{
      ok: boolean;
      totalCount: number;
      idleCount: number;
      waitingCount: number;
    }>((resolve) => { resolveProbe = resolve; }));
    const { service } = makeService({ checkDatabase });
    const first = service.getReadiness();
    const second = service.getReadiness();
    service.setDraining();
    resolveProbe({ ok: true, totalCount: 1, idleCount: 1, waitingCount: 0 });
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.status === "not_ready")).toBe(true);
  });

  it("aggregates pool, outbox, and reservation metrics", async () => {
    const { service } = makeService();
    await expect(service.getMetrics()).resolves.toEqual({
      process: { uptimeSeconds: 1, draining: false },
      database: { healthy: true, totalConnections: 4, idleConnections: 2, waitingRequests: 0 },
      outbox: { pending: 2, processing: 1, deadLetter: 0, oldestPendingAgeSeconds: 12 },
      llmReservations: { pending: 3, expiredPending: 1, oldestPendingAgeSeconds: 25 },
    });
  });
});
