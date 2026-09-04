import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const REQUIRED_CHECKS = [
  "appDatabase",
  "workerDatabase",
  "backupDatabase",
  "migrationDatabase",
  "metricsToken",
  "backupSigningKey",
  "alertReceiver",
] as const;

type RequiredCheck = (typeof REQUIRED_CHECKS)[number];
type JsonRecord = Record<string, unknown>;

export interface SecretRotationReceipt {
  schemaVersion: 1;
  environment: "staging";
  checkedAt: string;
  checks: Record<RequiredCheck, { newCredentialAccepted: true; oldCredentialRejected: true }>;
  signature: string;
}

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`Invalid ${name} keys`);
}

function checkedAt(value: unknown, now: Date): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid secret rotation checkedAt");
  const ageMs = now.getTime() - Date.parse(value);
  if (ageMs < -5 * 60_000) throw new Error("Secret rotation evidence checkedAt cannot be in the future");
  if (ageMs > 90 * 24 * 60 * 60_000) throw new Error("Secret rotation evidence is stale");
  return value;
}

function signaturePayload(receipt: Omit<SecretRotationReceipt, "signature">): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    environment: receipt.environment,
    checkedAt: receipt.checkedAt,
    checks: receipt.checks,
  });
}

function hmac(payload: string, key: string): Buffer {
  return Buffer.from(createHmac("sha256", key).update(payload).digest("hex"), "utf8");
}

export function verifySecretRotationReceipt(value: unknown, signingKey: string, now = new Date()): SecretRotationReceipt {
  if (typeof signingKey !== "string" || signingKey.length < 24) throw new Error("SECRET_ROTATION_EVIDENCE_HMAC_KEY must be at least 24 characters");
  const receipt = record(value, "secret rotation receipt");
  exactKeys(receipt, ["schemaVersion", "environment", "checkedAt", "checks", "signature"], "secret rotation receipt");
  if (receipt.schemaVersion !== 1 || receipt.environment !== "staging") throw new Error("Secret rotation receipt must be schema v1 for staging");
  const timestamp = checkedAt(receipt.checkedAt, now);
  const checks = record(receipt.checks, "secret rotation checks");
  exactKeys(checks, REQUIRED_CHECKS, "secret rotation checks");
  const verifiedChecks = {} as SecretRotationReceipt["checks"];
  for (const name of REQUIRED_CHECKS) {
    const check = record(checks[name], `secret rotation ${name}`);
    exactKeys(check, ["newCredentialAccepted", "oldCredentialRejected"], `secret rotation ${name}`);
    if (check.newCredentialAccepted !== true || check.oldCredentialRejected !== true) throw new Error(`Secret rotation ${name} verification is incomplete`);
    verifiedChecks[name] = { newCredentialAccepted: true, oldCredentialRejected: true };
  }
  if (typeof receipt.signature !== "string" || !/^[a-f0-9]{64}$/.test(receipt.signature)) throw new Error("Invalid secret rotation evidence signature");
  const payload = signaturePayload({ schemaVersion: 1, environment: "staging", checkedAt: timestamp, checks: verifiedChecks });
  const expected = hmac(payload, signingKey);
  const supplied = Buffer.from(receipt.signature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Secret rotation evidence signature mismatch");
  return { schemaVersion: 1, environment: "staging", checkedAt: timestamp, checks: verifiedChecks, signature: receipt.signature };
}

function main(): void {
  const evidencePath = process.env.SECRET_ROTATION_EVIDENCE_PATH;
  const signingKey = process.env.SECRET_ROTATION_EVIDENCE_HMAC_KEY;
  if (!evidencePath || !isAbsolute(evidencePath)) throw new Error("SECRET_ROTATION_EVIDENCE_PATH must be an absolute trusted runner path");
  const receipt = verifySecretRotationReceipt(JSON.parse(readFileSync(resolve(evidencePath), "utf8")), signingKey ?? "");
  process.stdout.write(`${JSON.stringify({ status: "passed", environment: receipt.environment, checkedAt: receipt.checkedAt })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown secret rotation evidence error";
    process.stderr.write(`${JSON.stringify({ status: "failed", error: message })}\n`);
    process.exitCode = 1;
  }
}
