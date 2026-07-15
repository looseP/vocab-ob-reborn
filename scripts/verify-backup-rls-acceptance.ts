import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Client, type QueryResultRow } from "pg";
import { postgresClientConfig } from "../src/db/ssl";
import { databaseName, postgresEnvironment } from "./postgres-backup";

const ROLE_URLS = {
  app: ["APP_DATABASE_URL", "vocab_app"],
  worker: ["WORKER_DATABASE_URL", "vocab_worker"],
  backup: ["BACKUP_DATABASE_URL", "vocab_backup"],
  migration: ["MIGRATION_DATABASE_URL", "vocab_migration"],
} as const;
const BACKUP_ROLE = ROLE_URLS.backup[1];
const ACCEPTANCE_DATABASE_PATTERN = /^vocab_backup_acceptance_[a-f0-9]{32}$/;
const APPLICATION_SCHEMAS = ["auth", "public", "vocab_migrations"] as const;

type RoleKind = keyof typeof ROLE_URLS;
type QueryClient = Pick<Client, "query">;

interface Fixture {
  users: [string, string];
  wordbooks: [string, string];
  word: string;
  l1Progress: [string, string];
  l2Progress: [string, string];
  marker: string;
}

interface TableEvidence {
  table: string;
  rowCount: number;
  owners: string[];
  sha256: string;
}

interface OwnerRow {
  schema: string;
  name: string;
  owner: string;
}

interface RelationOwnerRow extends OwnerRow {
  kind: string;
}

interface RoutineOwnerRow extends OwnerRow {
  identityArguments: string;
  kind: string;
}

interface TypeOwnerRow extends OwnerRow {
  kind: string;
}

interface ExtensionRow {
  name: string;
  version: string;
  owner: string;
}

interface RowSecurityRow {
  schema: string;
  table: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
}

interface PolicyRow {
  schema: string;
  table: string;
  name: string;
  command: string;
  roles: string[];
  permissive: boolean;
  qual: string | null;
  withCheck: string | null;
}

interface SequenceStateRow {
  schema: string;
  name: string;
  lastValue: string | null;
  isCalled: boolean;
}

interface AclRow {
  schema: string;
  name: string;
  acl: string[] | null;
}

interface RoutineAclRow extends AclRow {
  identityArguments: string;
}

interface DefaultAclRow {
  owner: string;
  schema: string | null;
  objectType: string;
  acl: string[] | null;
}

interface ColumnRow {
  schema: string;
  table: string;
  position: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultExpression: string | null;
  identity: string;
  generated: string;
  collation: string | null;
}

interface IndexRow {
  schema: string;
  table: string;
  name: string;
  definition: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
}

interface ConstraintRow {
  schema: string;
  table: string;
  name: string;
  kind: string;
  definition: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
}

interface TriggerRow {
  schema: string;
  table: string;
  name: string;
  definition: string;
  enabled: string;
}

export interface CatalogSnapshot {
  databaseOwner: string;
  schemas: OwnerRow[];
  relations: RelationOwnerRow[];
  columns: ColumnRow[];
  indexes: IndexRow[];
  constraints: ConstraintRow[];
  triggers: TriggerRow[];
  routines: RoutineOwnerRow[];
  types: TypeOwnerRow[];
  extensions: ExtensionRow[];
  rowSecurity: RowSecurityRow[];
  policies: PolicyRow[];
  migrationHistory: {
    count: number;
    sha256: string;
    maxId: string | null;
    maxCreatedAt: string | null;
  };
  sequences: SequenceStateRow[];
  acls: {
    schemas: AclRow[];
    relations: AclRow[];
    routines: RoutineAclRow[];
    defaults: DefaultAclRow[];
  };
}

export interface PostgresInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type RoleDatabaseUrls = Record<RoleKind, string>;

function postgresBinary(name: string, binDirectory = process.env.PG_BIN_DIR): string {
  if (!binDirectory) return name;
  return join(binDirectory, process.platform === "win32" ? `${name}.exe` : name);
}

export function buildPgDumpInvocation(databaseUrl: string, dumpPath: string): PostgresInvocation {
  return {
    command: postgresBinary("pg_dump"),
    args: ["--format=custom", "--compress=6", "--no-owner", "--file", dumpPath],
    env: postgresEnvironment(databaseUrl),
  };
}

export function buildPgRestoreInvocation(databaseUrl: string, dumpPath: string): PostgresInvocation {
  return {
    command: postgresBinary("pg_restore"),
    args: [
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--no-owner",
      "--jobs",
      process.env.PG_RESTORE_JOBS ?? "2",
      dumpPath,
    ],
    env: postgresEnvironment(databaseUrl),
  };
}

export function acceptanceDatabaseName(uuid: string = randomUUID()): string {
  const compact = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new Error("Acceptance UUID is invalid");
  return `vocab_backup_acceptance_${compact}`;
}

export function retargetDatabaseUrl(sourceUrl: string, targetDatabase: string): string {
  if (!ACCEPTANCE_DATABASE_PATTERN.test(targetDatabase)) {
    throw new Error("Refusing to target an unguarded acceptance database name");
  }
  const target = new URL(sourceUrl);
  target.pathname = `/${targetDatabase}`;
  return target.toString();
}

export function retargetRoleDatabaseUrls(urls: RoleDatabaseUrls, targetDatabase: string): RoleDatabaseUrls {
  return {
    app: retargetDatabaseUrl(urls.app, targetDatabase),
    worker: retargetDatabaseUrl(urls.worker, targetDatabase),
    backup: retargetDatabaseUrl(urls.backup, targetDatabase),
    migration: retargetDatabaseUrl(urls.migration, targetDatabase),
  };
}

function serverIdentity(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}`;
}

export function assertSafeAcceptanceDatabase(sourceUrl: string, targetUrl: string): void {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  if (serverIdentity(source) !== serverIdentity(target)) {
    throw new Error("Acceptance restore database must use the source PostgreSQL instance");
  }
  if (databaseName(sourceUrl) === databaseName(targetUrl)) {
    throw new Error("Acceptance restore database must not be the source database");
  }
  if (!ACCEPTANCE_DATABASE_PATTERN.test(databaseName(targetUrl))) {
    throw new Error("Refusing to manage an unguarded acceptance database name");
  }
}

function requiredDatabaseUrl(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !databaseName(value)) {
    throw new Error(`${name} must be a complete PostgreSQL URL`);
  }
  return value;
}

function databaseIdentity(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${serverIdentity(url)}/${databaseName(databaseUrl)}`;
}

function requiredRoleUrls(adminUrl: string): RoleDatabaseUrls {
  const urls = Object.fromEntries(Object.entries(ROLE_URLS).map(([kind, [variable, role]]) => {
    const value = requiredDatabaseUrl(variable);
    if (databaseIdentity(value) !== databaseIdentity(adminUrl)) {
      throw new Error(`${variable} must target the same database as DATABASE_ADMIN_URL`);
    }
    if (decodeURIComponent(new URL(value).username) !== role) {
      throw new Error(`${variable} username must be exactly ${role}`);
    }
    return [kind, value];
  })) as RoleDatabaseUrls;
  return urls;
}

async function runPostgres(invocation: PostgresInvocation): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${basename(invocation.command)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function connect(databaseUrl: string): Promise<Client> {
  const client = new Client(postgresClientConfig(databaseUrl));
  await client.connect();
  return client;
}

function quoteAcceptanceDatabase(identifier: string): string {
  if (!ACCEPTANCE_DATABASE_PATTERN.test(identifier)) {
    throw new Error("Refusing to quote an unguarded acceptance database name");
  }
  return `"${identifier}"`;
}

function quoteCatalogIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function acceptanceDatabaseOwnerStatement(name: string): string {
  return `CREATE DATABASE ${quoteAcceptanceDatabase(name)} OWNER vocab_migration TEMPLATE template0`;
}

async function createAcceptanceDatabase(admin: Client, name: string): Promise<void> {
  await admin.query(acceptanceDatabaseOwnerStatement(name));
}

async function dropAcceptanceDatabase(admin: Client, sourceUrl: string, targetUrl: string): Promise<void> {
  assertSafeAcceptanceDatabase(sourceUrl, targetUrl);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteAcceptanceDatabase(databaseName(targetUrl))} WITH (FORCE)`);
}

async function expectPermissionDenied(client: Client, sql: string, params: unknown[], label: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql, params);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `permission check rollback failed: ${label}`);
    }
    if ((error as { code?: string }).code === "42501") return;
    throw error;
  }
  await client.query("ROLLBACK");
  throw new Error(`unexpectedly allowed: ${label}`);
}

async function assertLoginIdentity(client: Client, expectedRole: string): Promise<void> {
  const result = await client.query<{ session_user: string; current_user: string }>("SELECT session_user, current_user");
  const identity = result.rows[0];
  if (!identity || identity.session_user !== expectedRole || identity.current_user !== expectedRole) {
    throw new Error(`${expectedRole} did not authenticate as a real LOGIN identity`);
  }
}

async function actorRows<T extends QueryResultRow>(client: Client, actor: string | undefined, sql: string, params: unknown[]): Promise<T[]> {
  await client.query("BEGIN");
  try {
    if (actor) await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actor]);
    const result = await client.query<T>(sql, params);
    await client.query("ROLLBACK");
    return result.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "restored actor query and rollback failed");
    }
    throw error;
  }
}

async function verifyApplicationBoundary(app: Client, fixture: Fixture): Promise<void> {
  await assertLoginIdentity(app, ROLE_URLS.app[1]);
  const own = await actorRows(app, fixture.users[0], "SELECT id::text FROM wordbooks WHERE id = ANY($1::uuid[]) ORDER BY id", [fixture.wordbooks]);
  const other = await actorRows(app, fixture.users[1], "SELECT id::text FROM wordbooks WHERE id = $1", [fixture.wordbooks[0]]);
  const anonymous = await actorRows(app, undefined, "SELECT id::text FROM wordbooks WHERE id = ANY($1::uuid[])", [fixture.wordbooks]);
  if (own.length !== 1 || own[0]?.id !== fixture.wordbooks[0] || other.length !== 0 || anonymous.length !== 0) {
    throw new Error("restored vocab_app did not enforce owner RLS positive and negative cases");
  }
}

async function verifyWorkerBoundary(worker: Client, fixture: Fixture): Promise<void> {
  await assertLoginIdentity(worker, ROLE_URLS.worker[1]);
  const own = await actorRows(worker, fixture.users[0], "SELECT id::text FROM user_word_l2_progress WHERE id = ANY($1::uuid[]) ORDER BY id", [fixture.l2Progress]);
  const other = await actorRows(worker, fixture.users[1], "SELECT id::text FROM user_word_l2_progress WHERE id = $1", [fixture.l2Progress[0]]);
  const anonymous = await actorRows(worker, undefined, "SELECT id::text FROM user_word_l2_progress WHERE id = ANY($1::uuid[])", [fixture.l2Progress]);
  if (own.length !== 1 || own[0]?.id !== fixture.l2Progress[0] || other.length !== 0 || anonymous.length !== 0) {
    throw new Error("restored vocab_worker did not enforce owner RLS positive and negative cases");
  }
}

async function verifyMigrationBoundary(migration: Client): Promise<void> {
  await assertLoginIdentity(migration, ROLE_URLS.migration[1]);
  await migration.query("BEGIN");
  try {
    await migration.query("CREATE TABLE public.vocab_migration_restore_ddl_probe (id integer)");
    await migration.query("ROLLBACK");
  } catch (error) {
    try {
      await migration.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "migration DDL probe and rollback failed");
    }
    throw error;
  }
  await expectPermissionDenied(migration, `CREATE ROLE vocab_migration_forbidden_${randomUUID().replaceAll("-", "")}`, [], "vocab_migration CREATE ROLE");
}

async function verifyBackupBoundary(backup: Client, fixture: Fixture): Promise<void> {
  const identity = await backup.query<{
    session_user: string;
    current_user: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`SELECT session_user, current_user, role.rolcanlogin, role.rolsuper,
             role.rolcreatedb, role.rolcreaterole, role.rolreplication, role.rolbypassrls
      FROM pg_roles role WHERE role.rolname = session_user`);
  const role = identity.rows[0];
  if (!role || role.session_user !== BACKUP_ROLE || role.current_user !== BACKUP_ROLE
    || !role.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole
    || role.rolreplication || !role.rolbypassrls) {
    throw new Error("vocab_backup LOGIN identity or role attributes are unsafe");
  }

  const memberships = await backup.query(
    `SELECT 1 FROM pg_auth_members membership
     JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname = session_user`,
  );
  if (memberships.rowCount !== 0) throw new Error("vocab_backup must have zero parent role memberships");

  const privileges = await backup.query<{
    database_create: boolean;
    schema_create: boolean;
    writable_table_count: number;
  }>(`SELECT
      has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
      has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
      (SELECT count(*)::int
       FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
         AND (has_table_privilege(current_user, relation.oid, 'INSERT')
           OR has_table_privilege(current_user, relation.oid, 'UPDATE')
           OR has_table_privilege(current_user, relation.oid, 'DELETE')
           OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
           OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
           OR has_table_privilege(current_user, relation.oid, 'TRIGGER'))) AS writable_table_count`);
  const grant = privileges.rows[0];
  if (!grant || grant.database_create || grant.schema_create || Number(grant.writable_table_count) !== 0) {
    throw new Error("vocab_backup has non-read-only database, schema, or table grants");
  }

  const visible = await backup.query<{ user_id: string }>(
    "SELECT user_id FROM wordbooks WHERE id = ANY($1::uuid[]) ORDER BY user_id",
    [fixture.wordbooks],
  );
  if (visible.rowCount !== 2 || new Set(visible.rows.map((row) => row.user_id)).size !== 2) {
    throw new Error("vocab_backup did not bypass RLS across both fixture owners");
  }

  await expectPermissionDenied(backup, "INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, $3)", [randomUUID(), fixture.users[0], "forbidden-backup-insert"], "vocab_backup INSERT");
  await expectPermissionDenied(backup, "UPDATE wordbooks SET name = name WHERE id = $1", [fixture.wordbooks[0]], "vocab_backup UPDATE");
  await expectPermissionDenied(backup, "DELETE FROM wordbooks WHERE id = $1", [fixture.wordbooks[0]], "vocab_backup DELETE");
  await expectPermissionDenied(backup, "CREATE TABLE public.vocab_backup_forbidden_ddl (id int)", [], "vocab_backup CREATE TABLE");
  await expectPermissionDenied(backup, "CREATE SCHEMA vocab_backup_forbidden_schema", [], "vocab_backup CREATE SCHEMA");
  await expectPermissionDenied(backup, `CREATE ROLE vocab_backup_forbidden_${randomUUID().replaceAll("-", "")}`, [], "vocab_backup CREATE ROLE");
}

async function seedFixture(admin: Client): Promise<Fixture> {
  const fixture: Fixture = {
    users: [randomUUID(), randomUUID()],
    wordbooks: [randomUUID(), randomUUID()],
    word: randomUUID(),
    l1Progress: [randomUUID(), randomUUID()],
    l2Progress: [randomUUID(), randomUUID()],
    marker: randomUUID().replaceAll("-", ""),
  };
  await admin.query("BEGIN");
  try {
    for (let index = 0; index < 2; index += 1) {
      const email = `backup-acceptance-${fixture.marker}-${index}@example.invalid`;
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [fixture.users[index], email]);
      await admin.query("INSERT INTO profiles (id, email) VALUES ($1, $2)", [fixture.users[index], email]);
      await admin.query(
        `INSERT INTO wordbooks (id, user_id, name, description, settings)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [fixture.wordbooks[index], fixture.users[index], `backup-${fixture.marker}-${index}`, `owner-${index}`, JSON.stringify({ acceptance: fixture.marker, owner: index })],
      );
    }
    await admin.query(
      `INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [fixture.word, `backup-${fixture.marker}`, fixture.marker.padEnd(64, "0").slice(0, 64), `backup/${fixture.marker}.md`, "Backup acceptance", "backup-acceptance", "fixture", "fixture"],
    );
    for (let index = 0; index < 2; index += 1) {
      await admin.query(
        `INSERT INTO user_word_progress
         (id, user_id, word_id, wordbook_id, state, review_count, recent_ratings, scheduler_payload)
         VALUES ($1, $2, $3, $4, 'review', $5, $6::jsonb, $7::jsonb)`,
        [fixture.l1Progress[index], fixture.users[index], fixture.word, fixture.wordbooks[index], 11 + index, JSON.stringify([index + 1, 3]), JSON.stringify({ acceptance: fixture.marker, owner: index })],
      );
      await admin.query(
        `INSERT INTO user_word_l2_progress
         (id, user_id, word_id, wordbook_id, l2_state, l2_review_count, recent_ratings, l2_scheduler_payload)
         VALUES ($1, $2, $3, $4, 'review', $5, $6::jsonb, $7::jsonb)`,
        [fixture.l2Progress[index], fixture.users[index], fixture.word, fixture.wordbooks[index], 21 + index, JSON.stringify([index + 2, 4]), JSON.stringify({ acceptance: fixture.marker, owner: index })],
      );
    }
    await admin.query("COMMIT");
    return fixture;
  } catch (error) {
    try {
      await admin.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "backup fixture seed and rollback failed");
    }
    throw error;
  }
}

async function cleanupFixture(admin: Client, fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return;
  await admin.query("BEGIN");
  try {
    await admin.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [fixture.users]);
    await admin.query("DELETE FROM words WHERE id = $1", [fixture.word]);
    await admin.query("COMMIT");
  } catch (error) {
    try {
      await admin.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "backup fixture cleanup and rollback failed");
    }
    throw error;
  }
}

function checksumRows(rows: QueryResultRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function tableEvidence(client: Client, table: "wordbooks" | "user_word_progress" | "user_word_l2_progress", ids: [string, string]): Promise<TableEvidence> {
  const columns = table === "wordbooks"
    ? "id::text, user_id::text, name, description, is_default, settings"
    : table === "user_word_progress"
      ? "id::text, user_id::text, word_id::text, wordbook_id::text, state, review_count, recent_ratings, scheduler_payload"
      : "id::text, user_id::text, word_id::text, wordbook_id::text, l2_state, l2_review_count, recent_ratings, l2_scheduler_payload";
  const result = await client.query(`SELECT ${columns} FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
  return {
    table,
    rowCount: result.rowCount ?? 0,
    owners: [...new Set(result.rows.map((row) => String(row.user_id)))].sort(),
    sha256: checksumRows(result.rows),
  };
}

async function fixtureEvidence(client: Client, fixture: Fixture): Promise<TableEvidence[]> {
  return Promise.all([
    tableEvidence(client, "wordbooks", fixture.wordbooks),
    tableEvidence(client, "user_word_progress", fixture.l1Progress),
    tableEvidence(client, "user_word_l2_progress", fixture.l2Progress),
  ]);
}

function assertCompleteEvidence(source: TableEvidence[], restored: TableEvidence[], fixture: Fixture): void {
  if (source.length !== restored.length) throw new Error("Restored fixture evidence is incomplete");
  for (let index = 0; index < source.length; index += 1) {
    const before = source[index]!;
    const after = restored[index]!;
    if (before.rowCount !== 2 || before.owners.length !== 2
      || before.owners.some((owner) => !fixture.users.includes(owner))
      || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`Restored ${before.table} rows do not match both source owners and checksum`);
    }
  }
}

function sortedAcl(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(String).sort() : null;
}

export async function collectCatalogSnapshot(client: QueryClient): Promise<CatalogSnapshot> {
  const schemas = [...APPLICATION_SCHEMAS];
  const database = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`,
  );
  const schemaRows = await client.query<{ schema: string; name: string; owner: string; acl: string[] | null }>(
    `SELECT n.nspname AS schema, n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner, n.nspacl AS acl
     FROM pg_namespace n WHERE n.nspname = ANY($1::text[]) ORDER BY n.nspname`, [schemas],
  );
  const relations = await client.query<{ schema: string; name: string; owner: string; kind: string; acl: string[] | null }>(
    `SELECT n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
            c.relkind::text AS kind, c.relacl AS acl
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY n.nspname, c.relname, c.relkind`, [schemas],
  );
  const columns = await client.query<{
    schema: string; table: string; position: number; name: string; type: string; not_null: boolean;
    default_expression: string | null; identity: string; generated: string; collation: string | null;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, a.attnum::int AS position, a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_expression, a.attidentity::text AS identity,
            a.attgenerated::text AS generated, coll.collname AS collation
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     LEFT JOIN pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> 0
     WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY n.nspname, c.relname, a.attnum`, [schemas],
  );
  const indexes = await client.query<{
    schema: string; table: string; name: string; definition: string; unique: boolean; primary: boolean; valid: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, i.relname AS name,
            pg_get_indexdef(i.oid) AS definition, x.indisunique AS unique,
            x.indisprimary AS primary, x.indisvalid AS valid
     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
     ORDER BY n.nspname, c.relname, i.relname`, [schemas],
  );
  const constraints = await client.query<{
    schema: string; table: string; name: string; kind: string; definition: string;
    deferrable: boolean; initially_deferred: boolean; validated: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, constraint.conname AS name,
            constraint.contype::text AS kind, pg_get_constraintdef(constraint.oid, true) AS definition,
            constraint.condeferrable AS deferrable, constraint.condeferred AS initially_deferred,
            constraint.convalidated AS validated
     FROM pg_constraint constraint JOIN pg_class c ON c.oid = constraint.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
     ORDER BY n.nspname, c.relname, constraint.conname`, [schemas],
  );
  const triggers = await client.query<{
    schema: string; table: string; name: string; definition: string; enabled: string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, trigger.tgname AS name,
            pg_get_triggerdef(trigger.oid, true) AS definition, trigger.tgenabled::text AS enabled
     FROM pg_trigger trigger JOIN pg_class c ON c.oid = trigger.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[]) AND NOT trigger.tgisinternal
     ORDER BY n.nspname, c.relname, trigger.tgname`, [schemas],
  );
  const routines = await client.query<{ schema: string; name: string; owner: string; identity_arguments: string; kind: string; acl: string[] | null }>(
    `SELECT n.nspname AS schema, p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments, p.prokind::text AS kind, p.proacl AS acl
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1::text[])
     ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind`, [schemas],
  );
  const types = await client.query<{ schema: string; name: string; owner: string; kind: string }>(
    `SELECT n.nspname AS schema, t.typname AS name, pg_get_userbyid(t.typowner) AS owner, t.typtype::text AS kind
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY($1::text[]) AND t.typtype IN ('e', 'd', 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
     ORDER BY n.nspname, t.typname, t.typtype`, [schemas],
  );
  const extensions = await client.query<{ name: string; version: string; owner: string }>(
    `SELECT e.extname AS name, e.extversion AS version, pg_get_userbyid(e.extowner) AS owner
     FROM pg_extension e ORDER BY e.extname`,
  );
  const rowSecurity = await client.query<{ schema: string; table: string; row_security: boolean; force_row_security: boolean }>(
    `SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS row_security,
            c.relforcerowsecurity AS force_row_security
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
     ORDER BY n.nspname, c.relname`, [schemas],
  );
  const policies = await client.query<{
    schema: string; table: string; name: string; command: string; roles: string[];
    permissive: boolean; qual: string | null; with_check: string | null;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, p.polname AS name, p.polcmd::text AS command,
            ARRAY(SELECT CASE WHEN role_oid.oid = 0 THEN 'public' ELSE pg_get_userbyid(role_oid.oid) END
                  FROM unnest(p.polroles) role_oid(oid)
                  ORDER BY CASE WHEN role_oid.oid = 0 THEN 'public' ELSE pg_get_userbyid(role_oid.oid) END) AS roles,
            p.polpermissive AS permissive, pg_get_expr(p.polqual, p.polrelid) AS qual,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
     FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
     ORDER BY n.nspname, c.relname, p.polname`, [schemas],
  );
  const migrationRows = await client.query<{ row: QueryResultRow }>(
    `SELECT to_jsonb(migration) AS row
     FROM vocab_migrations.__v2_release_migrations migration ORDER BY migration.id`,
  );
  const sequenceCatalog = relations.rows.filter((row) => row.kind === "S");
  const sequences: SequenceStateRow[] = [];
  for (const sequence of sequenceCatalog) {
    const state = await client.query<{ last_value: string | null; is_called: boolean }>(
      `SELECT last_value::text AS last_value, is_called FROM ${quoteCatalogIdentifier(sequence.schema)}.${quoteCatalogIdentifier(sequence.name)}`,
    );
    const row = state.rows[0];
    if (!row) throw new Error(`Unable to read sequence state: ${sequence.schema}.${sequence.name}`);
    sequences.push({ schema: sequence.schema, name: sequence.name, lastValue: row.last_value, isCalled: row.is_called });
  }
  const defaultAcls = await client.query<{ owner: string; schema: string | null; object_type: string; acl: string[] | null }>(
    `SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema,
            d.defaclobjtype::text AS object_type, d.defaclacl AS acl
     FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE d.defaclnamespace = 0 OR n.nspname = ANY($1::text[])
     ORDER BY owner, schema NULLS FIRST, object_type`, [schemas],
  );

  const history = migrationRows.rows.map((value) => value.row);
  const maxId = history.reduce<string | null>((max, row) => row.id == null || (max != null && BigInt(String(row.id)) <= BigInt(max)) ? max : String(row.id), null);
  const createdValues = history.map((row) => row.created_at).filter((value) => value != null).map(String).sort();
  const owner = database.rows[0]?.owner;
  if (!owner) throw new Error("Unable to collect database owner");
  return {
    databaseOwner: owner,
    schemas: schemaRows.rows.map((row) => ({ schema: row.schema, name: row.name, owner: row.owner })),
    relations: relations.rows.map((row) => ({ schema: row.schema, name: row.name, owner: row.owner, kind: row.kind })),
    columns: columns.rows.map((row) => ({
      schema: row.schema, table: row.table, position: row.position, name: row.name, type: row.type,
      notNull: row.not_null, defaultExpression: row.default_expression, identity: row.identity,
      generated: row.generated, collation: row.collation,
    })),
    indexes: indexes.rows,
    constraints: constraints.rows.map((row) => ({
      schema: row.schema, table: row.table, name: row.name, kind: row.kind, definition: row.definition,
      deferrable: row.deferrable, initiallyDeferred: row.initially_deferred, validated: row.validated,
    })),
    triggers: triggers.rows,
    routines: routines.rows.map((row) => ({ schema: row.schema, name: row.name, owner: row.owner, identityArguments: row.identity_arguments, kind: row.kind })),
    types: types.rows.map((row) => ({ schema: row.schema, name: row.name, owner: row.owner, kind: row.kind })),
    extensions: extensions.rows,
    rowSecurity: rowSecurity.rows.map((row) => ({ schema: row.schema, table: row.table, rowSecurity: row.row_security, forceRowSecurity: row.force_row_security })),
    policies: policies.rows.map((row) => ({ schema: row.schema, table: row.table, name: row.name, command: row.command, roles: [...row.roles].sort(), permissive: row.permissive, qual: row.qual, withCheck: row.with_check })),
    migrationHistory: {
      count: history.length,
      sha256: checksumRows(history),
      maxId,
      maxCreatedAt: createdValues.at(-1) ?? null,
    },
    sequences,
    acls: {
      schemas: schemaRows.rows.map((row) => ({ schema: row.schema, name: row.name, acl: sortedAcl(row.acl) })),
      relations: relations.rows.map((row) => ({ schema: row.schema, name: row.name, acl: sortedAcl(row.acl) })),
      routines: routines.rows.map((row) => ({ schema: row.schema, name: row.name, identityArguments: row.identity_arguments, acl: sortedAcl(row.acl) })),
      defaults: defaultAcls.rows.map((row) => ({ owner: row.owner, schema: row.schema, objectType: row.object_type, acl: sortedAcl(row.acl) })),
    },
  };
}

export function assertMatchingCatalogSnapshots(
  source: CatalogSnapshot,
  restored: CatalogSnapshot,
  expectedRestoredDatabaseOwner = source.databaseOwner,
): void {
  if (restored.databaseOwner !== expectedRestoredDatabaseOwner) {
    throw new Error(`Restored catalog snapshot differs from source: databaseOwner (expected ${expectedRestoredDatabaseOwner})`);
  }
  const sections: (keyof CatalogSnapshot)[] = [
    "schemas", "relations", "columns", "indexes", "constraints", "triggers",
    "routines", "types", "extensions", "rowSecurity", "policies", "migrationHistory", "sequences", "acls",
  ];
  const mismatches = sections.filter((section) => JSON.stringify(source[section]) !== JSON.stringify(restored[section]));
  if (mismatches.length !== 0) {
    throw new Error(`Restored catalog snapshot differs from source: ${mismatches.join(", ")}`);
  }
}

export function throwAcceptanceErrors(primaryError: unknown, cleanupErrors: unknown[]): void {
  if (primaryError === undefined && cleanupErrors.length === 0) return;
  const errors = primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors];
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "backup RLS acceptance or cleanup failed");
}

export async function verifyBackupRlsAcceptance(): Promise<void> {
  const adminUrl = requiredDatabaseUrl("DATABASE_ADMIN_URL");
  const roleUrls = requiredRoleUrls(adminUrl);
  const sourceDatabaseOwner = decodeURIComponent(new URL(roleUrls.migration).username);
  const restoreName = acceptanceDatabaseName();
  const restoreAdminUrl = retargetDatabaseUrl(adminUrl, restoreName);
  const restoredRoleUrls = retargetRoleDatabaseUrls(roleUrls, restoreName);
  assertSafeAcceptanceDatabase(adminUrl, restoreAdminUrl);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "vocab-backup-acceptance-"));
  const dumpPath = resolve(temporaryRoot, "backup.dump");
  let admin: Client | undefined;
  const clients: Client[] = [];
  let fixture: Fixture | undefined;
  let restoreCreated = false;
  let primaryError: unknown;
  let restoredEvidence: TableEvidence[] | undefined;
  let restoredCatalog: CatalogSnapshot | undefined;

  try {
    admin = await connect(adminUrl);
    fixture = await seedFixture(admin);
    const backup = await connect(roleUrls.backup);
    clients.push(backup);
    await verifyBackupBoundary(backup, fixture);
    const sourceEvidence = await fixtureEvidence(backup, fixture);
    const sourceCatalog = await collectCatalogSnapshot(admin);
    await runPostgres(buildPgDumpInvocation(roleUrls.backup, dumpPath));
    await createAcceptanceDatabase(admin, restoreName);
    restoreCreated = true;
    await runPostgres(buildPgRestoreInvocation(restoredRoleUrls.migration, dumpPath));

    const restoredAdmin = await connect(restoreAdminUrl);
    clients.push(restoredAdmin);
    restoredCatalog = await collectCatalogSnapshot(restoredAdmin);
    assertMatchingCatalogSnapshots(sourceCatalog, restoredCatalog, sourceDatabaseOwner);
    restoredEvidence = await fixtureEvidence(restoredAdmin, fixture);
    assertCompleteEvidence(sourceEvidence, restoredEvidence, fixture);

    const restoredApp = await connect(restoredRoleUrls.app);
    clients.push(restoredApp);
    const restoredWorker = await connect(restoredRoleUrls.worker);
    clients.push(restoredWorker);
    const restoredBackup = await connect(restoredRoleUrls.backup);
    clients.push(restoredBackup);
    const restoredMigration = await connect(restoredRoleUrls.migration);
    clients.push(restoredMigration);
    await verifyApplicationBoundary(restoredApp, fixture);
    await verifyWorkerBoundary(restoredWorker, fixture);
    await verifyBackupBoundary(restoredBackup, fixture);
    await verifyMigrationBoundary(restoredMigration);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const client of clients.reverse()) {
    try {
      await client.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (restoreCreated && admin) {
    try {
      await dropAcceptanceDatabase(admin, adminUrl, restoreAdminUrl);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (admin) {
    try {
      await cleanupFixture(admin, fixture);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  throwAcceptanceErrors(primaryError, cleanupErrors);
  if (!restoredEvidence || !restoredCatalog) throw new Error("Backup acceptance completed without restored evidence");
  console.log(JSON.stringify({
    ok: true,
    backupRole: BACKUP_ROLE,
    bypassRls: true,
    readOnly: true,
    dumpFormat: "postgresql-custom",
    restoreDatabaseGuarded: true,
    restoreOwner: "vocab_migration",
    loginRoles: Object.values(ROLE_URLS).map(([, role]) => role),
    catalogSha256: createHash("sha256").update(JSON.stringify(restoredCatalog)).digest("hex"),
    evidence: restoredEvidence,
  }));
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  verifyBackupRlsAcceptance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
