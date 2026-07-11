import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PHASES = ["pull", "migration", "rollout", "smoke"] as const;
const CHECKS = ["migrationRehearsal", "databaseRoles", "backupRestore", "rollbackCompatibility", "alertingDrill", "smoke"] as const;
type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`Invalid ${name} keys`);
}

function sha(value: unknown, name: string, length: 40 | 64): string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function observedAt(value: unknown, name: string, now: Date): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`Invalid ${name} observedAt`);
  if (Date.parse(value) > now.getTime() + 5 * 60_000) throw new Error(`${name} observedAt cannot be in the future`);
  return value;
}

export function verifyProductionReleaseAcceptance(manifestBytes: Buffer, sidecar: string, deploymentValue: unknown, acceptanceValue: unknown, now = new Date()): { schemaVersion: 1; decision: "GO"; releaseSha: string; manifestSha256: string; environment: "production"; checks: JsonRecord } {
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (sidecar !== `${manifestSha256}  release-manifest.json\n`) throw new Error("Release manifest digest sidecar mismatch");
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "release manifest");
  const git = record(manifest.git, "release manifest git identity");
  exactKeys(git, ["sha"], "release manifest git identity");
  const releaseSha = sha(git.sha, "release SHA", 40);

  const deployment = record(deploymentValue, "staging deployment evidence");
  exactKeys(deployment, ["schemaVersion", "environment", "manifestSha256", "phases"], "staging deployment evidence");
  if (deployment.schemaVersion !== 1 || deployment.environment !== "staging" || deployment.manifestSha256 !== manifestSha256) throw new Error("Staging deployment identity mismatch");
  if (!Array.isArray(deployment.phases) || deployment.phases.length !== PHASES.length) throw new Error("Staging deployment must contain exactly four phases");
  deployment.phases.forEach((value, index) => {
    const phase = record(value, `staging phase ${index}`);
    exactKeys(phase, ["phase", "success", "timestamp"], `staging phase ${index}`);
    if (phase.phase !== PHASES[index] || phase.success !== true || typeof phase.timestamp !== "string" || !Number.isFinite(Date.parse(phase.timestamp))) throw new Error("Staging phases must be ordered and successful");
  });

  const acceptance = record(acceptanceValue, "production acceptance declaration");
  exactKeys(acceptance, ["schemaVersion", "releaseSha", "manifestSha256", "checks", "decision"], "production acceptance declaration");
  if (acceptance.schemaVersion !== 1 || acceptance.decision !== "GO") throw new Error("Production acceptance decision must be GO");
  if (sha(acceptance.releaseSha, "acceptance release SHA", 40) !== releaseSha || sha(acceptance.manifestSha256, "acceptance manifest SHA-256", 64) !== manifestSha256) throw new Error("Production acceptance identity mismatch");
  const checks = record(acceptance.checks, "production acceptance checks");
  exactKeys(checks, CHECKS, "production acceptance checks");
  for (const check of CHECKS) {
    const item = record(checks[check], `${check} check`);
    exactKeys(item, ["status", "source", "producer", "releaseSha", "manifestSha256", "observedAt", "evidenceSha256"], `${check} check`);
    if (item.status !== "passed") throw new Error(`${check} must be passed`);
    if (typeof item.source !== "string" || !/^(github-environment|staging-deployment-evidence)$/.test(item.source)) throw new Error(`Invalid ${check} evidence source`);
    if (typeof item.producer !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(item.producer)) throw new Error(`Invalid ${check} evidence producer`);
    if (item.releaseSha !== releaseSha || item.manifestSha256 !== manifestSha256) throw new Error(`${check} evidence identity mismatch`);
    const timestamp = observedAt(item.observedAt, check, now);
    if (now.getTime() - Date.parse(timestamp) > 30 * 24 * 60 * 60_000) throw new Error(`${check} evidence is stale`);
    sha(item.evidenceSha256, `${check} evidence SHA-256`, 64);
  }
  return { schemaVersion: 1, decision: "GO", releaseSha, manifestSha256, environment: "production", checks };
}

function requiredArgument(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args[index + 1]!.startsWith("--")) throw new Error(`${name} is required`);
  return args[index + 1]!;
}

function main(args: string[]): void {
  const manifestPath = resolve(requiredArgument(args, "--manifest"));
  const result = verifyProductionReleaseAcceptance(
    readFileSync(manifestPath),
    readFileSync(resolve(requiredArgument(args, "--digest")), "utf8"),
    JSON.parse(readFileSync(resolve(requiredArgument(args, "--deployment-evidence")), "utf8")),
    JSON.parse(readFileSync(resolve(requiredArgument(args, "--acceptance")), "utf8")),
  );
  const output = process.env.RELEASE_ACCEPTANCE_EVIDENCE_PATH;
  if (output) writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2));
