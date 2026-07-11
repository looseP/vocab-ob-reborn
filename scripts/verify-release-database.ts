import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("TEST_DATABASE_URL or DATABASE_URL is required");
  process.exit(1);
}

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is required for the blocking database release gate");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await pool.query(sql, params);
  return result.rows[0]?.value as T;
}

async function main() {
  const requiredTables = [
    "profiles",
    "auth_sessions",
    "login_rate_limits",
    "words",
    "wordbooks",
    "user_word_progress",
    "sessions",
    "review_logs",
    "note_revisions",
    "l3_proposals",
    "l3_recommendation_runs",
    "llm_usage",
    "outbox_events",
    "outbox_effect_receipts",
  ];

  for (const table of requiredTables) {
    const exists = await scalar<string | null>("SELECT to_regclass($1)::text AS value", [`public.${table}`]);
    if (exists !== table) {
      throw new Error(`Missing required table: public.${table}`);
    }
  }

  const expectedFunctions = [
    "get_or_create_today_session(uuid,uuid,text,timestamp with time zone)",
    "increment_session_cards_seen(uuid,uuid,uuid)",
    "undo_review_log(uuid,uuid,uuid,uuid)",
  ];

  for (const signature of expectedFunctions) {
    const exists = await scalar<string | null>("SELECT to_regprocedure($1)::text AS value", [`public.${signature}`]);
    if (!exists) {
      throw new Error(`Missing required function: public.${signature}`);
    }
  }

  const rateLimitConstraints = await scalar<number>(
    `SELECT count(*)::int AS value
     FROM pg_constraint
     WHERE conrelid = 'public.login_rate_limits'::regclass
       AND conname = ANY (ARRAY['login_rate_limits_key_hash_check', 'login_rate_limits_attempts_check', 'login_rate_limits_window_check'])`,
  );
  if (rateLimitConstraints !== 3) throw new Error(`Expected 3 login rate-limit constraints, received ${rateLimitConstraints}`);
  const expiryIndex = await scalar<string | null>("SELECT to_regclass('public.idx_login_rate_limits_expiry')::text AS value");
  if (expiryIndex !== "idx_login_rate_limits_expiry") throw new Error("Missing login rate-limit expiry index");

  const lifecycleIndexes = [
    "idx_auth_sessions_expiry_cleanup",
    "idx_auth_sessions_revoked_cleanup",
    "idx_llm_usage_terminal_finalized_cleanup",
    "idx_llm_usage_settled_created_cleanup",
    "idx_outbox_events_processed_cleanup",
    "idx_review_logs_cleanup",
    "idx_review_logs_archive_cleanup",
  ];
  for (const indexName of lifecycleIndexes) {
    const exists = await scalar<string | null>("SELECT to_regclass($1)::text AS value", [`public.${indexName}`]);
    if (exists !== indexName) throw new Error(`Missing lifecycle cleanup index: ${indexName}`);
  }

  const userId = "00000000-0000-4000-8000-000000000001";
  const wordbookId = "00000000-0000-4000-8000-000000000002";

  await pool.query(
    `INSERT INTO public.users (id, email)
     VALUES ($1::uuid, 'release-smoke@example.invalid')
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
  await pool.query(
    `INSERT INTO public.profiles (id, email)
     VALUES ($1::uuid, 'release-smoke@example.invalid')
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
  await pool.query(
    `INSERT INTO public.wordbooks (id, user_id, name, description, is_default, settings)
     VALUES ($1::uuid, $2::uuid, 'Release smoke', NULL, true, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [wordbookId, userId],
  );

  const sessionResults = await Promise.all(
    Array.from({ length: 8 }, () => pool.query(
      `SELECT id
       FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
      [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
    )),
  );
  const sessionIds = new Set(sessionResults.map((result) => result.rows[0]?.id));
  if (sessionIds.size !== 1 || sessionIds.has(undefined)) {
    throw new Error(`Concurrent daily session creation returned ${sessionIds.size} distinct ids`);
  }

  const sessionId = [...sessionIds][0] as string;
  await pool.query(
    `UPDATE public.sessions
     SET cards_seen = 0, updated_at = now()
     WHERE id = $1::uuid AND user_id = $2::uuid AND wordbook_id = $3::uuid`,
    [sessionId, userId, wordbookId],
  );
  await Promise.all(
    Array.from({ length: 25 }, () => pool.query(
      "SELECT public.increment_session_cards_seen($1::uuid, $2::uuid, $3::uuid)",
      [sessionId, userId, wordbookId],
    )),
  );

  const cardsSeen = await scalar<number>(
    "SELECT cards_seen::int AS value FROM public.sessions WHERE id = $1::uuid",
    [sessionId],
  );
  if (cardsSeen !== 25) {
    throw new Error(`Atomic session increment expected 25, received ${cardsSeen}`);
  }

  const activeCount = await scalar<number>(
    `SELECT count(*)::int AS value
     FROM public.sessions
     WHERE user_id = $1::uuid
       AND wordbook_id = $2::uuid
       AND mode = 'review'
       AND ended_at IS NULL`,
    [userId, wordbookId],
  );
  if (activeCount !== 1) {
    throw new Error(`Expected one active session, received ${activeCount}`);
  }

  console.log("Release database verification passed");
  console.log(`Tables checked: ${requiredTables.length}`);
  console.log(`Functions checked: ${expectedFunctions.length}`);
  console.log("Login rate limit: table + 3 constraints + expiry index");
  console.log(`Lifecycle cleanup indexes checked: ${lifecycleIndexes.length}`);
  console.log("Concurrent daily session: 8 callers -> 1 session");
  console.log("Atomic counter: 25 increments -> 25");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
