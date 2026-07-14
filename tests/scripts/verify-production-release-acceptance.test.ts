import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildReleaseCheckEvidence, EXTERNAL_RELEASE_CHECKS, RELEASE_CHECK_PRODUCERS, type ExternalReleaseCheck } from "../../scripts/release-check-evidence";
import { verifyProductionReleaseAcceptance } from "../../scripts/verify-production-release-acceptance";

const releaseSha = "a".repeat(40);
const manifest = Buffer.from(JSON.stringify({ git: { sha: releaseSha } }));
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
const sidecar = `${manifestSha256}  release-manifest.json\n`;
const observedAt = "2026-07-11T00:00:00.000Z";
const phases = ["pull", "migration", "rollout", "smoke"].map((phase) => ({ phase, success: true, timestamp: observedAt }));
const deploymentBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, environment: "staging", manifestSha256, phases }));
const evidence = Object.fromEntries(EXTERNAL_RELEASE_CHECKS.map((check) => [check, Buffer.from(JSON.stringify(buildReleaseCheckEvidence({ check, producer: RELEASE_CHECK_PRODUCERS[check], releaseSha, manifestSha256, observedAt })))])) as Record<ExternalReleaseCheck, Buffer>;
type CheckDeclaration = {
  status: string;
  source: string;
  producer: string;
  releaseSha: string;
  manifestSha256: string;
  observedAt: string;
  evidenceSha256: string;
};

const externalDeclaration = (check: ExternalReleaseCheck): CheckDeclaration => ({
  status: "passed",
  source: "github-actions-artifact",
  producer: RELEASE_CHECK_PRODUCERS[check],
  releaseSha,
  manifestSha256,
  observedAt,
  evidenceSha256: createHash("sha256").update(evidence[check]).digest("hex"),
});
const smoke: CheckDeclaration = { status: "passed", source: "staging-deployment-evidence", producer: "release-workflow/staging", releaseSha, manifestSha256, observedAt, evidenceSha256: createHash("sha256").update(deploymentBytes).digest("hex") };
const checks: Record<ExternalReleaseCheck | "smoke", CheckDeclaration> = {
  migrationRehearsal: externalDeclaration("migrationRehearsal"),
  databaseRoles: externalDeclaration("databaseRoles"),
  backupRestore: externalDeclaration("backupRestore"),
  rollbackCompatibility: externalDeclaration("rollbackCompatibility"),
  alertingDrill: externalDeclaration("alertingDrill"),
  secretRotation: externalDeclaration("secretRotation"),
  smoke,
};
const acceptance = { schemaVersion: 1, releaseSha, manifestSha256, checks, decision: "GO" };
const now = new Date("2026-07-11T01:00:00.000Z");

type Overrides = { deploymentBytes?: Buffer; acceptance?: unknown; evidence?: Record<ExternalReleaseCheck, Buffer> };
const verify = (overrides: Overrides = {}) => verifyProductionReleaseAcceptance(manifest, sidecar, overrides.deploymentBytes ?? deploymentBytes, overrides.acceptance ?? acceptance, overrides.evidence ?? evidence, now);
const alter = (check: ExternalReleaseCheck, artifact: Record<string, unknown>, declaration: Record<string, unknown> = {}) => {
  const bytes = Buffer.from(JSON.stringify(artifact));
  return { evidence: { ...evidence, [check]: bytes }, acceptance: { ...acceptance, checks: { ...checks, [check]: { ...checks[check], evidenceSha256: createHash("sha256").update(bytes).digest("hex"), ...declaration } } } };
};
const artifact = (check: ExternalReleaseCheck) => JSON.parse(evidence[check].toString("utf8")) as Record<string, unknown>;

describe("release check evidence", () => {
  it("builds canonical artifact v1", () => expect(buildReleaseCheckEvidence({ check: "backupRestore", producer: RELEASE_CHECK_PRODUCERS.backupRestore, releaseSha, manifestSha256, observedAt })).toEqual(artifact("backupRestore")));
  it("rejects wrong producer", () => expect(() => buildReleaseCheckEvidence({ check: "backupRestore", producer: "other", releaseSha, manifestSha256, observedAt })).toThrow(/producer/));
});

describe("production release acceptance", () => {
  it("accepts verified source artifact bytes", () => expect(verify()).toEqual({ schemaVersion: 1, decision: "GO", releaseSha, manifestSha256, environment: "production", checks }));
  it("rejects missing artifact", () => { const missing = { ...evidence }; delete (missing as Partial<typeof evidence>).backupRestore; expect(() => verify({ evidence: missing })).toThrow(/Missing backupRestore/); });
  it("rejects missing secret rotation proof", () => { const missing = { ...evidence }; delete (missing as Partial<typeof evidence>).secretRotation; expect(() => verify({ evidence: missing })).toThrow(/Missing secretRotation/); });
  it("rejects an acceptance declaration without secret rotation", () => { const incomplete = { ...checks }; delete (incomplete as Partial<typeof checks>).secretRotation; expect(() => verify({ acceptance: { ...acceptance, checks: incomplete } })).toThrow(/keys/); });
  it("rejects tampered content", () => expect(() => verify({ evidence: { ...evidence, alertingDrill: Buffer.concat([evidence.alertingDrill, Buffer.from(" ")]) } })).toThrow(/digest mismatch/));
  it("rejects declaration digest mismatch", () => expect(() => verify({ acceptance: { ...acceptance, checks: { ...checks, databaseRoles: { ...checks.databaseRoles, evidenceSha256: "b".repeat(64) } } } })).toThrow(/digest mismatch/));
  it("rejects wrong check", () => expect(() => verify(alter("migrationRehearsal", { ...artifact("migrationRehearsal"), check: "databaseRoles", producer: RELEASE_CHECK_PRODUCERS.databaseRoles }))).toThrow(/check mismatch/));
  it("rejects wrong producer", () => expect(() => verify(alter("backupRestore", { ...artifact("backupRestore"), producer: RELEASE_CHECK_PRODUCERS.alertingDrill }))).toThrow(/producer/));
  it("rejects wrong release", () => expect(() => verify(alter("rollbackCompatibility", { ...artifact("rollbackCompatibility"), releaseSha: "b".repeat(40) }))).toThrow(/identity/));
  it("rejects wrong manifest", () => expect(() => verify(alter("alertingDrill", { ...artifact("alertingDrill"), manifestSha256: "b".repeat(64) }))).toThrow(/identity/));
  it("rejects stale evidence", () => expect(() => verify(alter("backupRestore", { ...artifact("backupRestore"), observedAt: "2026-05-01T00:00:00.000Z" }, { observedAt: "2026-05-01T00:00:00.000Z" }))).toThrow(/stale/));
  it("rejects future evidence", () => expect(() => verify(alter("databaseRoles", { ...artifact("databaseRoles"), observedAt: "2026-07-12T00:00:00.000Z" }, { observedAt: "2026-07-12T00:00:00.000Z" }))).toThrow(/future/));
  it("rejects unknown fields", () => expect(() => verify(alter("migrationRehearsal", { ...artifact("migrationRehearsal"), secret: "no" }))).toThrow(/keys/));
  it("rejects malformed JSON", () => { const bytes = Buffer.from("{"); expect(() => verify({ evidence: { ...evidence, backupRestore: bytes }, acceptance: { ...acceptance, checks: { ...checks, backupRestore: { ...checks.backupRestore, evidenceSha256: createHash("sha256").update(bytes).digest("hex") } } } })).toThrow(/Malformed/); });
  it("re-hashes smoke deployment bytes", () => expect(() => verify({ deploymentBytes: Buffer.concat([deploymentBytes, Buffer.from(" ")]) })).toThrow(/Smoke evidence mismatch/));
});
