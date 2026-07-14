import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySecretRotationReceipt, type SecretRotationReceipt } from "../../scripts/verify-secret-rotation-evidence";

const key = "test-secret-rotation-evidence-key-123456";
const checkedAt = "2026-07-14T00:00:00.000Z";
const checks: SecretRotationReceipt["checks"] = {
  appDatabase: { newCredentialAccepted: true, oldCredentialRejected: true },
  workerDatabase: { newCredentialAccepted: true, oldCredentialRejected: true },
  backupDatabase: { newCredentialAccepted: true, oldCredentialRejected: true },
  migrationDatabase: { newCredentialAccepted: true, oldCredentialRejected: true },
  metricsToken: { newCredentialAccepted: true, oldCredentialRejected: true },
  backupSigningKey: { newCredentialAccepted: true, oldCredentialRejected: true },
  alertReceiver: { newCredentialAccepted: true, oldCredentialRejected: true },
};
function signedReceipt(overrides: { checkedAt?: string; checks?: unknown } = {}): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 1,
    environment: "staging",
    checkedAt,
    checks,
    ...overrides,
  };
  const payload = JSON.stringify(unsigned);
  return { ...unsigned, signature: createHmac("sha256", key).update(payload).digest("hex") };
}
const receipt = signedReceipt();
const now = new Date("2026-07-14T01:00:00.000Z");

describe("secret rotation evidence", () => {
  it("accepts signed fresh proof that new credentials work and old credentials are rejected", () => {
    expect(verifySecretRotationReceipt(receipt, key, now)).toEqual(receipt);
  });
  it("rejects a modified receipt even if fields otherwise validate", () => {
    expect(() => verifySecretRotationReceipt({ ...receipt, checkedAt: "2026-07-13T00:00:00.000Z" }, key, now)).toThrow(/signature/);
  });
  it("rejects a signed rotation proof that did not reject the old credential", () => {
    const unsafe = signedReceipt({ checks: { ...checks, appDatabase: { newCredentialAccepted: true, oldCredentialRejected: false } } });
    expect(() => verifySecretRotationReceipt(unsafe, key, now)).toThrow(/incomplete/);
  });
  it("rejects signed stale rotation proof", () => {
    const stale = signedReceipt({ checkedAt: "2026-04-01T00:00:00.000Z" });
    expect(() => verifySecretRotationReceipt(stale, key, now)).toThrow(/stale/);
  });
  it("rejects a signed receipt that omits a required credential class", () => {
    const partialChecks = { ...checks } as Record<string, unknown>;
    delete partialChecks.alertReceiver;
    const payload = JSON.stringify({ schemaVersion: 1, environment: "staging", checkedAt, checks: partialChecks });
    const missing = { schemaVersion: 1, environment: "staging", checkedAt, checks: partialChecks, signature: createHmac("sha256", key).update(payload).digest("hex") };
    expect(() => verifySecretRotationReceipt(missing, key, now)).toThrow(/keys/);
  });
});
