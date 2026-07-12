import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  DATA_LIFECYCLE_DEFAULTS,
  DataLifecycleRepository,
  validateDataLifecyclePolicy,
} from "@/repositories/data-lifecycle.repository";

function fakePool(rows: Array<{ count: number }> = [{ count: 0 }]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const connect = vi.fn();
  return { pool: { query, connect } as unknown as Pool, query, connect };
}

function mutationPool(options: { failDelete?: boolean } = {}) {
  const poolQuery = vi.fn(async () => ({ rows: [{ count: 0 }], rowCount: 1 }));
  const clients: Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async () => {
    const release = vi.fn();
    const query = vi.fn(async (text: string) => {
      if (options.failDelete && text.includes("DELETE FROM outbox_events")) throw new Error("delete failed");
      if (text.includes("SELECT (SELECT count(*)::int FROM candidates)")) {
        return { rows: [{ selected: 0, archived: 0, deleted: 0 }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: null };
    });
    const client = { query, release };
    clients.push(client);
    return client;
  });
  return { pool: { query: poolQuery, connect } as unknown as Pool, poolQuery, connect, clients };
}

describe("validateDataLifecyclePolicy", () => {
  it("returns defaults and preserves them around partial overrides", () => {
    expect(validateDataLifecyclePolicy()).toEqual(DATA_LIFECYCLE_DEFAULTS);
    expect(validateDataLifecyclePolicy({ batchSize: 100, reviewLogDays: 180 })).toEqual({
      ...DATA_LIFECYCLE_DEFAULTS,
      batchSize: 100,
      reviewLogDays: 180,
    });
  });

  it.each([
    ["batchSize", 0, "batchSize must be between 1 and 1000"],
    ["batchSize", 1001, "batchSize must be between 1 and 1000"],
    ["maxBatches", 0, "maxBatches must be between 1 and 10000"],
    ["maxRows", 5_000_001, "maxRows must be between 1 and 5000000"],
    ["reviewLogDays", 179, "reviewLogDays cannot be less than 180"],
    ["llmSettledDays", 196, "llmSettledDays cannot be less than 197"],
  ])("rejects unsafe %s=%s", (name, value, message) => {
    expect(() => validateDataLifecyclePolicy({ [name]: value })).toThrow(message);
  });

  it("rejects non-integer policy values", () => {
    expect(() => validateDataLifecyclePolicy({ batchSize: 1.5 })).toThrow("batchSize must be an integer");
  });
});

describe("DataLifecycleRepository.run guards", () => {
  it("rejects invalid and future cutoffs before touching the database", async () => {
    const fake = fakePool();
    const repository = new DataLifecycleRepository(fake.pool);

    await expect(repository.run({ cutoff: new Date("invalid"), dryRun: true })).rejects.toThrow("cutoff must be a valid Date");
    await expect(repository.run({ cutoff: new Date(Date.now() + 60_000), dryRun: true })).rejects.toThrow("cutoff cannot be in the future");
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("rejects a mutation without explicit write authorization before any database access", async () => {
    const fake = fakePool();
    const repository = new DataLifecycleRepository(fake.pool);

    await expect(repository.run({ cutoff: new Date("2026-01-01T00:00:00.000Z") })).rejects.toThrow(
      "allowWrite must be true for lifecycle mutations",
    );
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("rejects an unsafe policy before any database access", async () => {
    const fake = fakePool();
    const repository = new DataLifecycleRepository(fake.pool);

    await expect(repository.run({
      cutoff: new Date("2026-01-01T00:00:00.000Z"),
      dryRun: true,
      policy: { outboxProcessedDays: 13 },
    })).rejects.toThrow("outboxProcessedDays cannot be less than 14");
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe("DataLifecycleRepository.run dry-run", () => {
  it("reports five eligible counts without opening a mutation transaction", async () => {
    const fake = fakePool([{ count: 3 }]);
    const repository = new DataLifecycleRepository(fake.pool);
    const result = await repository.run({ cutoff: new Date("2026-01-01T00:00:00.000Z"), dryRun: true });

    expect(result.eligible).toEqual({
      outboxProcessed: 3,
      authSessions: 3,
      llmTerminal: 3,
      llmSettled: 3,
      reviewLogs: 3,
    });
    expect(result.archived).toEqual({ outboxProcessed: 0, authSessions: 0, llmTerminal: 0, llmSettled: 0, reviewLogs: 0 });
    expect(result.deleted).toEqual({ outboxProcessed: 0, authSessions: 0, llmTerminal: 0, llmSettled: 0, reviewLogs: 0 });
    expect(fake.query).toHaveBeenCalledTimes(5);
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe("DataLifecycleRepository mutation transactions", () => {
  it("commits bounded empty batches with local timeouts and always releases clients", async () => {
    const fake = mutationPool();
    const result = await new DataLifecycleRepository(fake.pool).run({
      cutoff: new Date("2026-01-01T00:00:00.000Z"),
      dryRun: false,
      allowWrite: true,
      policy: { batchSize: 10, maxBatches: 1, maxRows: 10 },
    });

    expect(result.deleted).toEqual({ outboxProcessed: 0, authSessions: 0, llmTerminal: 0, llmSettled: 0, reviewLogs: 0 });
    expect(fake.clients).toHaveLength(5);
    for (const client of fake.clients) {
      const sql = client.query.mock.calls.map(([text]) => text);
      expect(sql[0]).toBe("BEGIN");
      expect(sql).toContain("SET LOCAL lock_timeout = '2s'");
      expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
      expect(sql.at(-1)).toBe("COMMIT");
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it("rolls back, releases, and propagates a delete failure", async () => {
    const fake = mutationPool({ failDelete: true });
    await expect(new DataLifecycleRepository(fake.pool).run({
      cutoff: new Date("2026-01-01T00:00:00.000Z"),
      dryRun: false,
      allowWrite: true,
      policy: { batchSize: 10, maxBatches: 1, maxRows: 10 },
    })).rejects.toThrow("delete failed");

    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0].query).toHaveBeenCalledWith("ROLLBACK");
    expect(fake.clients[0].release).toHaveBeenCalledOnce();
  });
});
