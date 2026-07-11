import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  DATA_LIFECYCLE_POLICY_VERSION,
  DataLifecycleRepository,
  type DataLifecyclePolicy,
} from "../src/repositories/data-lifecycle.repository";

function integerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

export function readDataLifecyclePolicy(): Partial<DataLifecyclePolicy> {
  return {
    outboxProcessedDays: integerEnv("DATA_LIFECYCLE_OUTBOX_PROCESSED_DAYS"),
    authSessionDays: integerEnv("DATA_LIFECYCLE_AUTH_SESSION_DAYS"),
    llmTerminalDays: integerEnv("DATA_LIFECYCLE_LLM_TERMINAL_DAYS"),
    llmSettledDays: integerEnv("DATA_LIFECYCLE_LLM_SETTLED_DAYS"),
    reviewLogDays: integerEnv("DATA_LIFECYCLE_REVIEW_LOG_DAYS"),
    batchSize: integerEnv("DATA_LIFECYCLE_BATCH_SIZE"),
    maxBatches: integerEnv("DATA_LIFECYCLE_MAX_BATCHES"),
    maxRows: integerEnv("DATA_LIFECYCLE_MAX_ROWS"),
  } as Partial<DataLifecyclePolicy>;
}

function requiredCutoff(): Date {
  const raw = process.env.DATA_LIFECYCLE_CUTOFF;
  if (!raw) throw new Error("DATA_LIFECYCLE_CUTOFF is required");
  const cutoff = new Date(raw);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.toISOString() !== raw) {
    throw new Error("DATA_LIFECYCLE_CUTOFF must be a canonical UTC ISO timestamp");
  }
  if (cutoff.getTime() > Date.now()) {
    throw new Error("DATA_LIFECYCLE_CUTOFF cannot be in the future");
  }
  return cutoff;
}

export async function runDataLifecycle(): Promise<void> {
  const databaseUrl = process.env.DATA_LIFECYCLE_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("DATA_LIFECYCLE_DATABASE_URL or TEST_DATABASE_URL is required");
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  if (args.some((arg) => arg !== "--execute") || args.filter((arg) => arg === "--execute").length > 1) {
    throw new Error("only a single --execute argument is supported");
  }
  const cutoff = requiredCutoff();
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    lock_timeout: integerEnv("DATA_LIFECYCLE_LOCK_TIMEOUT_MS") ?? 2_000,
    statement_timeout: integerEnv("DATA_LIFECYCLE_STATEMENT_TIMEOUT_MS") ?? 30_000,
  });
  try {
    const identity = (await pool.query<{ current_database: string; current_user: string; server_version_num: string }>(
      "SELECT current_database(), current_user, current_setting('server_version_num') AS server_version_num",
    )).rows[0];
    if (!identity) throw new Error("database identity query returned no row");
    if (["postgres", "template0", "template1"].includes(identity.current_database)) {
      throw new Error(`refusing lifecycle operation on system database ${identity.current_database}`);
    }
    if (execute) {
      if (process.env.DATA_LIFECYCLE_ALLOW_WRITE !== "true") {
        throw new Error("DATA_LIFECYCLE_ALLOW_WRITE must exactly equal true");
      }
      if (process.env.DATA_LIFECYCLE_CONFIRM !== identity.current_database) {
        throw new Error(`DATA_LIFECYCLE_CONFIRM must exactly match current_database ${identity.current_database}`);
      }
      if (process.env.DATA_LIFECYCLE_CONFIRM_CUTOFF !== cutoff.toISOString()) {
        throw new Error("DATA_LIFECYCLE_CONFIRM_CUTOFF must exactly match DATA_LIFECYCLE_CUTOFF");
      }
      if (process.env.NODE_ENV === "production") {
        const expected = `PURGE:${identity.current_database}:${DATA_LIFECYCLE_POLICY_VERSION}`;
        if (process.env.DATA_LIFECYCLE_PRODUCTION_CONFIRM !== expected) {
          throw new Error(`DATA_LIFECYCLE_PRODUCTION_CONFIRM must exactly equal ${expected}`);
        }
      }
    }
    const result = await new DataLifecycleRepository(pool).run({
      cutoff,
      dryRun: !execute,
      allowWrite: execute,
      policy: Object.fromEntries(Object.entries(readDataLifecyclePolicy()).filter(([, value]) => value !== undefined)),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDataLifecycle().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
