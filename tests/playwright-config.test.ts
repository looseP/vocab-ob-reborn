import { describe, expect, it } from "vitest";
import { resolveE2EWebServerEnvironment } from "../playwright.config";

describe("Playwright web server database identity", () => {
  it("exposes only the explicit runtime allowlist to the application process", () => {
    expect(resolveE2EWebServerEnvironment({
      PATH: "test-path",
      CI: "true",
      DB_SSLMODE: "disable",
      DATABASE_ADMIN_URL: "postgresql://admin:secret@localhost/vocab",
      MIGRATION_DATABASE_URL: "postgresql://migration:secret@localhost/vocab",
      WORKER_DATABASE_URL: "postgresql://worker:secret@localhost/vocab",
      BACKUP_DATABASE_URL: "postgresql://backup:secret@localhost/vocab",
      TEST_DATABASE_URL: "postgresql://test-admin:secret@localhost/vocab",
      RLS_ACCEPTANCE_DATABASE_URL: "postgresql://rls:secret@localhost/vocab",
      DATA_LIFECYCLE_DATABASE_URL: "postgresql://lifecycle:secret@localhost/vocab",
      E2E_SETUP_DATABASE_URL: "postgresql://setup:secret@localhost/vocab",
      APP_DATABASE_URL: "postgresql://app:secret@localhost/vocab",
      DATABASE_URL: "postgresql://app:secret@localhost/vocab",
      NODE_OPTIONS: "--require malicious.js",
    })).toEqual({
      PATH: "test-path",
      CI: "true",
      DB_SSLMODE: "disable",
    });
  });
});
