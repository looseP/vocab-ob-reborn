import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");
const diagnosticsRoot = resolve(projectRoot, ".tmp", "local-compose-smoke");
const requiredRunningServices = ["review-outbox-worker", "llm-reservation-reaper"] as const;
const waitTimeoutMs = 180_000;
const pollIntervalMs = 2_000;

export interface ComposeProcess {
  Service?: string;
  State?: string;
  Health?: string;
  ExitCode?: number | string;
}

export interface ServiceStatusResult {
  ok: boolean;
  errors: string[];
}

export function parsePublishedPort(output: string): number {
  const line = output.trim().split(/\r?\n/).find((value) => value.trim().length > 0);
  const match = line?.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error(`Web port must be published only on 127.0.0.1, received: ${output.trim() || "<empty>"}`);
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid published web port: ${match[1]}`);
  return port;
}

export function parseComposePs(output: string): ComposeProcess[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as ComposeProcess | ComposeProcess[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ComposeProcess);
  }
}

export function assessServiceStatuses(processes: ComposeProcess[]): ServiceStatusResult {
  const byService = new Map(processes.map((process) => [process.Service, process]));
  const errors: string[] = [];
  const postgres = byService.get("postgres");
  if (!postgres || postgres.State !== "running" || postgres.Health !== "healthy") {
    errors.push("postgres must be running and healthy");
  }
  const migrate = byService.get("migrate");
  if (!migrate || migrate.State !== "exited" || Number(migrate.ExitCode) !== 0) {
    errors.push("migrate must be exited with code 0");
  }
  const web = byService.get("web");
  if (!web || web.State !== "running" || web.Health !== "healthy") {
    errors.push("web must be running and healthy");
  }
  for (const service of requiredRunningServices) {
    if (byService.get(service)?.State !== "running") errors.push(`${service} must be running`);
  }
  const backup = byService.get("backup-scheduler");
  if (!backup || backup.State !== "running" || backup.Health !== "healthy") {
    errors.push("backup-scheduler must be running and healthy");
  }
  return { ok: errors.length === 0, errors };
}

export function buildCleanupCommand(projectName: string): string[] {
  return ["compose", "-f", "compose.yaml", "-p", projectName, "down", "--volumes", "--remove-orphans"];
}

export function buildProjectResourceFilters(projectName: string): { containers: string[]; volumes: string[] } {
  const label = `label=com.docker.compose.project=${projectName}`;
  return {
    containers: ["ps", "--all", "--quiet", "--filter", label],
    volumes: ["volume", "ls", "--quiet", "--filter", label],
  };
}

export function hasListedResources(output: string): boolean {
  return output.trim().length > 0;
}

export function resolveSmokeImageEnvironment(
  environment: NodeJS.ProcessEnv,
  skipBuild: boolean,
): Record<"APP_IMAGE" | "MIGRATION_IMAGE" | "BACKUP_IMAGE", string> | Record<string, never> {
  if (!skipBuild) return {};
  const imageEnvironment = {} as Record<"APP_IMAGE" | "MIGRATION_IMAGE" | "BACKUP_IMAGE", string>;
  for (const key of ["APP_IMAGE", "MIGRATION_IMAGE", "BACKUP_IMAGE"] as const) {
    const value = environment[key]?.trim();
    if (!value) throw new Error(`${key} is required when LOCAL_COMPOSE_SMOKE_SKIP_BUILD=true`);
    imageEnvironment[key] = value;
  }
  return imageEnvironment;
}

function runDocker(
  args: string[],
  environment: NodeJS.ProcessEnv,
  options: { inherit?: boolean; allowFailure?: boolean } = {},
): SpawnSyncReturns<string> {
  const result = spawnSync("docker", args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${result.status ?? "no status"}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

function delay(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function configuredPort(): number | undefined {
  const value = process.env.APP_PORT?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`APP_PORT must be an integer from 1 to 65535, received: ${value}`);
  return port;
}

async function requireHttpOk(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { redirect: "error", signal: controller.signal });
    if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const projectName = `vocab-ob-smoke-${process.pid}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const skipBuild = process.env.LOCAL_COMPOSE_SMOKE_SKIP_BUILD === "true";
  const imageEnvironment = resolveSmokeImageEnvironment(process.env, skipBuild);
  const appPort = configuredPort() ?? await findAvailablePort();
  const backupDirectory = resolve(projectRoot, ".tmp", projectName, "backups");
  rmSync(diagnosticsRoot, { recursive: true, force: true });
  mkdirSync(backupDirectory, { recursive: true });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "APP_IMAGE",
    "MIGRATION_IMAGE",
    "BACKUP_IMAGE",
    "APP_DATABASE_URL",
    "WORKER_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "DATABASE_URL",
    "APP_ORIGIN",
    "OWNER_API_TOKEN",
    "METRICS_BEARER_TOKEN",
    "LOCAL_OWNER_ID",
    "BACKUP_SIGNING_KEY",
    "BACKUP_DIR",
    "BACKUP_HOST_DIR",
    "COMPOSE_FILE",
    "COMPOSE_PROFILES",
  ]) delete environment[key];
  Object.assign(environment, imageEnvironment, {
    APP_PORT: String(appPort),
    APP_ORIGIN: `http://127.0.0.1:${appPort}`,
    APP_NODE_ENV: "development",
    DB_SSLMODE: "disable",
    DATABASE_URL: "",
    APP_DATABASE_URL: "",
    WORKER_DATABASE_URL: "",
    BACKUP_DATABASE_URL: "",
    MIGRATION_DATABASE_URL: "",
    BACKUP_HOST_DIR: backupDirectory,
  });
  let primaryError: unknown;
  try {
    runDocker([
      "compose",
      "-f",
      "compose.yaml",
      "-p",
      projectName,
      "up",
      "-d",
      ...(skipBuild ? ["--no-build"] : ["--build"]),
    ], environment, { inherit: true });

    const deadline = Date.now() + waitTimeoutMs;
    let status: ServiceStatusResult = { ok: false, errors: ["services have not been inspected"] };
    while (Date.now() < deadline) {
      const ps = runDocker(["compose", "-f", "compose.yaml", "-p", projectName, "ps", "--all", "--format", "json"], environment);
      status = assessServiceStatuses(parseComposePs(ps.stdout));
      if (status.ok) break;
      delay(pollIntervalMs);
    }
    if (!status.ok) throw new Error(`Compose services did not become ready: ${status.errors.join("; ")}`);

    const portResult = runDocker(["compose", "-f", "compose.yaml", "-p", projectName, "port", "web", "3001"], environment);
    const publishedPort = parsePublishedPort(portResult.stdout);
    if (publishedPort !== appPort) throw new Error(`Expected web port ${appPort}, received ${publishedPort}`);

    await requireHttpOk(`http://127.0.0.1:${publishedPort}/healthz`);
    await requireHttpOk(`http://127.0.0.1:${publishedPort}/readyz`);
    console.log(JSON.stringify({ ok: true, projectName, appPort: publishedPort, cleanVolume: true }));
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  } catch (error) {
    primaryError = error;
    mkdirSync(diagnosticsRoot, { recursive: true });
    const logs = runDocker(["compose", "-f", "compose.yaml", "-p", projectName, "logs", "--no-color"], environment, { allowFailure: true });
    const ps = runDocker(["compose", "-f", "compose.yaml", "-p", projectName, "ps", "--all", "--format", "json"], environment, { allowFailure: true });
    writeFileSync(resolve(diagnosticsRoot, "compose.log"), `${logs.stdout}${logs.stderr}`, "utf8");
    writeFileSync(resolve(diagnosticsRoot, "ps.json"), ps.stdout || ps.stderr || "[]\n", "utf8");
    writeFileSync(resolve(diagnosticsRoot, "metadata.json"), `${JSON.stringify({ projectName, appPort, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, "utf8");
    if (logs.stdout) console.error(logs.stdout);
    if (logs.stderr) console.error(logs.stderr);
    throw error;
  } finally {
    const cleanup = runDocker(buildCleanupCommand(projectName), environment, { allowFailure: true, inherit: true });
    const filters = buildProjectResourceFilters(projectName);
    const containers = runDocker(filters.containers, environment, { allowFailure: true });
    const volumes = runDocker(filters.volumes, environment, { allowFailure: true });
    const cleanupErrors: string[] = [];
    if (cleanup.status !== 0) cleanupErrors.push(`Compose cleanup failed with status ${cleanup.status ?? "unknown"}`);
    if (containers.status !== 0 || hasListedResources(containers.stdout)) cleanupErrors.push("Compose smoke containers remain after cleanup");
    if (volumes.status !== 0 || hasListedResources(volumes.stdout)) cleanupErrors.push("Compose smoke volumes remain after cleanup");
    if (cleanupErrors.length > 0 && primaryError === undefined) throw new Error(cleanupErrors.join("; "));
    if (cleanupErrors.length > 0) console.error(cleanupErrors.join("; "));
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) await main();
