import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const compose = readFileSync(resolve(projectRoot, "compose.yaml"), "utf8");
const envExample = readFileSync(resolve(projectRoot, ".env.example"), "utf8");

function serviceBlock(service: string, nextService: string): string {
  const servicesStart = compose.indexOf("\nservices:\n");
  const start = compose.indexOf(`\n  ${service}:`, servicesStart);
  const end = compose.indexOf(`\n  ${nextService}:`, start + 1);
  expect(start, `${service} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextService} must follow ${service}`).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("Compose database role routing", () => {
  it.each([
    ["review-outbox-worker", "llm-reservation-reaper"],
    ["llm-reservation-reaper", "backup-scheduler"],
  ])("routes %s through WORKER_DATABASE_URL", (service, nextService) => {
    const block = serviceBlock(service, nextService);
    expect(block).toContain("DATABASE_URL: ${WORKER_DATABASE_URL:-}");
    expect(block).not.toContain("DATABASE_URL: ${APP_DATABASE_URL");
    expect(block).not.toContain("${DATABASE_URL:-");
  });

  it("keeps web-only production configuration scoped to the web service", () => {
    const web = serviceBlock("web", "review-outbox-worker");
    expect(web).toContain("APP_DATABASE_URL: ${APP_DATABASE_URL:-}");
    expect(web).toContain("METRICS_BEARER_TOKEN: ${METRICS_BEARER_TOKEN:-}");
    expect(serviceBlock("migrate", "web")).not.toContain("METRICS_BEARER_TOKEN");
    expect(serviceBlock("review-outbox-worker", "llm-reservation-reaper")).not.toContain("METRICS_BEARER_TOKEN");
    expect(serviceBlock("llm-reservation-reaper", "backup-scheduler")).not.toContain("METRICS_BEARER_TOKEN");
    expect(serviceBlock("backup-scheduler", "data-lifecycle")).not.toContain("METRICS_BEARER_TOKEN");
  });

  it("defers profile-only lifecycle requirements to its fail-fast entrypoint", () => {
    const lifecycle = compose.slice(compose.indexOf("\n  data-lifecycle:"), compose.indexOf("\nvolumes:"));
    expect(lifecycle).toContain("DATA_LIFECYCLE_DATABASE_URL: ${DATA_LIFECYCLE_DATABASE_URL:-}");
    expect(lifecycle).toContain("DATA_LIFECYCLE_CUTOFF: ${DATA_LIFECYCLE_CUTOFF:-}");
    expect(lifecycle).not.toContain("DATA_LIFECYCLE_DATABASE_URL: ${DATA_LIFECYCLE_DATABASE_URL:?");
  });

  it("routes migration and backup services through their dedicated URLs", () => {
    const migration = serviceBlock("migrate", "web");
    const backup = serviceBlock("backup-scheduler", "data-lifecycle");
    expect(migration).toContain("DATABASE_URL: ${MIGRATION_DATABASE_URL:-}");
    expect(backup).toContain("DATABASE_URL: ${BACKUP_DATABASE_URL:-}");
    expect(migration).not.toContain("${DATABASE_URL:-");
    expect(backup).not.toContain("${DATABASE_URL:-");
  });

  it("documents the same four role names verified by the database role gate", () => {
    for (const role of ["vocab_app", "vocab_worker", "vocab_backup", "vocab_migration"]) {
      expect(envExample).toContain(`postgresql://${role}:`);
    }
    for (const staleRole of ["app_role", "worker_role", "backup_role", "migration_role"]) {
      expect(envExample).not.toContain(`postgresql://${staleRole}:`);
    }
  });
});
