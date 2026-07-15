import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const COMPOSE_FILE = "compose.database-roles-acceptance.yaml";
const PROJECT_PATTERN = /^vocab-observatory-db-roles-[a-f0-9]{32}$/;
const DATABASE_NAME = "vocab_roles_acceptance";

export interface CommandInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface AcceptanceDependencies {
  uuid?: () => string;
  password?: () => string;
  allocatePort?: () => Promise<number>;
  run?: (invocation: CommandInvocation, signal?: AbortSignal) => Promise<void>;
  onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  offSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
}

export interface AcceptanceResult {
  ok: true;
  project: string;
  host: "127.0.0.1";
  port: number;
  postgres: "17-alpine";
  freshProjectVolume: true;
  cleanupCompleted: true;
}

export function acceptanceProjectName(uuid: string = randomUUID()): string {
  const compact = uuid.replaceAll("-", "").toLowerCase();
  const project = `vocab-observatory-db-roles-${compact}`;
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error("Refusing to use an unguarded Compose project name");
  }
  return project;
}

export function assertGuardedProjectName(project: string): void {
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error("Refusing to manage an unguarded Compose project name");
  }
}

export function acceptancePostgresContainerName(project: string): string {
  assertGuardedProjectName(project);
  return `${project}-postgres-1`;
}

export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.port < 49152) {
        server.close(() => reject(new Error("Unable to allocate a dynamic high loopback port")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function generatedPassword(): string {
  return `P1a2_${randomBytes(18).toString("base64url")}`;
}

function roleUrl(username: string, password: string, port: number): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = username;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${DATABASE_NAME}`;
  return url.toString();
}

export function acceptanceEnvironment(port: number, passwords: readonly string[], project: string): NodeJS.ProcessEnv {
  if (!Number.isInteger(port) || port < 49152 || port > 65535) {
    throw new Error("Acceptance port must be a dynamic high port");
  }
  if (passwords.length !== 5 || new Set(passwords).size !== 5 || passwords.some((value) => value.length < 16)) {
    throw new Error("Acceptance passwords must be five distinct values of at least 16 characters");
  }
  const [admin, app, worker, backup, migration] = passwords;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PG_TOOLS_CONTAINER: acceptancePostgresContainerName(project),
    DATABASE_ROLES_ACCEPTANCE_PORT: String(port),
    DATABASE_ROLES_ADMIN_PASSWORD: admin,
    DATABASE_ADMIN_URL: roleUrl("vocab_roles_admin", admin!, port),
    APP_DATABASE_URL: roleUrl("vocab_app", app!, port),
    WORKER_DATABASE_URL: roleUrl("vocab_worker", worker!, port),
    BACKUP_DATABASE_URL: roleUrl("vocab_backup", backup!, port),
    MIGRATION_DATABASE_URL: roleUrl("vocab_migration", migration!, port),
    DB_SSLMODE: "disable",
    DB_POOL_MAX: "1",
  };
  delete env.COMPOSE_COMPATIBILITY;
  return env;
}

export function acceptanceInvocations(project: string, env: NodeJS.ProcessEnv): CommandInvocation[] {
  assertGuardedProjectName(project);
  const compose = ["compose", "-f", COMPOSE_FILE, "-p", project];
  return [
    { command: "docker", args: [...compose, "up", "-d", "--wait", "postgres"], env },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "prepare"], env },
    { command: "npm", args: ["run", "db:migrate"], env: { ...env, DATABASE_URL: env.MIGRATION_DATABASE_URL } },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "converge"], env },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/verify-database-roles.ts"], env },
    { command: "npm", args: ["exec", "--", "tsx", "scripts/verify-backup-rls-acceptance.ts"], env },
  ];
}

export function cleanupInvocation(project: string, env: NodeJS.ProcessEnv): CommandInvocation {
  assertGuardedProjectName(project);
  return {
    command: "docker",
    args: ["compose", "-f", COMPOSE_FILE, "-p", project, "down", "--volumes", "--remove-orphans"],
    env,
  };
}

export interface SpawnCommand {
  command: string;
  args: string[];
}

export function resolveSpawnCommand(
  invocation: Pick<CommandInvocation, "command" | "args" | "env">,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable: string = process.execPath,
): SpawnCommand {
  if (platform !== "win32" || invocation.command !== "npm") {
    return { command: invocation.command, args: invocation.args };
  }
  const npmExecPath = invocation.env.npm_execpath?.trim();
  if (!npmExecPath || !win32.isAbsolute(npmExecPath) || win32.basename(npmExecPath).toLowerCase() !== "npm-cli.js") {
    throw new Error("Windows npm invocation requires npm_execpath to reference the absolute npm CLI JavaScript file");
  }
  return { command: nodeExecutable, args: [npmExecPath, ...invocation.args] };
}

export async function runCommand(invocation: CommandInvocation, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const executable = resolveSpawnCommand(invocation);
    const child = spawn(executable.command, executable.args, {
      env: invocation.env,
      stdio: "inherit",
      windowsHide: true,
      signal,
    });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${invocation.command} exited with ${exitSignal ?? `code ${String(code)}`}`));
    });
  });
}

export function throwOrchestrationErrors(primaryError: unknown, cleanupError: unknown): void {
  if (primaryError === undefined && cleanupError === undefined) return;
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([primaryError, cleanupError], "database roles acceptance and cleanup failed");
  }
  throw primaryError ?? cleanupError;
}

export async function runDatabaseRolesAcceptance(dependencies: AcceptanceDependencies = {}): Promise<AcceptanceResult> {
  const uuid = dependencies.uuid ?? randomUUID;
  const password = dependencies.password ?? generatedPassword;
  const allocatePort = dependencies.allocatePort ?? allocateLoopbackPort;
  const run = dependencies.run ?? runCommand;
  const onSignal = dependencies.onSignal ?? ((signal, listener) => process.once(signal, listener));
  const offSignal = dependencies.offSignal ?? ((signal, listener) => process.off(signal, listener));
  const project = acceptanceProjectName(uuid());
  const port = await allocatePort();
  const env = acceptanceEnvironment(port, Array.from({ length: 5 }, () => password()), project);
  let interrupted: Error | undefined;
  const abortController = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => (): void => {
    interrupted ??= new Error(`Database roles acceptance interrupted by ${signal}`);
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
    for (const invocation of acceptanceInvocations(project, env)) {
      if (interrupted) throw interrupted;
      await run(invocation, abortController.signal);
    }
    if (interrupted) throw interrupted;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await run(cleanupInvocation(project, env));
    } catch (error) {
      cleanupError = error;
    }
    offSignal("SIGINT", signalListeners.SIGINT);
    offSignal("SIGTERM", signalListeners.SIGTERM);
  }

  throwOrchestrationErrors(primaryError, cleanupError);
  return {
    ok: true,
    project,
    host: "127.0.0.1",
    port,
    postgres: "17-alpine",
    freshProjectVolume: true,
    cleanupCompleted: true,
  };
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  runDatabaseRolesAcceptance()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
