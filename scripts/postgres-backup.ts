import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Client } from "pg";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export interface BackupManifest {
  version: 1 | 2;
  createdAt: string;
  database: string;
  format: "postgresql-custom";
  dumpFile: string;
  bytes: number;
  sha256: string;
  pgDumpVersion: string;
  schemaEvidence: {
    migrationCount: number;
    tableCount: number;
    functionCount: number;
  };
  hmac?: string;
}

export function databaseName(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name) throw new Error("Database URL must include a database name");
  return name;
}

export function assertSafeDrillTarget(sourceUrl: string, targetUrl: string): void {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  const sourceIdentity = `${source.hostname.toLowerCase()}:${source.port || "5432"}/${databaseName(sourceUrl)}`;
  const targetIdentity = `${target.hostname.toLowerCase()}:${target.port || "5432"}/${databaseName(targetUrl)}`;
  if (sourceIdentity === targetIdentity) {
    throw new Error("DRILL_DATABASE_URL must not identify the source database");
  }
  const targetName = databaseName(targetUrl);
  if (!/(?:_drill|_restore|_test)$/i.test(targetName)) {
    throw new Error("Drill database name must end with _drill, _restore, or _test");
  }
  if (process.env.ALLOW_DESTRUCTIVE_RESTORE !== targetIdentity) {
    throw new Error(`Set ALLOW_DESTRUCTIVE_RESTORE=${targetIdentity} to confirm the isolated target`);
  }
}

export function postgresEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG")) delete env[key];
  }
  Object.assign(env, {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: databaseName(databaseUrl),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  });
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function signManifest(manifest: BackupManifest, key: string): string {
  const payload = JSON.stringify({ ...manifest, hmac: undefined });
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function verifyManifestSignature(manifest: BackupManifest, key: string): boolean {
  if (!manifest.hmac) return false;
  const expected = signManifest({ ...manifest, hmac: undefined }, key);
  const a = Buffer.from(manifest.hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function lockBackup(dumpPath: string, manifestPath: string): void {
  chmodSync(dumpPath, 0o400);
  chmodSync(manifestPath, 0o400);
}

export async function verifyManifest(manifestPath: string, signingKey?: string): Promise<BackupManifest> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if ((manifest.version !== 1 && manifest.version !== 2) || manifest.format !== "postgresql-custom") {
    throw new Error("Unsupported backup manifest");
  }
  if (
    !manifest.database
    || !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes <= 0
    || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !manifest.pgDumpVersion
    || !Number.isSafeInteger(manifest.schemaEvidence?.migrationCount)
    || !Number.isSafeInteger(manifest.schemaEvidence?.tableCount)
    || !Number.isSafeInteger(manifest.schemaEvidence?.functionCount)
  ) {
    throw new Error("Backup manifest is incomplete or invalid");
  }
  if (manifest.dumpFile !== basename(manifest.dumpFile) || manifest.dumpFile.includes("/") || manifest.dumpFile.includes("\\")) {
    throw new Error("Backup manifest dumpFile must be a local file name");
  }
  const baseDir = resolve(dirname(manifestPath));
  const dumpPath = resolve(baseDir, manifest.dumpFile);
  if (!dumpPath.startsWith(`${baseDir}${sep}`)) throw new Error("Backup path escapes the manifest directory");
  if (!existsSync(dumpPath)) throw new Error(`Backup file is missing: ${manifest.dumpFile}`);
  const fileInfo = lstatSync(dumpPath);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Backup must be a regular file");
  const stat = statSync(dumpPath);
  if (stat.size !== manifest.bytes) throw new Error("Backup size does not match manifest");
  const actualHash = await sha256File(dumpPath);
  if (actualHash !== manifest.sha256) throw new Error("Backup SHA-256 does not match manifest");
  if (signingKey) {
    if (manifest.version < 2 || !manifest.hmac) {
      throw new Error("Manifest is not signed but a signing key was provided");
    }
    if (!verifyManifestSignature(manifest, signingKey)) {
      throw new Error("Backup manifest HMAC signature is invalid");
    }
  }
  return manifest;
}

function binary(name: string): string {
  const directory = process.env.PG_BIN_DIR;
  if (!directory) return name;
  return join(directory, process.platform === "win32" ? `${name}.exe` : name);
}

async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else reject(new Error(`${basename(command)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeFileSlug(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 48) || "database";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

async function schemaEvidence(databaseUrl: string): Promise<BackupManifest["schemaEvidence"]> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query<{
      migration_count: number;
      table_count: number;
      function_count: number;
    }>(`SELECT
      (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migration_count,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS table_count,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS function_count`);
    const row = result.rows[0];
    if (!row) throw new Error("Unable to collect backup schema evidence");
    return {
      migrationCount: Number(row.migration_count),
      tableCount: Number(row.table_count),
      functionCount: Number(row.function_count),
    };
  } finally {
    await client.end();
  }
}

async function assertEmptyDrillDatabase(targetUrl: string): Promise<void> {
  const client = new Client({ connectionString: targetUrl });
  try {
    await client.connect();
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')",
    );
    if (Number(result.rows[0]?.count ?? 0) !== 0) {
      throw new Error("Drill target must be empty before restore");
    }
  } finally {
    await client.end();
  }
}

export async function createBackup(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required");
  const backupDir = resolve(process.env.BACKUP_DIR ?? "backups");
  mkdirSync(backupDir, { recursive: true });

  const name = databaseName(sourceUrl);
  const base = `${safeFileSlug(name)}-${timestampForFile()}-${randomUUID()}`;
  const dumpPath = join(backupDir, `${base}.dump`);
  const temporaryDumpPath = `${dumpPath}.partial`;
  const manifestPath = join(backupDir, `${base}.manifest.json`);
  const env = postgresEnvironment(sourceUrl);

  const pgDumpVersion = await run(binary("pg_dump"), ["--version"], { capture: true });
  await run(binary("pg_dump"), [
    "--format=custom",
    "--compress=6",
    "--no-owner",
    "--no-privileges",
    "--file", temporaryDumpPath,
  ], { env });
  renameSync(temporaryDumpPath, dumpPath);

  const manifest: BackupManifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    database: name,
    format: "postgresql-custom",
    dumpFile: basename(dumpPath),
    bytes: statSync(dumpPath).size,
    sha256: await sha256File(dumpPath),
    pgDumpVersion,
    schemaEvidence: await schemaEvidence(sourceUrl),
  };

  const signingKey = process.env.BACKUP_SIGNING_KEY;
  if (signingKey) {
    manifest.hmac = signManifest(manifest, signingKey);
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await verifyManifest(manifestPath, signingKey);

  // Object lock: make dump and manifest read-only after verification
  if (process.env.BACKUP_OBJECT_LOCK !== "false") {
    lockBackup(dumpPath, manifestPath);
  }

  console.log(JSON.stringify({ ok: true, manifest: manifestPath, bytes: manifest.bytes, sha256: manifest.sha256, signed: !!signingKey }));
}

async function restoreDrill(manifestPath: string): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  const targetUrl = process.env.DRILL_DATABASE_URL;
  if (!sourceUrl || !targetUrl) throw new Error("DATABASE_URL and DRILL_DATABASE_URL are required");
  assertSafeDrillTarget(sourceUrl, targetUrl);
  const manifest = await verifyManifest(resolve(manifestPath), process.env.BACKUP_SIGNING_KEY);
  if (manifest.database !== databaseName(sourceUrl)) {
    throw new Error("Backup manifest database does not match DATABASE_URL");
  }
  await assertEmptyDrillDatabase(targetUrl);
  const dumpPath = resolve(dirname(manifestPath), manifest.dumpFile);

  await run(binary("pg_restore"), [
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    "--jobs", process.env.PG_RESTORE_JOBS ?? "2",
    dumpPath,
  ], { env: postgresEnvironment(targetUrl) });

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["run", "test:db-release"], {
    env: { ...process.env, DATABASE_URL: targetUrl, TEST_DATABASE_URL: targetUrl },
  });
  const restoredEvidence = await schemaEvidence(targetUrl);
  if (JSON.stringify(restoredEvidence) !== JSON.stringify(manifest.schemaEvidence)) {
    throw new Error("Restored schema evidence does not match backup manifest");
  }
  console.log(JSON.stringify({
    ok: true,
    restoredDatabase: databaseName(targetUrl),
    manifest: resolve(manifestPath),
    schemaEvidence: restoredEvidence,
  }));
}

function usage(): never {
  throw new Error("Usage: postgres-backup.ts <create|verify|restore-drill> [manifest.json]");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const manifest = process.argv[3];
  if (command === "create") return createBackup();
  if (command === "verify" && manifest) {
    const verified = await verifyManifest(resolve(manifest), process.env.BACKUP_SIGNING_KEY);
    console.log(JSON.stringify({ ok: true, manifest: resolve(manifest), bytes: verified.bytes, sha256: verified.sha256, signed: !!verified.hmac }));
    return;
  }
  if (command === "restore-drill" && manifest) return restoreDrill(resolve(manifest));
  usage();
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
