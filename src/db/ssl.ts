import { readFileSync } from "node:fs";
import type { ClientConfig } from "pg";

export type DatabaseSslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
export type DatabaseSslConfig = Partial<Pick<ClientConfig, "ssl">>;

const DATABASE_SSL_MODES = new Set<DatabaseSslMode>([
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

export function databaseSslMode(mode = process.env.DB_SSLMODE ?? "disable"): DatabaseSslMode {
  if (!DATABASE_SSL_MODES.has(mode as DatabaseSslMode)) {
    throw new Error(`DB_SSLMODE must be one of: ${[...DATABASE_SSL_MODES].join(", ")}`);
  }
  return mode as DatabaseSslMode;
}

export function databaseSslConfig(
  mode = process.env.DB_SSLMODE ?? "disable",
  rootCertificatePath = process.env.DB_SSLROOTCERT,
): DatabaseSslConfig {
  const validatedMode = databaseSslMode(mode);
  if (validatedMode === "disable") return {};
  if (validatedMode === "verify-ca" || validatedMode === "verify-full") {
    return {
      ssl: {
        rejectUnauthorized: true,
        ...(rootCertificatePath ? { ca: readFileSync(rootCertificatePath, "utf8") } : {}),
      },
    };
  }
  return { ssl: { rejectUnauthorized: false } };
}

export function assertConnectionStringHasNoSslOptions(connectionString: string): void {
  const url = new URL(connectionString);
  const conflictingOptions = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]
    .filter((name) => url.searchParams.has(name));
  if (conflictingOptions.length !== 0) {
    throw new Error(`PostgreSQL connection URL must not contain TLS options; configure DB_SSLMODE instead: ${conflictingOptions.join(", ")}`);
  }
}

export function postgresClientConfig(connectionString: string): ClientConfig {
  assertConnectionStringHasNoSslOptions(connectionString);
  return { connectionString, ...databaseSslConfig() };
}
