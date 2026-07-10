import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const baselinePath = new URL("../drizzle-release/0000_baseline.sql", import.meta.url);
const baselineCreatedAt = 1783656664987;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function main() {
  // Existing Supabase-derived databases keep the auth principal in auth.users,
  // while fresh local release databases use the public.users compatibility shim.
  const principal = await pool.query<{ name: string | null }>(
    "SELECT COALESCE(to_regclass('public.users'), to_regclass('auth.users'))::text AS name",
  );
  if (!principal.rows[0]?.name) {
    throw new Error("Cannot adopt baseline: missing public.users or auth.users");
  }

  // Adoption is valid only when the existing schema already represents the
  // entire 0000 baseline. Older partial schemas must use an explicit legacy
  // upgrade migration; marking them as baseline-complete would skip tables.
  const requiredTables = [
    "collection_notes", "daily_forecast_snapshots", "import_errors", "import_runs",
    "l3_context_links", "l3_contexts", "l3_import_jobs", "l3_occurrences",
    "l3_proposal_items", "l3_proposals", "l3_recommendation_items",
    "l3_recommendation_runs", "l3_sources", "llm_usage", "note_revisions", "notes",
    "profiles", "review_logs", "review_logs_archive", "sessions", "tags",
    "user_word_l2_progress", "user_word_progress", "word_annotations",
    "word_filter_facets", "word_highlights", "word_l2_content", "word_tags",
    "wordbook_items", "wordbooks", "words",
  ];
  for (const table of requiredTables) {
    const result = await pool.query<{ name: string | null }>(
      "SELECT to_regclass($1)::text AS name",
      [`public.${table}`],
    );
    if (!result.rows[0]?.name) {
      throw new Error(`Cannot adopt baseline: missing public.${table}`);
    }
  }

  const baseline = await readFile(baselinePath, "utf8");
  const hash = createHash("sha256").update(baseline).digest("hex");

  await pool.query("CREATE SCHEMA IF NOT EXISTS vocab_migrations");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vocab_migrations.__v2_release_migrations (
       id serial PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );

  const existing = await pool.query(
    `SELECT 1
     FROM vocab_migrations.__v2_release_migrations
     WHERE created_at = $1
     LIMIT 1`,
    [baselineCreatedAt],
  );
  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO vocab_migrations.__v2_release_migrations (hash, created_at)
       VALUES ($1, $2)`,
      [hash, baselineCreatedAt],
    );
  }

  console.log("Release baseline adopted after schema preflight");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
