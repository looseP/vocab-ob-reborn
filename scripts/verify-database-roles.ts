import { Client } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const roles = ["vocab_app", "vocab_worker", "vocab_backup", "vocab_migration"] as const;
const client = new Client({ connectionString: databaseUrl });
let connected = false;

async function roleQuery(role: string, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(sql);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function expectDenied(role: string, sql: string, label: string): Promise<void> {
  try {
    await roleQuery(role, sql);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") return;
    throw error;
  }
  throw new Error(`${role} unexpectedly allowed: ${label}`);
}

async function cleanupRole(role: string): Promise<void> {
  const exists = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [role]);
  if (!exists.rows[0]?.exists) return;
  await client.query(`DROP OWNED BY ${role}`);
  await client.query(`REVOKE ${role} FROM CURRENT_USER`);
  await client.query(`DROP ROLE ${role}`);
}

async function main(): Promise<void> {
  await client.connect();
  connected = true;
  for (const role of roles) {
    await cleanupRole(role);
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT ${role} TO CURRENT_USER`);
  }
  await client.query("GRANT USAGE ON SCHEMA public TO vocab_app, vocab_worker, vocab_backup");
  await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vocab_app, vocab_worker");
  await client.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vocab_app, vocab_worker");
  await client.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vocab_app, vocab_worker");
  await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO vocab_backup");
  await client.query("GRANT USAGE ON SCHEMA public TO vocab_migration");
  await client.query("GRANT CREATE ON SCHEMA public TO vocab_migration");

  await roleQuery("vocab_app", "SELECT 1 FROM words LIMIT 0");
  await roleQuery("vocab_app", "INSERT INTO login_rate_limits (key_hash, window_started_at, window_expires_at, attempts) VALUES (repeat('a',64), now(), now() + interval '1 minute', 1) ON CONFLICT (key_hash) DO UPDATE SET attempts = login_rate_limits.attempts + 1");
  await roleQuery("vocab_worker", "SELECT 1 FROM outbox_events FOR UPDATE SKIP LOCKED LIMIT 0");
  await roleQuery("vocab_backup", "SELECT 1 FROM profiles LIMIT 0");
  await roleQuery("vocab_migration", "CREATE TABLE rc_role_probe(id integer)");

  for (const role of ["vocab_app", "vocab_worker", "vocab_backup"]) {
    await expectDenied(role, "CREATE TABLE rc_forbidden_probe(id integer)", "schema DDL");
  }
  await expectDenied("vocab_backup", "UPDATE profiles SET updated_at = updated_at WHERE false", "application write");
  await expectDenied("vocab_app", "CREATE ROLE rc_forbidden_role", "role administration");
  await expectDenied("vocab_worker", "DROP SCHEMA public CASCADE", "schema destruction");

  console.log(JSON.stringify({ ok: true, roles, ddlExclusiveToMigration: true, backupReadOnly: true }));
}

main().finally(async () => {
  if (connected) {
    await client.query("RESET ROLE").catch(() => undefined);
    for (const role of roles) await cleanupRole(role).catch(() => undefined);
    await client.end();
  }
});
