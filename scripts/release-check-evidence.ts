import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const EXTERNAL_RELEASE_CHECKS = ["migrationRehearsal", "databaseRoles", "backupRestore", "rollbackCompatibility", "alertingDrill", "secretRotation"] as const;
export type ExternalReleaseCheck = (typeof EXTERNAL_RELEASE_CHECKS)[number];

export const RELEASE_CHECK_PRODUCERS: Readonly<Record<ExternalReleaseCheck, string>> = {
  migrationRehearsal: "release-check/migration-rehearsal",
  databaseRoles: "release-check/database-roles",
  backupRestore: "release-check/backup-restore",
  rollbackCompatibility: "release-check/rollback-compatibility",
  alertingDrill: "release-check/alerting-drill",
  secretRotation: "release-check/secret-rotation",
};

export type ReleaseCheckEvidence = {
  schemaVersion: 1;
  check: ExternalReleaseCheck;
  status: "passed";
  producer: string;
  releaseSha: string;
  manifestSha256: string;
  observedAt: string;
};

type JsonRecord = Record<string, unknown>;
const KEYS = ["schemaVersion", "check", "status", "producer", "releaseSha", "manifestSha256", "observedAt"] as const;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid release check evidence JSON");
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord): void {
  const actual = Object.keys(value).sort();
  const expected = [...KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("Invalid release check evidence keys");
}

function checkName(value: unknown): ExternalReleaseCheck {
  if (typeof value !== "string" || !EXTERNAL_RELEASE_CHECKS.includes(value as ExternalReleaseCheck)) throw new Error("Invalid release check");
  return value as ExternalReleaseCheck;
}

function hex(value: unknown, name: string, length: 40 | 64): string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function utcTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid observedAt");
  return value;
}

export function verifyReleaseCheckEvidence(value: unknown): ReleaseCheckEvidence {
  const artifact = record(value);
  exactKeys(artifact);
  const check = checkName(artifact.check);
  if (artifact.schemaVersion !== 1 || artifact.status !== "passed") throw new Error("Release check evidence must be artifact v1 with passed status");
  if (artifact.producer !== RELEASE_CHECK_PRODUCERS[check]) throw new Error(`Invalid producer for ${check}`);
  return {
    schemaVersion: 1,
    check,
    status: "passed",
    producer: artifact.producer,
    releaseSha: hex(artifact.releaseSha, "releaseSha", 40),
    manifestSha256: hex(artifact.manifestSha256, "manifestSha256", 64),
    observedAt: utcTimestamp(artifact.observedAt),
  };
}

export function parseReleaseCheckEvidence(bytes: Buffer): ReleaseCheckEvidence {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Malformed release check evidence JSON");
  }
  return verifyReleaseCheckEvidence(value);
}

export function buildReleaseCheckEvidence(input: Omit<ReleaseCheckEvidence, "schemaVersion" | "status">): ReleaseCheckEvidence {
  return verifyReleaseCheckEvidence({ schemaVersion: 1, status: "passed", ...input });
}

function requiredArgument(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args[index + 1]!.startsWith("--")) throw new Error(`${name} is required`);
  return args[index + 1]!;
}

function main(args: string[]): void {
  const check = checkName(requiredArgument(args, "--check"));
  const artifact = buildReleaseCheckEvidence({
    check,
    producer: requiredArgument(args, "--producer"),
    releaseSha: requiredArgument(args, "--release-sha"),
    manifestSha256: requiredArgument(args, "--manifest-sha256"),
    observedAt: requiredArgument(args, "--observed-at"),
  });
  const output = resolve(requiredArgument(args, "--output"));
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2));
