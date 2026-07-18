import { describe, expect, it } from "vitest";
import {
  assessPublishedSurface,
  assessSingleHostStatuses,
  assertSingleHostSmokeProjectName,
  buildDockerChildEnvironment,
  buildSecureEndpointRequestOptions,
  buildSingleHostCleanupArgs,
  buildSingleHostComposeArgs,
  buildSingleHostProjectResourceFilters,
  collectSmokeSecrets,
  combineSmokeErrors,
  createSingleHostSmokeIdentity,
  parseComposePs,
  parseLoopbackPublishedPort,
  parseSingleHostSmokeArgs,
  redactDiagnostics,
  throwIfSingleHostSmokeInterrupted,
  type ComposeProcess,
} from "../../scripts/verify-single-host-compose-smoke";

const envFile = "D:/vocab observatory/user's env/.env";
const projectName = "vocab-ob-single-host-smoke-1234-abcdef12";

function readyProcesses(): ComposeProcess[] {
  return [
    { Service: "postgres", State: "running", Health: "healthy" },
    { Service: "migrate", State: "exited", ExitCode: 0 },
    { Service: "web", State: "running", Health: "healthy" },
    { Service: "caddy", State: "running", Health: "healthy", Publishers: [
      { URL: "127.0.0.1", TargetPort: 80, PublishedPort: 49152, Protocol: "tcp" },
      { URL: "127.0.0.1", TargetPort: 443, PublishedPort: 49153, Protocol: "tcp" },
    ] },
    { Service: "review-outbox-worker", State: "running" },
    { Service: "llm-reservation-reaper", State: "running" },
    { Service: "backup-scheduler", State: "running", Health: "healthy" },
  ];
}

describe("single-host Compose smoke helpers", () => {
  it("parses absolute Windows env paths as one argv with either slash style", () => {
    expect(parseSingleHostSmokeArgs(["--env-file", "D:\\vocab observatory\\user's env\\.env"], "win32"))
      .toEqual({ envFile: "D:\\vocab observatory\\user's env\\.env", timeoutMs: 180_000 });
    expect(parseSingleHostSmokeArgs(["--env-file", envFile, "--timeout-ms", "25000"], "win32"))
      .toEqual({ envFile, timeoutMs: 25_000 });
  });

  it("fails closed for unsupported platforms and malformed CLI arguments", () => {
    expect(() => parseSingleHostSmokeArgs(["--env-file", envFile], "linux")).toThrow(/only run on Windows/);
    expect(() => parseSingleHostSmokeArgs([], "win32")).toThrow(/--env-file is required/);
    expect(() => parseSingleHostSmokeArgs(["--other", "value"], "win32")).toThrow(/Unknown argument/);
    expect(() => parseSingleHostSmokeArgs(["--env-file"], "win32")).toThrow(/requires a value/);
    expect(() => parseSingleHostSmokeArgs(["--env-file", envFile, "--env-file", envFile], "win32")).toThrow(/only be provided once/);
    expect(() => parseSingleHostSmokeArgs(["--env-file", envFile, "--timeout-ms", "1", "--timeout-ms", "2"], "win32")).toThrow(/only be provided once/);
    expect(() => parseSingleHostSmokeArgs(["--env-file", "relative/.env"], "win32")).toThrow(/absolute drive-rooted Windows path/);
    expect(() => parseSingleHostSmokeArgs(["--env-file", "\\\\server\\share\\.env"], "win32")).toThrow(/drive-rooted/);
    expect(() => parseSingleHostSmokeArgs(["--env-file", "\\\\?\\D:\\env\\.env"], "win32")).toThrow(/drive-rooted/);
    expect(() => parseSingleHostSmokeArgs(["--env-file", envFile, "--timeout-ms", "0"], "win32")).toThrow(/positive integer/);
  });

  it("creates and validates only random run-specific project identities", () => {
    expect(createSingleHostSmokeIdentity(1234, "abcdef12-3456-7890-abcd-ef1234567890")).toBe(projectName);
    expect(() => assertSingleHostSmokeProjectName(projectName)).not.toThrow();
    for (const unsafe of ["vocab-observatory", "vocab-ob-single-host-smoke", "vocab-ob-single-host-smoke-1234-notuuid", "vocab-ob-single-host-smoke-0-abcdef12"]) {
      expect(() => assertSingleHostSmokeProjectName(unsafe)).toThrow(/Refusing non-random/);
    }
  });

  it("always scopes Compose argv to the exact env file, compose file, and random project", () => {
    expect(buildSingleHostComposeArgs(envFile, projectName, ["ps", "--format", "json"])).toEqual([
      "compose", "--env-file", envFile, "-f", "compose.single-host.yaml", "-p", projectName,
      "ps", "--format", "json",
    ]);
    expect(buildSingleHostCleanupArgs(envFile, projectName)).toEqual([
      "compose", "--env-file", envFile, "-f", "compose.single-host.yaml", "-p", projectName,
      "down", "--volumes", "--remove-orphans",
    ]);
    expect(() => buildSingleHostCleanupArgs(envFile, "vocab-observatory")).toThrow(/Refusing non-random/);
  });

  it("parses Compose ps array and NDJSON output", () => {
    const processes = readyProcesses();
    expect(parseComposePs(JSON.stringify(processes))).toEqual(processes);
    expect(parseComposePs(processes.map((process) => JSON.stringify(process)).join("\r\n"))).toEqual(processes);
  });

  it("requires all single-host services in their intended lifecycle states", () => {
    expect(assessSingleHostStatuses(readyProcesses())).toEqual({ ok: true, errors: [] });
    const bad = readyProcesses().map((process) => process.Service === "migrate"
      ? { ...process, State: "running" }
      : process.Service === "caddy" ? { ...process, Health: "starting" } : process);
    expect(assessSingleHostStatuses(bad)).toEqual({
      ok: false,
      errors: ["caddy must be running and healthy", "migrate must be exited with code 0"],
    });
  });

  it("accepts only the two expected IPv4 loopback Caddy publishers", () => {
    const processes = readyProcesses();
    expect(parseLoopbackPublishedPort(processes[3]!.Publishers![0]!, 80)).toBe(49152);
    expect(assessPublishedSurface(processes, { httpPort: 49152, httpsPort: 49153 })).toEqual({ ok: true, errors: [] });
    for (const url of ["0.0.0.0", "::", "[::]"]) {
      const unsafe = readyProcesses();
      unsafe[3]!.Publishers![0]!.URL = url;
      expect(assessPublishedSurface(unsafe, { httpPort: 49152, httpsPort: 49153 }).errors.join(" ")).toMatch(/IPv4 loopback/);
    }
  });

  it("ignores only explicit container-only exposed ports with no host mapping", () => {
    const processes = readyProcesses();
    processes[0]!.Publishers = [{ URL: "", TargetPort: 5432, PublishedPort: 0, Protocol: "tcp" }];
    processes[2]!.Publishers = [{ URL: "", TargetPort: 3001, PublishedPort: "0", Protocol: "tcp" }];
    expect(assessPublishedSurface(processes, { httpPort: 49152, httpsPort: 49153 })).toEqual({ ok: true, errors: [] });
  });

  it("rejects publishers on every service other than Caddy", () => {
    const unsafe = readyProcesses();
    unsafe[2]!.Publishers = [{ URL: "127.0.0.1", TargetPort: 3001, PublishedPort: 49154, Protocol: "tcp" }];
    expect(assessPublishedSurface(unsafe, { httpPort: 49152, httpsPort: 49153 })).toEqual({
      ok: false,
      errors: ["web must not publish host ports"],
    });
  });

  it("fails closed for malformed or ambiguous non-Caddy publisher records", () => {
    const malformedPublishers = [
      { URL: "", TargetPort: 3001, Protocol: "tcp" },
      { URL: "", TargetPort: 3001, PublishedPort: null, Protocol: "tcp" },
      { URL: "", TargetPort: 3001, PublishedPort: "", Protocol: "tcp" },
      { URL: "", TargetPort: 3001, PublishedPort: "abc", Protocol: "tcp" },
      { URL: "", TargetPort: 3001, PublishedPort: Number.NaN, Protocol: "tcp" },
      { URL: "", TargetPort: 3001, PublishedPort: -1, Protocol: "tcp" },
      { URL: "", TargetPort: 3001, PublishedPort: 1.5, Protocol: "tcp" },
      { TargetPort: 3001, PublishedPort: 0, Protocol: "tcp" },
      { URL: null, TargetPort: 3001, PublishedPort: 0, Protocol: "tcp" },
      { URL: "127.0.0.1", TargetPort: 3001, PublishedPort: 0, Protocol: "tcp" },
    ];
    for (const publisher of malformedPublishers) {
      const unsafe = readyProcesses();
      unsafe[2]!.Publishers = [publisher];
      expect(assessPublishedSurface(unsafe, { httpPort: 49152, httpsPort: 49153 }).errors)
        .toContain("web must not publish host ports");
    }

    const malformedCaddy = readyProcesses();
    malformedCaddy[3]!.Publishers![0] = { URL: "127.0.0.1", TargetPort: 80, Protocol: "tcp" };
    expect(assessPublishedSurface(malformedCaddy, { httpPort: 49152, httpsPort: 49153 }).errors.join(" "))
      .toMatch(/high host port/);
  });

  it("redacts every non-empty configured secret without exposing overlap", () => {
    const output = redactDiagnostics(
      "db=password-long owner=owner-token metrics=metrics-token backup=backup-key llm=llm-key blank=",
      ["password-long", "owner-token", "metrics-token", "backup-key", "llm-key", ""],
    );
    expect(output).toBe("db=[REDACTED] owner=[REDACTED] metrics=[REDACTED] backup=[REDACTED] llm=[REDACTED] blank=");
  });

  it("collects complete database URLs and encoded credentials for diagnostics redaction", () => {
    const databaseUrls = {
      DATABASE_ADMIN_URL: "postgresql://admin:admin%2Fsecret@postgres:5432/vocab",
      APP_DATABASE_URL: "postgresql://app:app%23secret@postgres:5432/vocab",
      WORKER_DATABASE_URL: "postgresql://worker:worker%40secret@postgres:5432/vocab",
      BACKUP_DATABASE_URL: "postgresql://backup:backup%25secret@postgres:5432/vocab",
      MIGRATION_DATABASE_URL: "not-a-url-migration-secret",
    };
    const secrets = collectSmokeSecrets({
      ...databaseUrls,
      POSTGRES_PASSWORD: "bootstrap-secret",
      OWNER_API_TOKEN: "owner-token",
    });
    const diagnostic = [
      ...Object.values(databaseUrls),
      "admin admin%2Fsecret admin/secret",
      "app app%23secret app#secret",
      "worker worker%40secret worker@secret",
      "backup backup%25secret backup%secret",
      "bootstrap-secret owner-token",
    ].join("\n");
    const redacted = redactDiagnostics(diagnostic, secrets);
    for (const value of [
      ...Object.values(databaseUrls),
      "admin", "admin%2Fsecret", "admin/secret",
      "app", "app%23secret", "app#secret",
      "worker", "worker%40secret", "worker@secret",
      "backup", "backup%25secret", "backup%secret",
      "bootstrap-secret", "owner-token",
    ]) {
      expect(redacted).not.toContain(value);
    }
  });

  it("does not let ambient Compose values or untracked secrets reach Docker", () => {
    expect(buildDockerChildEnvironment({
      PATH: "C:/Windows/System32",
      DOCKER_CONTEXT: "desktop-linux",
      ProgramFiles: "C:/Program Files",
      "ProgramFiles(x86)": "C:/Program Files (x86)",
      ProgramW6432: "C:/Program Files",
      COMPOSE_FILE: "unsafe.yaml",
      COMPOSE_PROJECT_NAME: "vocab-observatory",
      POSTGRES_PASSWORD: "ambient-secret",
      OWNER_API_TOKEN: "ambient-owner",
      APP_IMAGE: "ambient-image",
      DATABASE_URL: "postgresql://external",
    }, { CADDY_HTTP_HOST_PORT: "49152" })).toEqual({
      PATH: "C:/Windows/System32",
      DOCKER_CONTEXT: "desktop-linux",
      ProgramFiles: "C:/Program Files",
      "ProgramFiles(x86)": "C:/Program Files (x86)",
      ProgramW6432: "C:/Program Files",
      CADDY_HTTP_HOST_PORT: "49152",
    });
  });

  it("treats any recorded signal as a terminal smoke error", () => {
    expect(() => throwIfSingleHostSmokeInterrupted(undefined)).not.toThrow();
    expect(() => throwIfSingleHostSmokeInterrupted("SIGINT")).toThrow(/Interrupted by SIGINT/);
    expect(() => throwIfSingleHostSmokeInterrupted("SIGTERM")).toThrow(/Interrupted by SIGTERM/);
  });

  it("pins strict TLS to 127.0.0.1 while verifying localhost", () => {
    const ca = Buffer.from("temporary-ca");
    expect(buildSecureEndpointRequestOptions(49153, ca, "/readyz")).toEqual({
      host: "127.0.0.1",
      port: 49153,
      path: "/readyz",
      method: "GET",
      servername: "localhost",
      headers: { Host: "localhost" },
      ca,
      rejectUnauthorized: true,
    });
  });

  it("builds read-only label filters for containers, networks, and volumes", () => {
    const label = `label=com.docker.compose.project=${projectName}`;
    expect(buildSingleHostProjectResourceFilters(projectName)).toEqual({
      containers: ["ps", "--all", "--quiet", "--filter", label],
      networks: ["network", "ls", "--quiet", "--filter", label],
      volumes: ["volume", "ls", "--quiet", "--filter", label],
    });
    expect(() => buildSingleHostProjectResourceFilters("vocab-observatory")).toThrow(/Refusing non-random/);
  });

  it("preserves both primary and cleanup errors", () => {
    expect(combineSmokeErrors(undefined, undefined)).toBeUndefined();
    expect(combineSmokeErrors(new Error("primary secret"), new Error("cleanup failed"))?.message)
      .toBe("Smoke failed: primary secret\nCleanup also failed: cleanup failed");
  });
});
