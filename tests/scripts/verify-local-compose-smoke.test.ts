import { describe, expect, it } from "vitest";
import {
  assessServiceStatuses,
  buildCleanupCommand,
  buildProjectResourceFilters,
  hasListedResources,
  parseComposePs,
  parsePublishedPort,
  resolveSmokeBackupRuntimeUser,
  resolveSmokeDatabaseEnvironment,
  resolveSmokeImageEnvironment,
} from "../../scripts/verify-local-compose-smoke";

const healthyProcesses = [
  { Service: "postgres", State: "running", Health: "healthy" },
  { Service: "database-role-bootstrap", State: "exited", ExitCode: 0 },
  { Service: "migrate", State: "exited", ExitCode: 0 },
  { Service: "database-role-converge", State: "exited", ExitCode: 0 },
  { Service: "web", State: "running", Health: "healthy" },
  { Service: "review-outbox-worker", State: "running" },
  { Service: "llm-reservation-reaper", State: "running" },
  { Service: "backup-scheduler", State: "running", Health: "healthy" },
];

describe("local Compose smoke helpers", () => {
  it("accepts only a loopback-published web port", () => {
    expect(parsePublishedPort("127.0.0.1:43127\n")).toBe(43127);
    expect(() => parsePublishedPort("0.0.0.0:43127\n")).toThrow(/only on 127\.0\.0\.1/);
    expect(() => parsePublishedPort("[::]:43127\n")).toThrow(/only on 127\.0\.0\.1/);
  });

  it("parses both JSON arrays and newline-delimited Compose ps output", () => {
    expect(parseComposePs(JSON.stringify(healthyProcesses))).toEqual(healthyProcesses);
    expect(parseComposePs(healthyProcesses.map((process) => JSON.stringify(process)).join("\n"))).toEqual(healthyProcesses);
  });

  it("requires role governance and migration success plus all long-running services", () => {
    expect(assessServiceStatuses(healthyProcesses)).toEqual({ ok: true, errors: [] });
    const failed = healthyProcesses.map((process) => process.Service === "database-role-bootstrap"
      ? { ...process, ExitCode: 1 }
      : process.Service === "migrate"
        ? { ...process, ExitCode: 1 }
        : process.Service === "database-role-converge"
          ? { ...process, ExitCode: 1 }
          : process.Service === "review-outbox-worker"
            ? { ...process, State: "exited" }
            : process);
    expect(assessServiceStatuses(failed)).toEqual({
      ok: false,
      errors: [
        "database-role-bootstrap must be exited with code 0",
        "migrate must be exited with code 0",
        "database-role-converge must be exited with code 0",
        "review-outbox-worker must be running",
      ],
    });
  });

  it("constructs mandatory finally cleanup arguments", () => {
    expect(buildCleanupCommand("vocab-ob-smoke-42-abcd1234")).toEqual([
      "compose",
      "-f",
      "compose.yaml",
      "-p",
      "vocab-ob-smoke-42-abcd1234",
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
  });

  it("uses the host POSIX identity for the backup bind mount", () => {
    expect(resolveSmokeBackupRuntimeUser("linux", 1001, 121)).toBe("1001:121");
    expect(resolveSmokeBackupRuntimeUser("darwin", 502, 20)).toBe("502:20");
    expect(resolveSmokeBackupRuntimeUser("win32")).toBe("node");
    expect(() => resolveSmokeBackupRuntimeUser("linux", null, null)).toThrow(/Cannot resolve host UID:GID/);
  });

  it("uses isolated postgres-host smoke URLs for all five identities", () => {
    const environment = resolveSmokeDatabaseEnvironment();
    const urls = [
      environment.DATABASE_ADMIN_URL,
      environment.APP_DATABASE_URL,
      environment.WORKER_DATABASE_URL,
      environment.BACKUP_DATABASE_URL,
      environment.MIGRATION_DATABASE_URL,
    ].map((value) => new URL(value));
    expect(urls.map((url) => decodeURIComponent(url.username))).toEqual([
      "vocab_roles_admin",
      "vocab_app",
      "vocab_worker",
      "vocab_backup",
      "vocab_migration",
    ]);
    expect(urls.every((url) => url.hostname === "postgres" && url.pathname === "/vocab")).toBe(true);
    expect(new Set(urls.map((url) => decodeURIComponent(url.password))).size).toBe(5);
    expect(urls.every((url) => decodeURIComponent(url.password).length >= 16)).toBe(true);
  });

  it("preserves prebuilt CI images only in skip-build mode", () => {
    expect(resolveSmokeImageEnvironment({
      APP_IMAGE: "vocab-observatory-v2:ci",
      MIGRATION_IMAGE: "vocab-observatory-v2-migration:ci",
      BACKUP_IMAGE: "vocab-observatory-v2-backup:ci",
    }, true)).toEqual({
      APP_IMAGE: "vocab-observatory-v2:ci",
      MIGRATION_IMAGE: "vocab-observatory-v2-migration:ci",
      BACKUP_IMAGE: "vocab-observatory-v2-backup:ci",
    });
    expect(resolveSmokeImageEnvironment({ APP_IMAGE: "ignored:local" }, false)).toEqual({});
    expect(() => resolveSmokeImageEnvironment({ APP_IMAGE: "vocab-observatory-v2:ci" }, true)).toThrow(/MIGRATION_IMAGE is required/);
  });

  it("constructs project-scoped residue filters", () => {
    expect(buildProjectResourceFilters("vocab-ob-smoke-42-abcd1234")).toEqual({
      containers: ["ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=vocab-ob-smoke-42-abcd1234"],
      volumes: ["volume", "ls", "--quiet", "--filter", "label=com.docker.compose.project=vocab-ob-smoke-42-abcd1234"],
    });
    expect(hasListedResources("\n")).toBe(false);
    expect(hasListedResources("resource-id\n")).toBe(true);
  });
});
