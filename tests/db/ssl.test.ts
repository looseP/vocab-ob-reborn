import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertConnectionStringHasNoSslOptions,
  databaseSslConfig,
  postgresClientConfig,
} from "../../src/db/ssl";

const originalSslMode = process.env.DB_SSLMODE;
const originalRootCertificate = process.env.DB_SSLROOTCERT;
const temporaryRoots: string[] = [];

afterEach(() => {
  if (originalSslMode === undefined) delete process.env.DB_SSLMODE;
  else process.env.DB_SSLMODE = originalSslMode;
  if (originalRootCertificate === undefined) delete process.env.DB_SSLROOTCERT;
  else process.env.DB_SSLROOTCERT = originalRootCertificate;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL TLS configuration", () => {
  it.each([
    ["disable", {}],
    ["prefer", { ssl: { rejectUnauthorized: false } }],
    ["require", { ssl: { rejectUnauthorized: false } }],
    ["verify-ca", { ssl: { rejectUnauthorized: true } }],
    ["verify-full", { ssl: { rejectUnauthorized: true } }],
  ] as const)("maps DB_SSLMODE=%s without weakening verification", (mode, config) => {
    expect(databaseSslConfig(mode)).toEqual(config);
  });

  it("fails closed for unknown modes", () => {
    expect(() => databaseSslConfig("allow" as never)).toThrow(/DB_SSLMODE must be one of/);
  });

  it("rejects URL TLS options that node-postgres would let override object ssl", () => {
    for (const option of ["ssl=true", "sslmode=require", "sslrootcert=%2Fca.pem", "uselibpqcompat=true"]) {
      expect(() => assertConnectionStringHasNoSslOptions(`postgresql://user:secret@db.example/vocab?${option}`))
        .toThrow(/must not contain TLS options/);
    }
  });

  it("builds the shared Client and Pool config from DB_SSLMODE and DB_SSLROOTCERT", () => {
    const root = mkdtempSync(join(tmpdir(), "vocab-db-ca-"));
    temporaryRoots.push(root);
    const certificatePath = join(root, "ca.pem");
    writeFileSync(certificatePath, "test-ca-certificate");
    process.env.DB_SSLMODE = "verify-full";
    process.env.DB_SSLROOTCERT = certificatePath;
    expect(postgresClientConfig("postgresql://user:secret@db.example/vocab")).toEqual({
      connectionString: "postgresql://user:secret@db.example/vocab",
      ssl: { rejectUnauthorized: true, ca: "test-ca-certificate" },
    });
  });
});
