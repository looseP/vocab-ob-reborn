import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for RLS acceptance migrations");
}

const migrationsFolder = resolve(import.meta.dirname, "..", "drizzle-release");
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
       ) AS "migrationCount"`,
  );
  const state = verification.rows[0];
  if (
    state?.authUid !== "auth.uid()"
    || state.tableName !== "daily_forecast_snapshots"
    || state.rlsEnabled !== true
    || state.migrationCount < 1
  ) {
    throw new Error(`RLS acceptance migration verification failed: ${JSON.stringify(state)}`);
  }

  console.log(`RLS acceptance migrations applied and verified (${state.migrationCount} journal entries)`);
} finally {
  await pool.end();
}
