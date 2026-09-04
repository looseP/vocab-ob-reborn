import { spawn } from "node:child_process";
import { Client } from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postgresClientConfig } from "../src/db/ssl";
import { resolveSpawnCommand } from "./run-database-roles-acceptance";

const projectRoot = resolve(import.meta.dirname, "..");
const defaultImage = "vocab-observatory-v2-backup:ci";
const drillSuffix = "_backup_drill";

interface DrillConfiguration {
  databaseName: string;
  sourceUrl: string;
  restoreUrl: string;
  verificationUrl: string;
  destructiveConfirmation: string;
}

function requiredUrl(environment: NodeJS.ProcessEnv, name: string): URL {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:") || !url.hostname || !url.pathname.slice(1)) {
    throw new Error(`${name} must be a PostgreSQL URL with host and database name`);
  }
  return url;
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.slice(1));
}

function databaseIdentity(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${databaseName(url)}`;
}

function isLoopbackHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function withDatabase(url: URL, name: string): string {
  const copy = new URL(url);
  copy.pathname = `/${encodeURIComponent(name)}`;
  return copy.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function resolveBackupContainerDrillConfiguration(environment: NodeJS.ProcessEnv): DrillConfiguration {
  const admin = requiredUrl(environment, "DATABASE_ADMIN_URL");
  const backup = requiredUrl(environment, "BACKUP_DATABASE_URL");
  const migration = requiredUrl(environment, "MIGRATION_DATABASE_URL");
  const sourceName = databaseName(admin);
  const sourceIdentity = databaseIdentity(admin);
  if (databaseIdentity(backup) !== sourceIdentity || databaseIdentity(migration) !== sourceIdentity) {
    throw new Error("DATABASE_ADMIN_URL, BACKUP_DATABASE_URL, and MIGRATION_DATABASE_URL must target the same PostgreSQL endpoint and source database");
  }
  if (!isLoopbackHost(admin)) {
    throw new Error("Backup container restore acceptance requires a loopback PostgreSQL endpoint");
  }
  if (decodeURIComponent(backup.username) !== "vocab_backup") {
    throw new Error("BACKUP_DATABASE_URL must use vocab_backup");
  }
  if (decodeURIComponent(migration.username) !== "vocab_migration") {
    throw new Error("MIGRATION_DATABASE_URL must use vocab_migration");
  }
  if (decodeURIComponent(admin.username) === decodeURIComponent(migration.username)) {
    throw new Error("DATABASE_ADMIN_URL must use a distinct verification identity");
  }
  const drillName = `${sourceName}${drillSuffix}`;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(drillName)) {
    throw new Error("Derived drill database name is not a safe PostgreSQL identifier");
  }
  const containerBackup = new URL(backup);
  const containerMigration = new URL(migration);
  containerBackup.hostname = "host.docker.internal";
  containerMigration.hostname = "host.docker.internal";
  const restoreUrl = new URL(withDatabase(containerMigration, drillName));
  return {
    databaseName: drillName,
    sourceUrl: containerBackup.toString(),
    restoreUrl: restoreUrl.toString(),
    verificationUrl: withDatabase(admin, drillName),
    destructiveConfirmation: databaseIdentity(restoreUrl),
  };
}

export function buildBackupContainerRestoreArguments(image: string): string[] {
  return [
    "run",
    "--rm",
    "--add-host", "host.docker.internal:host-gateway",
    "--read-only",
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=1777",
    "--tmpfs", "/backups:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=0700",
    "--env", "DATABASE_URL",
    "--env", "DRILL_DATABASE_URL",
    "--env", "ALLOW_DESTRUCTIVE_RESTORE",
    "--env", "BACKUP_SIGNING_KEY",
    "--env", "BACKUP_DIR=/backups",
    "--env", "BACKUP_OBJECT_LOCK=true",
    "--env", "DB_SSLMODE=disable",
    "--env", "PG_RESTORE_JOBS=2",
    "--env", "npm_config_cache=/tmp/npm-cache",
    "--entrypoint", "/bin/sh",
    image,
    "-ceu",
    [
      "./node_modules/.bin/tsx scripts/postgres-backup.ts create",
      "set -- /backups/*.manifest.json",
      "test \"$#\" -eq 1",
      "test -f \"$1\"",
      "./node_modules/.bin/tsx scripts/postgres-backup.ts verify \"$1\"",
      "./node_modules/.bin/tsx scripts/postgres-backup.ts restore-only \"$1\"",
    ].join("\n"),
  ];
}

interface SignalState {
  signal?: NodeJS.Signals;
}

function installSignalHandlers(state: SignalState, abortController: AbortController): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      state.signal ??= signal;
      abortController.abort();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

async function runCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  failureMessage: string,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
      signal,
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code, childSignal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${failureMessage} with status ${code ?? childSignal ?? "unknown"}`));
    });
  });
}

const CHILD_PROCESS_PASSTHROUGH = [
  "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP",
  "HOME", "USERPROFILE", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DB_SSLMODE", "DB_SSLROOTCERT",
] as const;

function isolatedChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const name of CHILD_PROCESS_PASSTHROUGH) {
    const value = environment[name];
    if (value !== undefined) isolated[name] = value;
  }
  return isolated;
}

export function containerRestoreEnvironment(
  environment: NodeJS.ProcessEnv,
  configuration: Pick<DrillConfiguration, "sourceUrl" | "restoreUrl" | "destructiveConfirmation">,
  signingKey: string,
): NodeJS.ProcessEnv {
  return {
    ...isolatedChildEnvironment(environment),
    DATABASE_URL: configuration.sourceUrl,
    DRILL_DATABASE_URL: configuration.restoreUrl,
    ALLOW_DESTRUCTIVE_RESTORE: configuration.destructiveConfirmation,
    BACKUP_SIGNING_KEY: signingKey,
  };
}

export function hostVerificationEnvironment(environment: NodeJS.ProcessEnv, verificationUrl: string): NodeJS.ProcessEnv {
  return {
    ...isolatedChildEnvironment(environment),
    DATABASE_URL: verificationUrl,
    TEST_DATABASE_URL: verificationUrl,
  };
}

async function createDrillDatabase(client: Client, name: string): Promise<void> {
  const existing = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [name],
  );
  if (existing.rows[0]?.exists) throw new Error(`Drill database already exists: ${name}`);
  await client.query(`CREATE DATABASE ${quoteIdentifier(name)} OWNER vocab_migration`);
}

async function dropDrillDatabase(client: Client, name: string): Promise<void> {
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [name],
  );
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

async function main(): Promise<void> {
  const signingKey = process.env.BACKUP_SIGNING_KEY?.trim();
  if (!signingKey || signingKey.length < 24) {
    throw new Error("BACKUP_SIGNING_KEY must contain at least 24 characters");
  }
  const configuration = resolveBackupContainerDrillConfiguration(process.env);
  const image = process.env.BACKUP_IMAGE?.trim() || defaultImage;
  const admin = new Client(postgresClientConfig(process.env.DATABASE_ADMIN_URL!));
  const abortController = new AbortController();
  const signalState: SignalState = {};
  const removeSignalHandlers = installSignalHandlers(signalState, abortController);
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let connected = false;
  let drillCreated = false;
  try {
    await admin.connect();
    connected = true;
    abortController.signal.throwIfAborted();
    await createDrillDatabase(admin, configuration.databaseName);
    drillCreated = true;
    await runCommand(
      "docker",
      buildBackupContainerRestoreArguments(image),
      containerRestoreEnvironment(process.env, configuration, signingKey),
      "backup container restore drill failed",
      abortController.signal,
    );
    const verificationEnvironment = hostVerificationEnvironment(process.env, configuration.verificationUrl);
    const npm = resolveSpawnCommand({ command: "npm", args: ["run", "test:db-release"], env: process.env });
    await runCommand(
      npm.command,
      npm.args,
      verificationEnvironment,
      "host release verification failed",
      abortController.signal,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (drillCreated) {
      try {
        await dropDrillDatabase(admin, configuration.databaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (connected) {
      try {
        await admin.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    removeSignalHandlers();
  }
  if (cleanupErrors.length > 0) {
    const errors = primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "backup container restore drill or cleanup failed");
  }
  if (signalState.signal) {
    process.exitCode = signalState.signal === "SIGINT" ? 130 : 143;
    return;
  }
  if (primaryError !== undefined) throw primaryError;
  console.log(JSON.stringify({ ok: true, image, restoredDatabase: configuration.databaseName, cleanedUp: true }));
}

const isDirectExecution = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
