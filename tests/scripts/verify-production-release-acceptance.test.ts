import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyProductionReleaseAcceptance } from "../../scripts/verify-production-release-acceptance";

const releaseSha = "a".repeat(40);
const manifest = Buffer.from(JSON.stringify({ git: { sha: releaseSha } }));
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
const sidecar = `${manifestSha256}  release-manifest.json\n`;
const observedAt = "2026-07-11T00:00:00.000Z";
const phases = ["pull", "migration", "rollout", "smoke"].map((phase) => ({ phase, success: true, timestamp: observedAt }));
const deployment = { schemaVersion: 1, environment: "staging", manifestSha256, phases };
const check = { status: "passed", source: "github-environment", producer: "backup-drill/job-1", releaseSha, manifestSha256, observedAt, evidenceSha256: "c".repeat(64) };
const checks = { migrationRehearsal: check, databaseRoles: check, backupRestore: check, rollbackCompatibility: check, alertingDrill: check, smoke: { ...check, source: "staging-deployment-evidence" } };
const acceptance = { schemaVersion: 1, releaseSha, manifestSha256, checks, decision: "GO" };
const now = new Date("2026-07-11T01:00:00.000Z");

const verify = (overrides: { digest?: string; deployment?: unknown; acceptance?: unknown } = {}) => verifyProductionReleaseAcceptance(manifest, overrides.digest ?? sidecar, overrides.deployment ?? deployment, overrides.acceptance ?? acceptance, now);

describe("production release acceptance", () => {
  it("accepts bound GO evidence", () => expect(verify()).toEqual({ schemaVersion: 1, decision: "GO", releaseSha, manifestSha256, environment: "production", checks }));
  it("rejects a tampered digest", () => expect(() => verify({ digest: `${"b".repeat(64)}  release-manifest.json\n` })).toThrow(/digest sidecar/));
  it("rejects a missing phase", () => expect(() => verify({ deployment: { ...deployment, phases: phases.slice(1) } })).toThrow(/exactly four/));
  it("rejects a duplicate phase", () => expect(() => verify({ deployment: { ...deployment, phases: [phases[0], phases[0], phases[2], phases[3]] } })).toThrow(/ordered/));
  it("rejects a failed check", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, backupRestore: { ...check, status: "failed" } } } })).toThrow(/backupRestore/));
  it("rejects unknown fields", () => expect(() => verify({ acceptance: { ...acceptance, secret: "unexpected" } })).toThrow(/keys/));
  it("rejects unknown check fields", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, alertingDrill: { ...check, note: "untrusted" } } } })).toThrow(/keys/));
  it("rejects invalid evidence digests", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, migrationRehearsal: { ...check, evidenceSha256: "latest" } } } })).toThrow(/evidence SHA-256/));
  it("rejects future evidence timestamps", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, databaseRoles: { ...check, observedAt: "2026-07-12T00:00:00.000Z" } } } })).toThrow(/future/));
  it("rejects replayed evidence identity", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, backupRestore: { ...check, releaseSha: "b".repeat(40) } } } })).toThrow(/identity/));
  it("rejects stale evidence", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, alertingDrill: { ...check, observedAt: "2026-05-01T00:00:00.000Z" } } } })).toThrow(/stale/));
  it("rejects the wrong release SHA", () => expect(() => verify({ acceptance: { ...acceptance, releaseSha: "b".repeat(40) } })).toThrow(/identity/));
  it("rejects the wrong manifest SHA", () => expect(() => verify({ acceptance: { ...acceptance, manifestSha256: "b".repeat(64) } })).toThrow(/identity/));
  it("rejects NO_GO", () => expect(() => verify({ acceptance: { ...acceptance, decision: "NO_GO" } })).toThrow(/must be GO/));
});
