import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { OutboxRepository } from "@/repositories/outbox.repository";

type Step = { rows?: unknown[]; error?: Error };
function scriptedExecutor(steps: Step[]) {
  const queue = [...steps];
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    const step = queue.shift();
    if (!step) throw new Error(`Unexpected query: ${text}`);
    if (step.error) throw step.error;
    const rows = step.rows ?? [];
    return { rows, rowCount: rows.length };
  });
  return { client: { query } as unknown as PoolClient, calls, assertExhausted: () => expect(queue).toHaveLength(0) };
}

const eventId = "00000000-0000-4000-8000-000000000101";

describe("OutboxRepository failure and lease policy", () => {
  it.each(["retry", "dead_letter"] as const)("maps database failure policy to %s", async (status) => {
    const script = scriptedExecutor([{ rows: [{ status }] }]);
    const repository = new OutboxRepository(script.client);

    await expect(repository.markFailed(eventId, "worker-1", "db down", 30)).resolves.toBe(status);
    expect(script.calls[0].text).toContain("attempts >= max_attempts THEN 'dead_letter' ELSE 'retry'");
    expect(script.calls[0].text).toContain("left($3, 4000)");
    expect(script.calls[0].params).toEqual([eventId, "worker-1", "db down", 30]);
    script.assertExhausted();
  });

  it("fails closed when a worker does not own the event", async () => {
    const script = scriptedExecutor([{ rows: [] }]);
    await expect(new OutboxRepository(script.client).markFailed(eventId, "wrong-worker", "x", 1))
      .rejects.toThrow(`outbox event ${eventId} cannot be marked failed by wrong-worker`);
  });

  it("recovers expired leases and returns the affected count", async () => {
    const script = scriptedExecutor([{ rows: [{ id: "1" }, { id: "2" }] }]);
    await expect(new OutboxRepository(script.client).recoverExpiredLeases()).resolves.toBe(2);
    expect(script.calls[0].text).toContain("locked_until < now()");
    expect(script.calls[0].text).toContain("worker lease expired");
  });
});

describe("OutboxRepository effect receipts", () => {
  it("rejects an effect without a live worker lease before reading receipts", async () => {
    const script = scriptedExecutor([{ rows: [] }]);
    await expect(new OutboxRepository(script.client).beginEffect(eventId, "cards_seen", "worker-1"))
      .rejects.toThrow(`outbox event ${eventId} is not leased by worker worker-1`);
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0].text).toContain("locked_until > now()");
  });

  it.each([
    [[], true],
    [[{ completed: true }], false],
  ])("returns whether an effect should run for receipt rows %#", async (receiptRows, expected) => {
    const script = scriptedExecutor([{ rows: [{ id: eventId }] }, { rows: receiptRows }]);
    await expect(new OutboxRepository(script.client).beginEffect(eventId, "cards_seen", "worker-1"))
      .resolves.toBe(expected);
    expect(script.calls[1].text).toContain("outbox_effect_receipts");
    expect(script.calls[1].params).toEqual([eventId, "cards_seen"]);
  });

  it("writes an idempotent receipt", async () => {
    const script = scriptedExecutor([{ rows: [] }]);
    await new OutboxRepository(script.client).completeEffect(eventId, "cards_seen");
    expect(script.calls[0].text).toContain("ON CONFLICT (event_id, effect_name) DO NOTHING");
  });
});

describe("OutboxRepository operations", () => {
  it.each([
    [[{ id: eventId }], true],
    [[], false],
  ])("marks processed only while the worker owns the lease %#", async (rows, succeeds) => {
    const script = scriptedExecutor([{ rows }]);
    const operation = new OutboxRepository(script.client).markProcessed(eventId, "worker-1");
    if (succeeds) await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toThrow(`outbox event ${eventId} cannot be marked processed by worker-1`);
    expect(script.calls[0].text).toContain("status = 'processing' AND locked_by = $2");
  });

  it.each([
    [[{ id: eventId }], true],
    [[], false],
  ])("replays only dead-letter events %#", async (rows, expected) => {
    const script = scriptedExecutor([{ rows }]);
    await expect(new OutboxRepository(script.client).replayDeadLetter(eventId)).resolves.toBe(expected);
    expect(script.calls[0].text).toContain("attempts = 0");
    expect(script.calls[0].text).toContain("status = 'dead_letter'");
  });

  it("maps operational metrics to the public shape", async () => {
    const script = scriptedExecutor([{ rows: [{ pending: 7, processing: 2, dead_letter: 3, oldest_pending_age_seconds: 91 }] }]);
    await expect(new OutboxRepository(script.client).getMetrics()).resolves.toEqual({
      pending: 7, processing: 2, deadLetter: 3, oldestPendingAgeSeconds: 91,
    });
  });

  it("returns safe zero metrics when aggregation yields no row", async () => {
    const script = scriptedExecutor([{ rows: [] }]);
    await expect(new OutboxRepository(script.client).getMetrics()).resolves.toEqual({
      pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: null,
    });
  });

  it("rejects invalid claim limits before querying", async () => {
    const script = scriptedExecutor([]);
    const repository = new OutboxRepository(script.client);
    await expect(repository.claimBatch("worker", 0, 60)).rejects.toThrow("claim limit");
    await expect(repository.claimBatch("worker", 10, 4)).rejects.toThrow("leaseSeconds");
    expect(script.calls).toHaveLength(0);
  });
});
