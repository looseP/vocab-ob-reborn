import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeDrillTarget,
  databaseName,
  postgresEnvironment,
  verifyManifest,
} from "../../scripts/postgres-backup";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  delete process.env.ALLOW_DESTRUCTIVE_RESTORE;
});

describe("postgres backup safety", () => {
  it("extracts encoded database names without exposing credentials", () => {
    expect(databaseName("postgresql://user:secret@localhost:5432/vocab%5Fprod")).toBe("vocab_prod");
    const env = postgresEnvironment("postgresql://user:secret@db.example:5433/vocab?sslmode=require");
    expect(env).toMatchObject({
      PGHOST: "db.example",
      PGPORT: "5433",
      PGDATABASE: "vocab",
      PGUSER: "user",
      PGPASSWORD: "secret",
      PGSSLMODE: "require",
    });
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

  it("verifies manifest size and SHA-256", async () => {
    const root = mkdtempSync(join(tmpdir(), "vocab-backup-test-"));
    roots.push(root);
    const dump = Buffer.from("test custom dump bytes");
    const dumpPath = join(root, "sample.dump");
    const manifestPath = join(root, "sample.manifest.json");
    writeFileSync(dumpPath, dump);
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      database: "vocab",
      format: "postgresql-custom",
      dumpFile: "sample.dump",
      bytes: dump.length,
      sha256: createHash("sha256").update(dump).digest("hex"),
      pgDumpVersion: "pg_dump (PostgreSQL) 17.10",
      schemaEvidence: { migrationCount: 8, tableCount: 21, functionCount: 3 },
    }));

    await expect(verifyManifest(manifestPath)).resolves.toMatchObject({ database: "vocab", bytes: dump.length });

    const escapingManifest = join(root, "escaping.manifest.json");
    writeFileSync(escapingManifest, JSON.stringify({
      version: 1,
      format: "postgresql-custom",
      dumpFile: "../sample.dump",
    }));
    await expect(verifyManifest(escapingManifest)).rejects.toThrow(/invalid|local file name/);

    writeFileSync(dumpPath, "tampered");
    await expect(verifyManifest(manifestPath)).rejects.toThrow(/size|SHA-256/);
  });
});
