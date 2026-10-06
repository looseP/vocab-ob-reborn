/**
 * RLS acceptance migrations.
 *
 * Applies the release chain to the dedicated acceptance database, then asserts
 * the database actually reached the chain's terminal state. The count/max
 * assertions exist because the tied-`when` defect (0047–0049) silently skipped
 * migrations while this script's old `migrationCount < 1` check stayed green:
 * the migrator compares only `max(created_at)` against each entry's `when`, so
 * a ledger whose max lags the journal leaves the tail unapplied with no error.
 *
 * Run: npm run rls:acceptance:migrate   (needs the acceptance Postgres up)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const migrationsFolder = resolve(import.meta.dirname, "..", "drizzle-release");

export interface JournalTail {
  /** Number of journal entries the chain declares. */
  entryCount: number;
  /** Highest `when` across journal entries — the terminal state to reach. */
  maxWhen: number;
}

/**
 * The chain's terminal expectation: how many entries it declares and the
 * highest `when` among them. Kept a pure function of the parsed journal so the
 * assertion can be exercised against synthetic journals in unit tests.
 */
export function expectedJournalTail(journal: unknown): JournalTail {
  const entries = (journal as { entries?: unknown } | null | undefined)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("journal has no entries array");
  }
  const whens = entries.map((entry, index) => {
    const when = (entry as { when?: unknown } | null | undefined)?.when;
    if (typeof when !== "number" || !Number.isFinite(when)) {
      throw new Error(`journal entry ${index} has no finite when`);
    }
    return when;
  });
  return { entryCount: entries.length, maxWhen: Math.max(...whens) };
}

/** Compare the applied ledger state against the journal's terminal expectation. */
export function journalTailProblems(
  tail: JournalTail,
  state: { migrationCount: number; maxCreatedAt: number | null },
): string[] {
  const problems: string[] = [];
  if (state.migrationCount !== tail.entryCount) {
    problems.push(
      `ledger has ${state.migrationCount} rows but the journal declares ${tail.entryCount} entries`,
    );
  }
  if (state.maxCreatedAt !== tail.maxWhen) {
    problems.push(
      `max(created_at) is ${state.maxCreatedAt ?? "null"} but the journal's last when is ${tail.maxWhen}`,
    );
  }
  return problems;
}

/** Parse the committed release journal for the acceptance assertions. */
export function readReleaseJournalTail(folder = migrationsFolder): JournalTail {
  return expectedJournalTail(JSON.parse(readFileSync(resolve(folder, "meta", "_journal.json"), "utf8")));
}

export async function runAcceptanceMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder,
      migrationsSchema: "vocab_migrations",
      migrationsTable: "__v2_release_migrations",
    });

    const verification = await pool.query<{
      authUid: string | null;
      tableName: string | null;
      rlsEnabled: boolean | null;
      migrationCount: number;
      maxCreatedAt: string | number | null;
    }>(
      `SELECT
         to_regprocedure('auth.uid()')::text AS "authUid",
         to_regclass('public.daily_forecast_snapshots')::text AS "tableName",
         (
           SELECT relrowsecurity
           FROM pg_class
           WHERE oid = to_regclass('public.daily_forecast_snapshots')
         ) AS "rlsEnabled",
         (
           SELECT count(*)::int
           FROM vocab_migrations.__v2_release_migrations
         ) AS "migrationCount",
         (
           SELECT max(created_at)
           FROM vocab_migrations.__v2_release_migrations
         ) AS "maxCreatedAt"`,
    );
    const state = verification.rows[0];

    // Ledger completeness is asserted first so a skipped tail reports its own
    // cause rather than a downstream symptom.
    const tail = readReleaseJournalTail();
    const tailProblems = journalTailProblems(tail, {
      migrationCount: state?.migrationCount ?? 0,
      maxCreatedAt: state?.maxCreatedAt == null ? null : Number(state.maxCreatedAt),
    });

    if (
      tailProblems.length > 0
      || state?.authUid !== "auth.uid()"
      || state.tableName !== "daily_forecast_snapshots"
      || state.rlsEnabled !== true
    ) {
      throw new Error(
        `RLS acceptance migration verification failed: ${JSON.stringify(state)}` +
          (tailProblems.length > 0 ? ` — ${tailProblems.join("; ")}` : ""),
      );
    }

    console.log(
      `RLS acceptance migrations applied and verified (${state.migrationCount} journal entries, ` +
        `max(created_at) = ${state.maxCreatedAt})`,
    );
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for RLS acceptance migrations");
  }
  runAcceptanceMigrations(databaseUrl).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
