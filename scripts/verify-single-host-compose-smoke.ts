import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createServer } from "node:net";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const projectRoot = resolve(import.meta.dirname, "..");
const composeFile = "compose.single-host.yaml";
const defaultTimeoutMs = 180_000;
const pollIntervalMs = 2_000;
const secretKeys = [
  "POSTGRES_PASSWORD",
  "OWNER_API_TOKEN",
  "METRICS_BEARER_TOKEN",
  "BACKUP_SIGNING_KEY",
  "LLM_API_KEY",
] as const;
const dockerChildEnvironmentAllowlist = new Set([
  "APPDATA",
  "COMSPEC",
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOCALAPPDATA",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

export interface SingleHostSmokeArgs {
  envFile: string;
  timeoutMs: number;
}

export interface ComposePublisher {
  URL?: string;
  TargetPort?: number | string;
  PublishedPort?: number | string;
  Protocol?: string;
}

export interface ComposeProcess {
  Service?: string;
  State?: string;
  Health?: string;
  ExitCode?: number | string;
  Publishers?: ComposePublisher[] | null;
}

export interface Assessment {
  ok: boolean;
  errors: string[];
}

export interface PublishedSurfaceExpectation {
  httpPort: number;
  httpsPort: number;
}

export interface ProjectResourceFilters {
  containers: string[];
  networks: string[];
  volumes: string[];
}

function isDriveRootedWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) && win32.isAbsolute(path);
}

export function parseSingleHostSmokeArgs(
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SingleHostSmokeArgs {
  if (platform !== "win32") throw new Error("single-host smoke may only run on Windows (win32)");
  let envFile: string | undefined;
  let timeoutMs = defaultTimeoutMs;
  let timeoutSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--env-file" && argument !== "--timeout-ms") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--env-file") {
      if (envFile !== undefined) throw new Error("--env-file may only be provided once");
      if (!isDriveRootedWindowsPath(value)) throw new Error("--env-file must be an absolute drive-rooted Windows path");
      envFile = value;
    } else {
      if (timeoutSeen) throw new Error("--timeout-ms may only be provided once");
      timeoutSeen = true;
      if (!/^[1-9]\d*$/.test(value)) throw new Error("--timeout-ms must be a positive integer");
      timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs)) throw new Error("--timeout-ms must be a positive safe integer");
    }
  }
  if (envFile === undefined) throw new Error("--env-file is required");
  return { envFile, timeoutMs };
}

export function createSingleHostSmokeIdentity(pid: number, uuid: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Smoke PID must be a positive integer");
  const suffix = uuid.replaceAll("-", "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(suffix)) throw new Error("Smoke UUID must provide at least eight hexadecimal characters");
  const name = `vocab-ob-single-host-smoke-${pid}-${suffix}`;
  assertSingleHostSmokeProjectName(name);
  return name;
}

export function assertSingleHostSmokeProjectName(name: string): void {
  if (!/^vocab-ob-single-host-smoke-[1-9]\d*-[0-9a-f]{8}$/.test(name)) {
    throw new Error(`Refusing non-random single-host smoke project: ${name}`);
  }
}

export function buildSingleHostComposeArgs(envFile: string, projectName: string, tail: string[]): string[] {
  if (!isDriveRootedWindowsPath(envFile)) throw new Error("Compose env file must be an absolute drive-rooted Windows path");
  assertSingleHostSmokeProjectName(projectName);
  return ["compose", "--env-file", envFile, "-f", composeFile, "-p", projectName, ...tail];
}

export function parseComposePs(output: string): ComposeProcess[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as ComposeProcess | ComposeProcess[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ComposeProcess);
  }
}

export function assessSingleHostStatuses(processes: ComposeProcess[]): Assessment {
  const byService = new Map(processes.map((process) => [process.Service, process]));
  const errors: string[] = [];
  for (const service of ["postgres", "web", "caddy", "backup-scheduler"] as const) {
    const status = byService.get(service);
    if (!status || status.State !== "running" || status.Health !== "healthy") {
      errors.push(`${service} must be running and healthy`);
    }
  }
  const migrate = byService.get("migrate");
  if (!migrate || migrate.State !== "exited" || Number(migrate.ExitCode) !== 0) {
    errors.push("migrate must be exited with code 0");
  }
  for (const service of ["review-outbox-worker", "llm-reservation-reaper"] as const) {
    if (byService.get(service)?.State !== "running") errors.push(`${service} must be running`);
  }
  return { ok: errors.length === 0, errors };
}

export function parseLoopbackPublishedPort(publisher: ComposePublisher, targetPort: number): number {
  if (publisher.URL !== "127.0.0.1") {
    throw new Error(`Container port ${targetPort} must publish only on IPv4 loopback, received ${publisher.URL ?? "<missing>"}`);
  }
  if (Number(publisher.TargetPort) !== targetPort || publisher.Protocol !== "tcp") {
    throw new Error(`Invalid publisher for container port ${targetPort}`);
  }
  const publishedPort = Number(publisher.PublishedPort);
  if (!Number.isInteger(publishedPort) || publishedPort < 1_024 || publishedPort > 65_535) {
    throw new Error(`Container port ${targetPort} must use a high host port`);
  }
  return publishedPort;
}

export function assessPublishedSurface(
  processes: ComposeProcess[],
  expected: PublishedSurfaceExpectation,
): Assessment {
  const errors: string[] = [];
  for (const process of processes) {
    const publishers = process.Publishers ?? [];
    if (process.Service !== "caddy" && publishers.length > 0) {
      errors.push(`${process.Service ?? "unknown service"} must not publish host ports`);
    }
  }
  const caddy = processes.find((process) => process.Service === "caddy");
  const publishers = caddy?.Publishers ?? [];
  if (publishers.length !== 2) errors.push("caddy must publish exactly container ports 80 and 443");
  for (const [targetPort, expectedHostPort] of [[80, expected.httpPort], [443, expected.httpsPort]] as const) {
    const publisher = publishers.find((candidate) => Number(candidate.TargetPort) === targetPort);
    try {
      if (!publisher) throw new Error(`caddy container port ${targetPort} is not published`);
      const actualHostPort = parseLoopbackPublishedPort(publisher, targetPort);
      if (actualHostPort !== expectedHostPort) {
        throw new Error(`caddy container port ${targetPort} expected host port ${expectedHostPort}, received ${actualHostPort}`);
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function redactDiagnostics(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), text);
}

export function buildDockerChildEnvironment(
  ambientEnvironment: NodeJS.ProcessEnv,
  smokeOverrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambientEnvironment)) {
    if (dockerChildEnvironmentAllowlist.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  }
  return Object.assign(environment, smokeOverrides);
}

export function throwIfSingleHostSmokeInterrupted(signal: NodeJS.Signals | undefined): void {
  if (signal !== undefined) throw new Error(`Interrupted by ${signal}`);
}

export function buildSingleHostCleanupArgs(envFile: string, projectName: string): string[] {
  assertSingleHostSmokeProjectName(projectName);
  return buildSingleHostComposeArgs(envFile, projectName, ["down", "--volumes", "--remove-orphans"]);
}

export function buildSingleHostProjectResourceFilters(projectName: string): ProjectResourceFilters {
  assertSingleHostSmokeProjectName(projectName);
  const label = `label=com.docker.compose.project=${projectName}`;
  return {
    containers: ["ps", "--all", "--quiet", "--filter", label],
    networks: ["network", "ls", "--quiet", "--filter", label],
    volumes: ["volume", "ls", "--quiet", "--filter", label],
  };
}

export function combineSmokeErrors(primaryError: unknown, cleanupError: unknown): Error | undefined {
  if (primaryError === undefined && cleanupError === undefined) return undefined;
  if (primaryError === undefined) return new Error(`Cleanup failed: ${errorMessage(cleanupError)}`);
  if (cleanupError === undefined) return new Error(errorMessage(primaryError));
  return new Error(`Smoke failed: ${errorMessage(primaryError)}\nCleanup also failed: ${errorMessage(cleanupError)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runDocker(
  args: string[],
  environment: NodeJS.ProcessEnv,
  secrets: readonly string[],
  allowFailure = false,
): SpawnSyncReturns<string> {
  const result = spawnSync("docker", args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
    stdio: "pipe",
  });
  if (result.error) {
    if (!allowFailure) throw result.error;
    return result;
  }
  if (!allowFailure && result.status !== 0) {
    const output = redactDiagnostics(`${result.stderr}${result.stdout}`, secrets).trim();
    throw new Error(`docker ${args.join(" ")} failed (${result.status ?? "no status"})${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function delay(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function findAvailableHighPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.port < 1_024) {
        server.close();
        reject(new Error("Could not allocate a high IPv4 loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

export function buildSecureEndpointRequestOptions(
  port: number,
  ca: Buffer,
  path: string,
): RequestOptions {
  return {
    host: "127.0.0.1",
    port,
    path,
    method: "GET",
    servername: "localhost",
    ca,
    rejectUnauthorized: true,
  };
}

async function requireSecureEndpoint(port: number, ca: Buffer, path: string): Promise<void> {
  await new Promise<void>((resolveRequest, reject) => {
    const clientRequest = httpsRequest(buildSecureEndpointRequestOptions(port, ca, path), (response) => {
      response.resume();
      const hsts = response.headers["strict-transport-security"];
      const contentTypeOptions = response.headers["x-content-type-options"];
      if (response.statusCode !== 200) {
        reject(new Error(`${path} returned HTTPS ${response.statusCode ?? "unknown"}`));
      } else if (typeof hsts !== "string" || !hsts.includes("max-age=")) {
        reject(new Error(`${path} is missing Strict-Transport-Security`));
      } else if (contentTypeOptions !== "nosniff") {
        reject(new Error(`${path} is missing X-Content-Type-Options: nosniff`));
      } else {
        resolveRequest();
      }
    });
    const requestTimeout = setTimeout(() => clientRequest.destroy(new Error(`${path} request timed out`)), 5_000);
    clientRequest.once("error", reject);
    clientRequest.once("close", () => clearTimeout(requestTimeout));
    clientRequest.end();
  });
}

function relativeDockerCopyTarget(absolutePath: string): string {
  const target = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!target || target.startsWith("../") || isAbsolute(target)) throw new Error("CA target must remain under the checkout");
  return `./${target}`;
}

function cleanupFailureGuidance(projectName: string): string {
  return [
    `Temporary smoke project may remain: ${projectName}`,
    `Read-only diagnosis: docker ps -a --filter label=com.docker.compose.project=${projectName}`,
    `Read-only diagnosis: docker network ls --filter label=com.docker.compose.project=${projectName}`,
    `Read-only diagnosis: docker volume ls --filter label=com.docker.compose.project=${projectName}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const parsedArgs = parseSingleHostSmokeArgs(process.argv.slice(2));
  const envStat = statSync(parsedArgs.envFile);
  if (!envStat.isFile()) throw new Error("--env-file must reference an existing regular file");

  const projectName = createSingleHostSmokeIdentity(process.pid, randomUUID());
  const runId = projectName.slice("vocab-ob-single-host-smoke-".length);
  const runDirectory = resolve(projectRoot, ".tmp", "single-host-compose-smoke", runId);
  const backupDirectory = resolve(runDirectory, "backups");
  const caFile = resolve(runDirectory, "caddy-local-root.crt");
  mkdirSync(backupDirectory, { recursive: true });

  const parsedEnvironment = parseDotenv(readFileSync(parsedArgs.envFile, "utf8"));
  const secrets = secretKeys.map((key) => parsedEnvironment[key]?.trim() ?? "").filter(Boolean);

  const httpPort = await findAvailableHighPort();
  let httpsPort = await findAvailableHighPort();
  while (httpsPort === httpPort) httpsPort = await findAvailableHighPort();
  const environment = buildDockerChildEnvironment(process.env, {
    CADDY_HTTP_HOST_PORT: String(httpPort),
    CADDY_HTTPS_HOST_PORT: String(httpsPort),
    CADDY_HTTP_BIND_ADDRESS: "127.0.0.1",
    CADDY_HTTPS_BIND_ADDRESS: "127.0.0.1",
    APP_ORIGIN: `https://localhost:${httpsPort}`,
    CADDY_SITE_ADDRESS: "localhost",
    CADDY_CONFIG_FILE: resolve(projectRoot, "Caddyfile").replaceAll("\\", "/"),
    BACKUP_HOST_DIR: backupDirectory.replaceAll("\\", "/"),
    BACKUP_RUNTIME_USER: "node",
  });

  let dockerVersion = "not checked";
  let composeVersion = "not checked";
  let phase = "preflight";
  let primaryError: unknown;
  let cleanupError: unknown;
  let latestPs = "[]\n";
  let failureLogs = "";
  let interruptedSignal: NodeJS.Signals | undefined;
  let cleanupResult: unknown;
  let cleanupStarted = false;

  const cleanup = (): unknown => {
    if (cleanupStarted) return cleanupResult;
    cleanupStarted = true;
    try {
      const down = runDocker(buildSingleHostCleanupArgs(parsedArgs.envFile, projectName), environment, secrets, true);
      const filters = buildSingleHostProjectResourceFilters(projectName);
      const remnants: string[] = [];
      if (down.error) remnants.push(`docker compose down failed to start: ${errorMessage(down.error)}`);
      else if (down.status !== 0) remnants.push(`docker compose down failed (${down.status ?? "no status"}): ${redactDiagnostics(`${down.stderr}${down.stdout}`, secrets).trim()}`);
      for (const [kind, args] of Object.entries(filters)) {
        const result = runDocker(args, environment, secrets, true);
        if (result.error) remnants.push(`${kind} label check failed to start: ${errorMessage(result.error)}`);
        else if (result.status !== 0) remnants.push(`${kind} label check failed (${result.status ?? "no status"})`);
        else if (result.stdout.trim()) remnants.push(`${kind} remain: ${result.stdout.trim().split(/\r?\n/).join(", ")}`);
      }
      cleanupResult = remnants.length > 0 ? new Error(remnants.join("; ")) : undefined;
    } catch (error) {
      cleanupResult = error;
    }
    return cleanupResult;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal;
    console.error(redactDiagnostics(`Received ${signal}; temporary project ${projectName} will be cleaned in finally.`, secrets));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const throwIfInterrupted = (): void => throwIfSingleHostSmokeInterrupted(interruptedSignal);

  try {
    throwIfInterrupted();
    const serverOs = runDocker(["version", "--format", "{{.Server.Os}}"], environment, secrets);
    throwIfInterrupted();
    const serverOperatingSystem = serverOs.stdout.trim();
    if (serverOperatingSystem.toLowerCase() !== "linux") throw new Error(`Docker server OS must be linux, received ${serverOperatingSystem || "<empty>"}`);
    const serverVersion = runDocker(["version", "--format", "{{.Server.Version}}"], environment, secrets);
    dockerVersion = `${serverVersion.stdout.trim()} (${serverOperatingSystem})`;
    const compose = runDocker(["compose", "version"], environment, secrets);
    composeVersion = compose.stdout.trim() || compose.stderr.trim();
    runDocker(buildSingleHostComposeArgs(parsedArgs.envFile, projectName, ["config", "--quiet"]), environment, secrets);
    throwIfInterrupted();

    phase = "starting";
    runDocker(buildSingleHostComposeArgs(parsedArgs.envFile, projectName, ["up", "-d"]), environment, secrets);
    throwIfInterrupted();
    phase = "waiting";
    const deadline = Date.now() + parsedArgs.timeoutMs;
    let assessment: Assessment = { ok: false, errors: ["services have not been inspected"] };
    while (Date.now() < deadline) {
      if (interruptedSignal) throw new Error(`Interrupted by ${interruptedSignal}`);
      const ps = runDocker(buildSingleHostComposeArgs(parsedArgs.envFile, projectName, ["ps", "--all", "--format", "json"]), environment, secrets);
      latestPs = ps.stdout || "[]\n";
      const processes = parseComposePs(latestPs);
      const statuses = assessSingleHostStatuses(processes);
      const surface = assessPublishedSurface(processes, { httpPort, httpsPort });
      assessment = { ok: statuses.ok && surface.ok, errors: [...statuses.errors, ...surface.errors] };
      if (assessment.ok) break;
      delay(pollIntervalMs);
    }
    if (!assessment.ok) throw new Error(`Compose services did not become ready: ${assessment.errors.join("; ")}`);

    phase = "copying-ca";
    const copyTarget = relativeDockerCopyTarget(caFile);
    let copyError = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      throwIfInterrupted();
      const copy = runDocker(buildSingleHostComposeArgs(parsedArgs.envFile, projectName, ["cp", "caddy:/data/caddy/pki/authorities/local/root.crt", copyTarget]), environment, secrets, true);
      throwIfInterrupted();
      if (copy.status === 0) {
        copyError = "";
        break;
      }
      copyError = redactDiagnostics(`${copy.stderr}${copy.stdout}`, secrets).trim();
      delay(1_000);
    }
    throwIfInterrupted();
    if (copyError) throw new Error(`Could not copy Caddy local CA: ${copyError}`);

    phase = "https";
    const ca = readFileSync(caFile);
    throwIfInterrupted();
    await requireSecureEndpoint(httpsPort, ca, "/healthz");
    throwIfInterrupted();
    await requireSecureEndpoint(httpsPort, ca, "/readyz");
    throwIfInterrupted();
    phase = "complete";
  } catch (error) {
    primaryError = error;
    const logs = runDocker(buildSingleHostComposeArgs(parsedArgs.envFile, projectName, ["logs", "--no-color"]), environment, secrets, true);
    failureLogs = `${logs.stdout}${logs.stderr}`;
    const ps = runDocker(buildSingleHostComposeArgs(parsedArgs.envFile, projectName, ["ps", "--all", "--format", "json"]), environment, secrets, true);
    latestPs = ps.stdout || ps.stderr || latestPs;
  } finally {
    cleanupError = cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (interruptedSignal !== undefined && primaryError === undefined) {
    primaryError = new Error(`Interrupted by ${interruptedSignal}`);
  }
  const combinedError = combineSmokeErrors(primaryError, cleanupError);
  if (combinedError) {
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(resolve(runDirectory, "compose.log"), redactDiagnostics(failureLogs, secrets), "utf8");
    writeFileSync(resolve(runDirectory, "ps.json"), redactDiagnostics(latestPs, secrets), "utf8");
    writeFileSync(resolve(runDirectory, "metadata.json"), `${JSON.stringify({
      phase,
      projectName,
      ports: { http: httpPort, https: httpsPort },
      dockerVersion,
      composeVersion,
      primaryError: primaryError === undefined ? null : redactDiagnostics(errorMessage(primaryError), secrets),
      cleanupError: cleanupError === undefined ? null : redactDiagnostics(errorMessage(cleanupError), secrets),
    }, null, 2)}\n`, "utf8");
    const message = redactDiagnostics(combinedError.message, secrets);
    console.error(message);
    if (cleanupError !== undefined || interruptedSignal !== undefined) console.error(cleanupFailureGuidance(projectName));
    process.exitCode = 1;
    return;
  }

  if (runDirectory !== resolve(projectRoot, ".tmp", "single-host-compose-smoke", runId)) {
    throw new Error("Refusing to remove an unexpected smoke diagnostics directory");
  }
  rmSync(runDirectory, { recursive: true, force: true, maxRetries: 2 });
  console.log(JSON.stringify({ ok: true, projectName, ports: { http: httpPort, https: httpsPort }, tls: "verified-with-temporary-caddy-ca", cleanup: "complete" }));
}

const isDirectExecution = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) await main();
