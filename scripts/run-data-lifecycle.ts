import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
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
    reviewArchiveDays: integerEnv("DATA_LIFECYCLE_REVIEW_ARCHIVE_DAYS"),
    batchSize: integerEnv("DATA_LIFECYCLE_BATCH_SIZE"),
  } as Partial<DataLifecyclePolicy>;
}

export async function runDataLifecycle(): Promise<void> {
  const databaseUrl = process.env.DATA_LIFECYCLE_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("DATA_LIFECYCLE_DATABASE_URL or TEST_DATABASE_URL is required");
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  if (args.some((arg) => arg !== "--execute") || args.filter((arg) => arg === "--execute").length > 1) {
    throw new Error("only a single --execute argument is supported");
  }
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) throw new Error("database URL must include a database name");
  if (execute && process.env.DATA_LIFECYCLE_CONFIRM !== databaseName) {
    throw new Error(`DATA_LIFECYCLE_CONFIRM must exactly match database name ${databaseName}`);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const result = await new DataLifecycleRepository(pool).run({
      dryRun: !execute,
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
