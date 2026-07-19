import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDrillVerificationIdentity,
  assertSafeDrillTarget,
  databaseName,
  drillVerificationEnvironment,
  pgRestoreArguments,
  postgresEnvironment,
  signManifest,
  validateRestoreDrillEnvironment,
  verifyManifest,
  verifyManifestSignature,
  type BackupManifest,
} from "../../scripts/postgres-backup";

let roots: string[] = [];
const originalSslMode = process.env.DB_SSLMODE;
const originalRootCertificate = process.env.DB_SSLROOTCERT;

beforeEach(() => {
  process.env.DB_SSLMODE = "verify-full";
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  delete process.env.ALLOW_DESTRUCTIVE_RESTORE;
  if (originalSslMode === undefined) delete process.env.DB_SSLMODE;
  else process.env.DB_SSLMODE = originalSslMode;
  delete process.env.PGSSLROOTCERT;
  if (originalRootCertificate === undefined) delete process.env.DB_SSLROOTCERT;
  else process.env.DB_SSLROOTCERT = originalRootCertificate;
});

function makeManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    version: 2,
    createdAt: "2026-07-11T00:00:00.000Z",
    database: "vocab",
    format: "postgresql-custom",
    dumpFile: "sample.dump",
    bytes: 0,
    sha256: "",
    pgDumpVersion: "pg_dump (PostgreSQL) 17.10",
    schemaEvidence: { migrationCount: 8, tableCount: 21, functionCount: 3 },
    ...overrides,
  };
}

describe("postgres backup safety", () => {
  it("extracts encoded database names without exposing credentials", () => {
    expect(databaseName("postgresql://user:secret@localhost:5432/vocab%5Fprod")).toBe("vocab_prod");
    process.env.PGSSLROOTCERT = "/untrusted/ambient-ca.pem";
    process.env.DB_SSLROOTCERT = "/run/secrets/postgres-ca.pem";
    const env = postgresEnvironment("postgresql://user:secret@db.example:5433/vocab");
    expect(env).toMatchObject({
      PGHOST: "db.example",
      PGPORT: "5433",
      PGDATABASE: "vocab",
      PGUSER: "user",
      PGPASSWORD: "secret",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/run/secrets/postgres-ca.pem",
    });
    expect(() => postgresEnvironment("postgresql://user:secret@db.example:5433/vocab?sslmode=require"))
      .toThrow(/must not contain TLS options/);
  });

  it("rejects source equality and unsafe drill database names", () => {
    const source = "postgresql://u:p@db:5432/vocab";
    expect(() => assertSafeDrillTarget(source, source)).toThrow(/must not identify/);
    expect(() => assertSafeDrillTarget(source, "postgresql://u:p@db:5432/vocab_prod")).toThrow(/must end/);
    const target = "postgresql://restore:other@drill-db:5432/vocab_restore";
    expect(() => assertSafeDrillTarget(source, target)).toThrow(/ALLOW_DESTRUCTIVE_RESTORE/);
    process.env.ALLOW_DESTRUCTIVE_RESTORE = "drill-db:5432/vocab_restore";
    expect(() => assertSafeDrillTarget(source, target)).not.toThrow();
  });

  it("requires a distinct verification login on the restored drill database", () => {
    const target = "postgresql://vocab_migration:migration@db:5432/vocab_drill";
    expect(() => assertDrillVerificationIdentity(
      target,
      "postgresql://vocab_drill_admin:admin@db:5432/vocab_drill",
    )).not.toThrow();
    expect(() => assertDrillVerificationIdentity(
      target,
      "postgresql://vocab_drill_admin:admin@db:5432/other_drill",
    )).toThrow(/restored drill database/);
    expect(() => assertDrillVerificationIdentity(
      target,
      "postgresql://vocab_migration:other@db:5432/vocab_drill",
    )).toThrow(/must not reuse the restore identity/);
  });

  it("rejects a mismatched verification identity before restore execution", () => {
    process.env.ALLOW_DESTRUCTIVE_RESTORE = "db:5432/vocab_drill";
    expect(() => validateRestoreDrillEnvironment({
      DATABASE_URL: "postgresql://vocab_backup:backup@db:5432/vocab",
      DRILL_DATABASE_URL: "postgresql://vocab_migration:migration@db:5432/vocab_drill",
      DRILL_TEST_DATABASE_URL: "postgresql://vocab_drill_admin:admin@other-db:5432/vocab_drill",
      ALLOW_DESTRUCTIVE_RESTORE: process.env.ALLOW_DESTRUCTIVE_RESTORE,
    })).toThrow(/restored drill database/);
  });

  it("passes the restored database explicitly to pg_restore", () => {
    expect(pgRestoreArguments(
      "postgresql://vocab_migration:secret@db:5432/vocab_drill",
      "/isolated/vocab.dump",
      "2",
    )).toEqual([
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--dbname", "vocab_drill",
      "--jobs", "2",
      "/isolated/vocab.dump",
    ]);
    expect(() => pgRestoreArguments(
      "postgresql://vocab_migration:secret@db:5432/vocab_drill",
      "/isolated/vocab.dump",
      "0",
    )).toThrow(/positive integer/);
  });

  it("isolates restored release verification from source and role credentials", () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      DB_SSLMODE: "verify-full",
      HOME: "/untrusted/home",
      USERPROFILE: "C:/untrusted/profile",
      NODE_PATH: "/untrusted/modules",
      NODE_OPTIONS: "--require /untrusted/preload.js",
      npm_config_userconfig: "/untrusted/.npmrc",
      DATABASE_ADMIN_URL: "postgresql://admin:secret@source/vocab",
      APP_DATABASE_URL: "postgresql://app:secret@source/vocab",
      WORKER_DATABASE_URL: "postgresql://worker:secret@source/vocab",
      BACKUP_DATABASE_URL: "postgresql://backup:secret@source/vocab",
      MIGRATION_DATABASE_URL: "postgresql://migration:secret@source/vocab",
      DRILL_DATABASE_URL: "postgresql://migration:secret@source/vocab_drill",
      DRILL_TEST_DATABASE_URL: "postgresql://admin:secret@source/vocab_drill",
      BACKUP_SIGNING_KEY: "must-not-leak",
    };
    expect(drillVerificationEnvironment(
      environment,
      "postgresql://vocab_migration:restore@db/vocab_drill",
      "postgresql://vocab_drill_admin:verify@db/vocab_drill",
    )).toEqual({
      PATH: "/usr/bin",
      DB_SSLMODE: "verify-full",
      DATABASE_URL: "postgresql://vocab_migration:restore@db/vocab_drill",
      TEST_DATABASE_URL: "postgresql://vocab_drill_admin:verify@db/vocab_drill",
    });
  });

  it("verifies manifest size and SHA-256", async () => {
    const root = mkdtempSync(join(tmpdir(), "vocab-backup-test-"));
    roots.push(root);
    const dump = Buffer.from("test custom dump bytes");
    const dumpPath = join(root, "sample.dump");
    const manifestPath = join(root, "sample.manifest.json");
    writeFileSync(dumpPath, dump);
    writeFileSync(manifestPath, JSON.stringify(makeManifest({
      bytes: dump.length,
      sha256: createHash("sha256").update(dump).digest("hex"),
    })));

    await expect(verifyManifest(manifestPath)).resolves.toMatchObject({ database: "vocab", bytes: dump.length });

    const escapingManifest = join(root, "escaping.manifest.json");
    writeFileSync(escapingManifest, JSON.stringify({
      version: 2,
      format: "postgresql-custom",
      dumpFile: "../sample.dump",
    }));
    await expect(verifyManifest(escapingManifest)).rejects.toThrow(/invalid|local file name/);

    writeFileSync(dumpPath, "tampered");
    await expect(verifyManifest(manifestPath)).rejects.toThrow(/size|SHA-256/);
  });

  it("accepts v1 manifests for backwards compatibility", async () => {
    const root = mkdtempSync(join(tmpdir(), "vocab-backup-v1-"));
    roots.push(root);
    const dump = Buffer.from("legacy dump");
    const dumpPath = join(root, "legacy.dump");
    const manifestPath = join(root, "legacy.manifest.json");
    writeFileSync(dumpPath, dump);
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      database: "vocab",
      format: "postgresql-custom",
      dumpFile: "legacy.dump",
      bytes: dump.length,
      sha256: createHash("sha256").update(dump).digest("hex"),
      pgDumpVersion: "pg_dump (PostgreSQL) 17.10",
      schemaEvidence: { migrationCount: 8, tableCount: 21, functionCount: 3 },
    }));
    await expect(verifyManifest(manifestPath)).resolves.toMatchObject({ database: "vocab" });
  });
});

describe("backup manifest signing", () => {
  it("signs and verifies a manifest with HMAC-SHA256", () => {
    const key = "test-signing-key-at-least-24-chars";
    const manifest = makeManifest({
      bytes: 100,
      sha256: createHash("sha256").update("data").digest("hex"),
    });
    manifest.hmac = signManifest(manifest, key);
    expect(verifyManifestSignature(manifest, key)).toBe(true);
    expect(verifyManifestSignature(manifest, "wrong-key-at-least-24-chars!!")).toBe(false);
  });

  it("rejects unsigned manifest when signing key is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "vocab-backup-sig-"));
    roots.push(root);
    const dump = Buffer.from("signed dump data");
    writeFileSync(join(root, "sig.dump"), dump);
    const manifestPath = join(root, "sig.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(makeManifest({
      dumpFile: "sig.dump",
      bytes: dump.length,
      sha256: createHash("sha256").update(dump).digest("hex"),
    })));
    await expect(verifyManifest(manifestPath, "key-at-least-24-characters!!")).rejects.toThrow(/not signed/);
  });

  it("rejects tampered HMAC signature", () => {
    const key = "test-signing-key-at-least-24-chars";
    const manifest = makeManifest({
      bytes: 100,
      sha256: createHash("sha256").update("data").digest("hex"),
    });
    manifest.hmac = signManifest(manifest, key);
    // Tamper with the signature
    manifest.hmac = manifest.hmac.slice(0, -4) + "0000";
    expect(verifyManifestSignature(manifest, key)).toBe(false);
  });
});
