import { describe, expect, it } from "vitest";
import {
  assessServiceStatuses,
  buildCleanupCommand,
  buildProjectResourceFilters,
  hasListedResources,
  parseComposePs,
  parsePublishedPort,
  resolveSmokeBackupRuntimeUser,
  resolveSmokeImageEnvironment,
} from "../../scripts/verify-local-compose-smoke";

const healthyProcesses = [
  { Service: "postgres", State: "running", Health: "healthy" },
  { Service: "migrate", State: "exited", ExitCode: 0 },
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

  it("requires migration success and all long-running services", () => {
    expect(assessServiceStatuses(healthyProcesses)).toEqual({ ok: true, errors: [] });
    const failed = healthyProcesses.map((process) => process.Service === "migrate"
      ? { ...process, ExitCode: 1 }
      : process.Service === "review-outbox-worker"
        ? { ...process, State: "exited" }
        : process);
    expect(assessServiceStatuses(failed)).toEqual({
      ok: false,
      errors: [
        "migrate must be exited with code 0",
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
    expect(() => resolveSmokeBackupRuntimeUser("linux", undefined, undefined)).toThrow(/Cannot resolve host UID:GID/);
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
