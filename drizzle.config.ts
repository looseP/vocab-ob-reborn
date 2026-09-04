import { defineConfig } from "drizzle-kit";
import { assertConnectionStringHasNoSslOptions, databaseSslConfig, databaseSslMode } from "./src/db/ssl";

const databaseUrl = process.env.DATABASE_URL!;
if (databaseUrl) assertConnectionStringHasNoSslOptions(databaseUrl);
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : undefined;
const sslMode = databaseSslMode();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle-release",
  migrations: {
    schema: "vocab_migrations",
    table: "__v2_release_migrations",
  },
  dbCredentials: sslMode === "disable"
    ? { url: databaseUrl }
    : {
        host: parsedDatabaseUrl!.hostname,
        port: Number(parsedDatabaseUrl!.port || 5432),
        user: decodeURIComponent(parsedDatabaseUrl!.username),
        password: decodeURIComponent(parsedDatabaseUrl!.password),
        database: decodeURIComponent(parsedDatabaseUrl!.pathname.slice(1)),
        ssl: databaseSslConfig(sslMode).ssl!,
      },
  // Only introspect the public schema — auth.users is a local shim
  schemaFilter: ["public"],
  // Exclude Supabase internal tables if any leak into public
  tablesFilter: ["*"],
  verbose: true,
  strict: true,
});
