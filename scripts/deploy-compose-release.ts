import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type DeployEnvironment = "staging" | "production";
export type Command = { binary: string; args: string[]; phase: "pull" | "migration" | "rollout" | "smoke" };
export type DeploymentEvidence = { environment: DeployEnvironment; manifestSha256: string; phase: Command["phase"]; success: boolean; timestamp: string };
export type DeploymentEvidenceSummary = { schemaVersion: 1; environment: DeployEnvironment; manifestSha256: string; phases: Array<{ phase: Command["phase"]; success: boolean; timestamp: string }> };
const DEPLOYMENT_PHASES = ["pull", "migration", "rollout", "smoke"] as const;

type ReleaseManifest = {
  images?: Record<string, { reference?: unknown }>;
};

const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
const IMAGE_KEYS = ["runtime", "migration", "backup"] as const;

function requiredArgument(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args[index + 1]!.startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1]!;
}

export function readDeploymentImages(manifestPath: string): Record<(typeof IMAGE_KEYS)[number], string> {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  const actualKeys = Object.keys(parsed.images ?? {}).sort();
  if (actualKeys.length !== IMAGE_KEYS.length || actualKeys.some((key, index) => key !== [...IMAGE_KEYS].sort()[index])) {
    throw new Error("Manifest images must contain exactly runtime, migration, and backup");
  }
  const images = {} as Record<(typeof IMAGE_KEYS)[number], string>;
  for (const key of IMAGE_KEYS) {
    const reference = parsed.images?.[key]?.reference;
    if (typeof reference !== "string" || !IMMUTABLE_IMAGE.test(reference)) {
      throw new Error(`Manifest image ${key} must be an immutable registry reference ending in @sha256`);
    }
    images[key] = reference;
  }
  return images;
}

export function buildDeploymentCommands(deployEnvFile: string, imageEnvFile: string): Command[] {
  const compose = ["compose", "-f", "compose.production.yaml", "--env-file", deployEnvFile, "--env-file", imageEnvFile];
  return [
    { binary: "docker", args: [...compose, "pull", "migrate", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"], phase: "pull" },
    { binary: "docker", args: [...compose, "run", "--rm", "--no-deps", "--no-build", "migrate"], phase: "migration" },
    { binary: "docker", args: [...compose, "up", "-d", "--no-deps", "--no-build", "--wait", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"], phase: "rollout" },
    { binary: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "release:smoke"], phase: "smoke" },
  ];
}

export function executeDeploymentCommands(commands: Command[], runner: (command: Command) => void, record?: (phase: Command["phase"], success: boolean) => void): void {
  for (const command of commands) {
    try {
      runner(command);
      record?.(command.phase, true);
    } catch (error) {
      record?.(command.phase, false);
      throw error;
    }
  }
}

export function withDeploymentLock<T>(lockPath: string, action: () => T): T {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("Another deployment holds the environment lock");
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

export function createEvidence(environment: DeployEnvironment, manifestSha256: string, phase: Command["phase"], success: boolean, now = new Date()): DeploymentEvidence {
  return { environment, manifestSha256, phase, success, timestamp: now.toISOString() };
}

export function summarizeDeploymentEvidence(environment: DeployEnvironment, manifestSha256: string, evidence: DeploymentEvidence[]): DeploymentEvidenceSummary {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("Invalid manifest SHA-256");
  if (evidence.length > DEPLOYMENT_PHASES.length) throw new Error("Deployment evidence contains too many phases");
  evidence.forEach((item, index) => {
    if (item.environment !== environment || item.manifestSha256 !== manifestSha256 || item.phase !== DEPLOYMENT_PHASES[index]) throw new Error("Deployment evidence identity or phase order mismatch");
  });
  return { schemaVersion: 1, environment, manifestSha256, phases: evidence.map(({ phase, success, timestamp }) => ({ phase, success, timestamp })) };
}

export function validateSuccessfulDeploymentEvidence(summary: DeploymentEvidenceSummary): void {
  if (summary.phases.length !== DEPLOYMENT_PHASES.length || summary.phases.some((item, index) => item.phase !== DEPLOYMENT_PHASES[index] || item.success !== true)) {
    throw new Error("Successful deployment requires exactly pull, migration, rollout, and smoke success");
  }
}

export function writeDeploymentEvidence(path: string, summary: DeploymentEvidenceSummary): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createDryRunPlan(environment: DeployEnvironment, manifestSha256: string, commands: Command[], deployEnvFile: string, imageEnvFile: string): object {
  return {
    ok: true,
    dryRun: true,
    environment,
    manifestSha256,
    commands: commands.map(({ binary, args, phase }) => ({
      binary,
      phase,
      args: args.map((arg) => arg === deployEnvFile ? "<persistent-deploy-env>" : arg === imageEnvFile ? "<generated-images-env>" : arg),
    })),
  };
}

function main(args: string[]): void {
  const root = resolve(import.meta.dirname, "..");
  const environment = requiredArgument(args, "--environment");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be staging or production");
  }
  const manifestPath = resolve(root, requiredArgument(args, "--manifest"));
  const deployEnvValue = process.env.RELEASE_DEPLOY_ENV_FILE;
  if (!deployEnvValue) throw new Error("RELEASE_DEPLOY_ENV_FILE is required");
  if (!isAbsolute(deployEnvValue)) throw new Error("RELEASE_DEPLOY_ENV_FILE must be an absolute path");
  const deployEnvFile = resolve(deployEnvValue);
  if (!existsSync(deployEnvFile)) throw new Error("RELEASE_DEPLOY_ENV_FILE must reference an existing persistent configuration file");
  const deployEnvStat = lstatSync(deployEnvFile);
  if (!deployEnvStat.isFile()) throw new Error("RELEASE_DEPLOY_ENV_FILE must reference a regular file");
  if (process.platform !== "win32" && (deployEnvStat.mode & 0o077) !== 0) throw new Error("RELEASE_DEPLOY_ENV_FILE must not be group/world accessible");
  const canonicalDeployEnvFile = realpathSync(deployEnvFile);
  const canonicalManifestPath = realpathSync(manifestPath);
  const canonicalTemp = realpathSync(tmpdir());
  if (canonicalDeployEnvFile === canonicalManifestPath || canonicalDeployEnvFile === canonicalTemp || canonicalDeployEnvFile.startsWith(`${canonicalTemp}/`) || canonicalDeployEnvFile.startsWith(`${canonicalTemp}\\`)) {
    throw new Error("RELEASE_DEPLOY_ENV_FILE must be persistent and distinct from the manifest and temporary directory");
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const images = readDeploymentImages(manifestPath);
  const dryRun = args.includes("--dry-run");
  const directory = mkdtempSync(resolve(tmpdir(), "vocab-release-"));
  const envFile = resolve(directory, "images.env");
  try {
    writeFileSync(envFile, `APP_IMAGE=${images.runtime}\nMIGRATION_IMAGE=${images.migration}\nBACKUP_IMAGE=${images.backup}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(envFile, 0o600);
    const commands = buildDeploymentCommands(canonicalDeployEnvFile, envFile);
    if (dryRun) {
      console.log(JSON.stringify(createDryRunPlan(environment, manifestSha256, commands, canonicalDeployEnvFile, envFile), null, 2));
      return;
    }
    const lockPath = process.env.RELEASE_DEPLOY_LOCK_FILE;
    if (!lockPath) throw new Error("RELEASE_DEPLOY_LOCK_FILE is required");
    if (!isAbsolute(lockPath)) throw new Error("RELEASE_DEPLOY_LOCK_FILE must be an absolute path");
    const evidencePathValue = process.env.RELEASE_DEPLOY_EVIDENCE_PATH;
    if (evidencePathValue && !isAbsolute(evidencePathValue)) throw new Error("RELEASE_DEPLOY_EVIDENCE_PATH must be an absolute path");
    const evidencePath = evidencePathValue ? resolve(evidencePathValue) : undefined;
    const evidence: DeploymentEvidence[] = [];
    let evidenceWriteError: unknown;
    withDeploymentLock(resolve(lockPath), () => {
      executeDeploymentCommands(commands, (command) => {
        execFileSync(command.binary, command.args, { cwd: root, stdio: "inherit", env: process.env });
      }, (phase, success) => {
        const item = createEvidence(environment, manifestSha256, phase, success);
        evidence.push(item);
        console.log(JSON.stringify(item));
        if (evidencePath) {
          try {
            writeDeploymentEvidence(evidencePath, summarizeDeploymentEvidence(environment, manifestSha256, evidence));
          } catch (error) {
            evidenceWriteError ??= error;
            console.error("Unable to persist redacted deployment evidence");
          }
        }
      });
    });
    const summary = summarizeDeploymentEvidence(environment, manifestSha256, evidence);
    validateSuccessfulDeploymentEvidence(summary);
    if (evidenceWriteError) throw new Error("Deployment succeeded but evidence persistence failed", { cause: evidenceWriteError });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2));
