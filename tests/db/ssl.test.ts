import { afterEach, describe, expect, it } from "vitest";
import {
  assertConnectionStringHasNoSslOptions,
  databaseSslConfig,
  postgresClientConfig,
} from "../../src/db/ssl";

const originalSslMode = process.env.DB_SSLMODE;

afterEach(() => {
  if (originalSslMode === undefined) delete process.env.DB_SSLMODE;
  else process.env.DB_SSLMODE = originalSslMode;
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

  it("builds the shared Client and Pool config from DB_SSLMODE", () => {
    process.env.DB_SSLMODE = "verify-full";
    expect(postgresClientConfig("postgresql://user:secret@db.example/vocab")).toEqual({
      connectionString: "postgresql://user:secret@db.example/vocab",
      ssl: { rejectUnauthorized: true },
    });
  });
});
