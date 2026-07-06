import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Only introspect the public schema — auth.users is a local shim
  schemaFilter: ["public"],
  // Exclude Supabase internal tables if any leak into public
  tablesFilter: ["*"],
  verbose: true,
  strict: true,
});
