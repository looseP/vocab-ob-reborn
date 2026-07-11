import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client, Pool } from "pg";
import { createApp } from "../src/http/server";
import { Telemetry } from "../src/observability/telemetry";
import { OutboxRepository } from "../src/repositories/outbox.repository";
import type { Services } from "../src/services";

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

interface CapacityEvidence {
  api: { requests: number; concurrency: number; requestsPerSecond: number; failures: number };
  sqlPlans: Record<string, { indexes: string[]; nodeTypes: string[] }>;
  outbox: { events: number; workers: number; eventsPerSecond: number; duplicates: number };
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; capacity tests must never use DATABASE_URL implicitly");
const capacityDatabase = new URL(databaseUrl);
const capacityDatabaseName = decodeURIComponent(capacityDatabase.pathname.replace(/^\//, ""));
if (!/(?:_test|_drill|_capacity|vocab)$/i.test(capacityDatabaseName) || process.env.CAPACITY_TEST_CONFIRM !== capacityDatabaseName) {
  throw new Error(`Set CAPACITY_TEST_CONFIRM=${capacityDatabaseName} to confirm the isolated capacity database`);
}
process.env.DATABASE_URL = databaseUrl;

function collectPlan(node: PlanNode, indexes = new Set<string>(), nodeTypes = new Set<string>()): { indexes: string[]; nodeTypes: string[] } {
  nodeTypes.add(node["Node Type"]);
  if (node["Index Name"]) indexes.add(node["Index Name"]);
  for (const child of node.Plans ?? []) collectPlan(child, indexes, nodeTypes);
  return { indexes: [...indexes].sort(), nodeTypes: [...nodeTypes].sort() };
}

async function explain(client: Client, name: string, query: string, expectedIndex: string): Promise<[string, { indexes: string[]; nodeTypes: string[] }]> {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON, COSTS OFF) ${query}`);
  const root = result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  if (!root) throw new Error(`${name}: EXPLAIN returned no plan`);
  const evidence = collectPlan(root);
  if (!evidence.indexes.includes(expectedIndex)) {
    throw new Error(`${name}: expected ${expectedIndex}, got indexes [${evidence.indexes.join(", ")}] and nodes [${evidence.nodeTypes.join(", ")}]`);
  }
  return [name, evidence];
}

function mockServices(): Services {
  return {
    runtimeStatus: {
      getReadiness: async () => ({ status: "ready", checks: { process: { status: "up" }, database: { status: "up" } } }),
      getMetrics: async () => ({
        process: { uptimeSeconds: 1, draining: false },
        database: { healthy: true, totalConnections: 1, idleConnections: 1, waitingRequests: 0 },
        outbox: { pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: null },
        llmReservations: { pending: 0, expiredPending: 0, oldestPendingAgeSeconds: 0 },
      }),
    },
    authSessions: { authenticate: async () => null },
  } as unknown as Services;
}

async function verifyApiCapacity(): Promise<CapacityEvidence["api"]> {
  const requests = 2_000;
  const concurrency = 50;
  const app = createApp(mockServices(), new Telemetry(false));
  let next = 0;
  let failures = 0;
  const started = performance.now();
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const current = next++;
        if (current >= requests) return;
        const response = await app.request("/healthz");
        if (response.status !== 200 || !response.headers.get("X-Request-ID")) failures += 1;
      }
    }));
  } finally {
    console.error = originalConsoleError;
  }
  const seconds = Math.max((performance.now() - started) / 1_000, 0.001);
  const requestsPerSecond = requests / seconds;
  if (failures > 0) throw new Error(`API capacity gate observed ${failures} failures`);
  if (requestsPerSecond < 200) throw new Error(`API capacity ${requestsPerSecond.toFixed(1)} req/s is below 200 req/s floor`);
  return { requests, concurrency, requestsPerSecond: Math.round(requestsPerSecond), failures };
}

async function verifySqlPlans(client: Client): Promise<CapacityEvidence["sqlPlans"]> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL enable_seqscan = off");
    const plans = [
      await explain(client, "dueReview", `SELECT id FROM user_word_progress WHERE user_id = '00000000-0000-4000-8000-000000000001'::uuid AND wordbook_id = '00000000-0000-4000-8000-000000000002'::uuid AND state IN ('new','learning','review','relearning') AND (due_at IS NULL OR due_at <= now()) ORDER BY due_at ASC NULLS FIRST LIMIT 20`, "idx_user_word_progress_due"),
      await explain(client, "outboxClaim", `SELECT id FROM outbox_events WHERE status IN ('pending','retry') AND available_at <= now() ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 20`, "idx_outbox_events_claim"),
      await explain(client, "llmExpiry", `SELECT id FROM llm_usage WHERE status = 'pending' AND expires_at <= now() ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT 100`, "idx_llm_usage_pending_expiry"),
      await explain(client, "publicWords", `SELECT id, slug, lemma FROM words WHERE is_published = true AND is_deleted = false ORDER BY lemma ASC LIMIT 50`, "idx_words_public_lemma_sort"),
    ];
    return Object.fromEntries(plans);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function verifyOutboxThroughput(): Promise<CapacityEvidence["outbox"]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const prefix = `capacity-${randomUUID()}-`;
  const events = 1_000;
  const workers = 4;
  try {
    await pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, dedupe_key, status, available_at)
       SELECT 'capacity_test', ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
              'capacity.test', '{}'::jsonb, $1 || i::text, 'pending', now()
       FROM generate_series(1, $2::int) AS i`,
      [prefix, events],
    );

    const claimed = new Set<string>();
    let duplicates = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: workers }, async (_, workerIndex) => {
      const repository = new OutboxRepository();
      const workerId = `capacity-worker-${workerIndex}-${randomUUID()}`;
      while (true) {
        const rows = await repository.claimBatch(workerId, 20, 60);
        const owned = rows.filter((row) => row.dedupe_key.startsWith(prefix));
        for (const row of rows.filter((candidate) => !candidate.dedupe_key.startsWith(prefix))) {
          await pool.query(
            `UPDATE outbox_events SET status = 'retry', attempts = GREATEST(attempts - 1, 0), locked_at = NULL, locked_until = NULL, locked_by = NULL, available_at = now() WHERE id = $1`,
            [row.id],
          );
        }
        if (owned.length === 0) {
          const remaining = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM outbox_events WHERE dedupe_key LIKE $1 AND status = 'pending'",
            [`${prefix}%`],
          );
          if (Number(remaining.rows[0]?.count ?? 0) === 0) return;
          continue;
        }
        for (const row of owned) {
          if (claimed.has(row.id)) duplicates += 1;
          claimed.add(row.id);
          await pool.query(
            `UPDATE outbox_events SET status = 'processed', processed_at = now(), locked_at = NULL, locked_until = NULL, updated_at = now() WHERE id = $1 AND locked_by = $2`,
            [row.id, workerId],
          );
        }
      }
    }));
    const seconds = Math.max((performance.now() - started) / 1_000, 0.001);
    const eventsPerSecond = claimed.size / seconds;
    if (claimed.size !== events) throw new Error(`Outbox throughput gate processed ${claimed.size}/${events} events`);
    if (duplicates !== 0) throw new Error(`Outbox throughput gate observed ${duplicates} duplicate claims`);
    if (eventsPerSecond < 50) throw new Error(`Outbox throughput ${eventsPerSecond.toFixed(1)} events/s is below 50 events/s floor`);
    return { events, workers, eventsPerSecond: Math.round(eventsPerSecond), duplicates };
  } finally {
    let cleanupError: unknown;
    try {
      await pool.query("DELETE FROM outbox_events WHERE dedupe_key LIKE $1", [`${prefix}%`]);
    } catch (error) {
      cleanupError = error;
    }
    await pool.end();
    if (cleanupError) throw cleanupError;
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const evidence: CapacityEvidence = {
      api: await verifyApiCapacity(),
      sqlPlans: await verifySqlPlans(client),
      outbox: await verifyOutboxThroughput(),
    };
    console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
