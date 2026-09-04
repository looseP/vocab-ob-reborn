import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { postgresClientConfig } from "../src/db/ssl";
import {
  allocateLoopbackPort,
  runCommand,
  throwOrchestrationErrors,
  type CommandInvocation,
  type HighPortAllocationDependencies,
} from "./run-database-roles-acceptance";

const COMPOSE_FILE = "compose.database-roles-acceptance.yaml";
const PROJECT_PATTERN = /^vocab-observatory-existing-volume-[a-f0-9]{32}$/;
const DATABASE_NAME = "vocab_roles_acceptance";
const LEGACY_ADMIN = "vocab";
const LEGACY_PASSWORD = "LegacyVocabAdmin_8wQ4tK";
const CURRENT_MIGRATIONS = resolve(import.meta.dirname, "..", "drizzle-release");

export function authoritativeMigrationCount(): number {
  const journal = JSON.parse(readFileSync(resolve(CURRENT_MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries?: unknown[];
  };
  if (!Array.isArray(journal.entries) || journal.entries.length < 1) {
    throw new Error("Authoritative migration journal is empty or invalid");
  }
  return journal.entries.length;
}

export interface ExistingVolumeUpgradeDependencies {
  uuid?: () => string;
  password?: () => string;
  allocatePort?: () => Promise<number>;
  run?: (invocation: CommandInvocation, signal?: AbortSignal) => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  offSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
}

export function existingVolumeProjectName(uuid: string = randomUUID()): string {
  const project = `vocab-observatory-existing-volume-${uuid.replaceAll("-", "").toLowerCase()}`;
  if (!PROJECT_PATTERN.test(project)) throw new Error("Refusing to use an unguarded existing-volume project name");
  return project;
}

export async function allocateUpgradePort(dependencies: HighPortAllocationDependencies = {}): Promise<number> {
  return allocateLoopbackPort(dependencies);
}

function generatedPassword(): string {
  return `Upgrade_${randomBytes(18).toString("base64url")}`;
}

function connectionUrl(username: string, password: string, port: number): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = username;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${DATABASE_NAME}`;
  return url.toString();
}

export function existingVolumeEnvironment(port: number, passwords: readonly string[]): NodeJS.ProcessEnv {
  if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("Upgrade port must be dynamic and high");
  if (passwords.length !== 4 || new Set(passwords).size !== 4 || passwords.some((value) => value.length < 16)) {
    throw new Error("Upgrade roles require four distinct passwords of at least 16 characters");
  }
  const [app, worker, backup, migration] = passwords;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_ROLES_ACCEPTANCE_PORT: String(port),
    DATABASE_ROLES_ADMIN_USER: LEGACY_ADMIN,
    DATABASE_ROLES_ADMIN_PASSWORD: LEGACY_PASSWORD,
    DATABASE_ADMIN_URL: connectionUrl(LEGACY_ADMIN, LEGACY_PASSWORD, port),
    APP_DATABASE_URL: connectionUrl("vocab_app", app!, port),
    WORKER_DATABASE_URL: connectionUrl("vocab_worker", worker!, port),
    BACKUP_DATABASE_URL: connectionUrl("vocab_backup", backup!, port),
    MIGRATION_DATABASE_URL: connectionUrl("vocab_migration", migration!, port),
    DB_SSLMODE: "disable",
    DB_POOL_MAX: "1",
  };
  delete env.COMPOSE_COMPATIBILITY;
  return env;
}

export function existingVolumeInvocations(project: string, env: NodeJS.ProcessEnv): CommandInvocation[] {
  if (!PROJECT_PATTERN.test(project)) throw new Error("Refusing to manage an unguarded existing-volume project");
  const compose = ["compose", "-f", COMPOSE_FILE, "-p", project];
  return [
    { command: "docker", args: [...compose, "up", "-d", "--wait", "postgres"], env },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/verify-existing-volume-role-upgrade.ts", "legacy"], env },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "prepare"], env },
    { command: "npm", args: ["run", "db:migrate"], env: { ...env, DATABASE_URL: env.MIGRATION_DATABASE_URL } },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "converge"], env },
    { command: "npm", args: ["run", "test:db-roles"], env },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/verify-existing-volume-role-upgrade.ts", "verify"], env },
  ];
}

export function existingVolumeCleanupInvocation(project: string, env: NodeJS.ProcessEnv): CommandInvocation {
  if (!PROJECT_PATTERN.test(project)) throw new Error("Refusing to clean an unguarded existing-volume project");
  return {
    command: "docker",
    args: ["compose", "-f", COMPOSE_FILE, "-p", project, "down", "--volumes", "--remove-orphans"],
    env,
  };
}

function createLegacyMigrationSnapshot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "vocab-existing-volume-"));
  const meta = resolve(root, "meta");
  mkdirSync(meta);
  const journal = JSON.parse(readFileSync(resolve(CURRENT_MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 11);
  for (const entry of journal.entries) {
    const sqlName = `${entry.tag}.sql`;
    cpSync(resolve(CURRENT_MIGRATIONS, sqlName), resolve(root, sqlName));
    const snapshotName = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
    const snapshot = resolve(CURRENT_MIGRATIONS, "meta", snapshotName);
    cpSync(snapshot, resolve(meta, snapshotName));
  }
  writeFileSync(resolve(meta, "_journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  return root;
}

async function createLegacyState(): Promise<void> {
  const pool = new Pool({ ...postgresClientConfig(process.env.DATABASE_ADMIN_URL!), max: 1 });
  const legacyMigrations = createLegacyMigrationSnapshot();
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: legacyMigrations,
      migrationsSchema: "vocab_migrations",
      migrationsTable: "__v2_release_migrations",
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.existing_volume_upgrade_sentinel (
        id integer PRIMARY KEY,
        value text NOT NULL
      );
      INSERT INTO public.existing_volume_upgrade_sentinel (id, value)
      VALUES (1, 'preserve-existing-volume-data')
      ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;
    `);
    const ownership = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND pg_get_userbyid(relation.relowner) = current_user
    `);
    if (!ownership.rows[0] || ownership.rows[0].count < 1) throw new Error("legacy objects were not created by the historical admin");
  } finally {
    await pool.end();
    rmSync(legacyMigrations, { recursive: true, force: true });
  }
}

async function verifyUpgradedState(): Promise<void> {
  const expectedMigrationCount = authoritativeMigrationCount();
  const admin = new Client(postgresClientConfig(process.env.DATABASE_ADMIN_URL!));
  await admin.connect();
  try {
    const result = await admin.query<{
      sentinel: string | null;
      migrationCount: number;
      wrongRelationOwners: number;
      wrongRoutineOwners: number;
      wrongTypeOwners: number;
    }>(`
      SELECT
        (SELECT value FROM public.existing_volume_upgrade_sentinel WHERE id = 1) AS sentinel,
        (SELECT count(*)::int FROM vocab_migrations.__v2_release_migrations) AS "migrationCount",
        (SELECT count(*)::int
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           AND pg_get_userbyid(relation.relowner) <> 'vocab_migration') AS "wrongRelationOwners",
        (SELECT count(*)::int
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dependency
             WHERE dependency.classid = 'pg_proc'::regclass
               AND dependency.objid = routine.oid
               AND dependency.deptype = 'e'
           )
           AND pg_get_userbyid(routine.proowner) <> 'vocab_migration') AS "wrongRoutineOwners",
        (SELECT count(*)::int
         FROM pg_type type
         JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
         LEFT JOIN pg_class relation ON relation.oid = type.typrelid
         WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
           AND (type.typtype IN ('e', 'd') OR (type.typtype = 'c' AND relation.relkind = 'c'))
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dependency
             WHERE dependency.classid = 'pg_type'::regclass
               AND dependency.objid = type.oid
               AND dependency.deptype = 'e'
           )
           AND pg_get_userbyid(type.typowner) <> 'vocab_migration') AS "wrongTypeOwners"
    `);
    const state = result.rows[0];
    if (
      state?.sentinel !== "preserve-existing-volume-data"
      || state.migrationCount !== expectedMigrationCount
      || state.wrongRelationOwners !== 0
      || state.wrongRoutineOwners !== 0
      || state.wrongTypeOwners !== 0
    ) {
      throw new Error(`existing-volume upgrade verification failed: ${JSON.stringify(state)}`);
    }
    console.log(JSON.stringify({ ok: true, existingDataPreserved: true, migrationCount: expectedMigrationCount, ownershipConverged: true }));
  } finally {
    await admin.end();
  }
}

export async function runExistingVolumeRoleUpgrade(dependencies: ExistingVolumeUpgradeDependencies = {}): Promise<void> {
  const project = existingVolumeProjectName((dependencies.uuid ?? randomUUID)());
  const port = await (dependencies.allocatePort ?? allocateUpgradePort)();
  const password = dependencies.password ?? generatedPassword;
  const env = existingVolumeEnvironment(port, Array.from({ length: 4 }, () => password()));
  const run = dependencies.run ?? runCommand;
  const onSignal = dependencies.onSignal ?? ((signal, listener) => process.once(signal, listener));
  const offSignal = dependencies.offSignal ?? ((signal, listener) => process.off(signal, listener));
  let interrupted: Error | undefined;
  const abortController = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => (): void => {
    interrupted ??= new Error(`Existing-volume role upgrade interrupted by ${signal}`);
    abortController.abort(interrupted);
  };
  const signalListeners = {
    SIGINT: interrupt("SIGINT"),
    SIGTERM: interrupt("SIGTERM"),
  } as const;
  onSignal("SIGINT", signalListeners.SIGINT);
  onSignal("SIGTERM", signalListeners.SIGTERM);

  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    for (const invocation of existingVolumeInvocations(project, env)) {
      if (interrupted) throw interrupted;
      await run(invocation, abortController.signal);
    }
    if (interrupted) throw interrupted;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await run(existingVolumeCleanupInvocation(project, env));
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError === undefined && interrupted !== undefined) primaryError = interrupted;
    offSignal("SIGINT", signalListeners.SIGINT);
    offSignal("SIGTERM", signalListeners.SIGTERM);
  }
  throwOrchestrationErrors(primaryError, cleanupError);
}

const mode = process.argv[2];
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  const action = mode === "legacy"
    ? createLegacyState()
    : mode === "verify"
      ? verifyUpgradedState()
      : mode === undefined
        ? runExistingVolumeRoleUpgrade()
        : Promise.reject(new Error("expected legacy, verify, or no mode"));
  action.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
