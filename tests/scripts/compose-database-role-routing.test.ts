import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const dockerAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const describeDocker = dockerAvailable ? describe : describe.skip;
const localDatabaseUrl = "postgresql://vocab:vocab@postgres:5432/vocab";

interface ComposeConfig {
  services: Record<string, {
    depends_on?: Record<string, unknown>;
    environment?: Record<string, string>;
    ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
  }>;
}

const composeEnvironmentKeys = [
  "APP_IMAGE",
  "MIGRATION_IMAGE",
  "BACKUP_IMAGE",
  "APP_DATABASE_URL",
  "WORKER_DATABASE_URL",
  "BACKUP_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "DATABASE_URL",
  "APP_ORIGIN",
  "OWNER_API_TOKEN",
  "METRICS_BEARER_TOKEN",
  "LOCAL_OWNER_ID",
  "BACKUP_SIGNING_KEY",
  "BACKUP_DIR",
  "BACKUP_HOST_DIR",
  "COMPOSE_FILE",
  "COMPOSE_PROFILES",
] as const;

function composeConfig(files: string[], environment: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  const cleanEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of composeEnvironmentKeys) delete cleanEnvironment[key];
  Object.assign(cleanEnvironment, environment);

  return spawnSync("docker", ["compose", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: cleanEnvironment,
  });
}

function parseConfig(result: ReturnType<typeof spawnSync>): ComposeConfig {
  expect(result.status, result.stderr?.toString()).toBe(0);
  return JSON.parse(result.stdout?.toString() ?? "") as ComposeConfig;
}

const productionEnvironment = {
  APP_IMAGE: "ghcr.io/example/vocab-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  MIGRATION_IMAGE: "ghcr.io/example/vocab-migration@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  BACKUP_IMAGE: "ghcr.io/example/vocab-backup@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  APP_DATABASE_URL: "postgresql://vocab_app:app-secret@db.example.test:5432/vocab",
  WORKER_DATABASE_URL: "postgresql://vocab_worker:worker-secret@db.example.test:5432/vocab",
  BACKUP_DATABASE_URL: "postgresql://vocab_backup:backup-secret@db.example.test:5432/vocab",
  MIGRATION_DATABASE_URL: "postgresql://vocab_migration:migration-secret@db.example.test:5432/vocab",
  APP_ORIGIN: "https://vocab.example.test",
  OWNER_API_TOKEN: "production-owner-token-00000001",
  METRICS_BEARER_TOKEN: "production-metrics-token-00001",
  LOCAL_OWNER_ID: "00000000-0000-4000-8000-000000000002",
  BACKUP_SIGNING_KEY: "production-backup-signing-key-0001",
  BACKUP_DIR: "/backups",
  BACKUP_HOST_DIR: "/var/lib/vocab-backups",
};

describeDocker("Compose rendered database role routing", () => {
  it("renders a runnable local default without extra database roles", () => {
    const config = parseConfig(composeConfig(["compose.yaml"], {
      APP_DATABASE_URL: "",
      WORKER_DATABASE_URL: "",
      BACKUP_DATABASE_URL: "",
      MIGRATION_DATABASE_URL: "",
      DATABASE_URL: "",
    }));

    for (const service of ["migrate", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"]) {
      expect(config.services[service]?.environment?.DATABASE_URL).toBe(localDatabaseUrl);
    }
    expect(config.services.web?.environment).toMatchObject({
      DATABASE_URL: localDatabaseUrl,
      NODE_ENV: "development",
      APP_ORIGIN: "http://127.0.0.1:3001",
      OWNER_API_TOKEN: "local-owner-api-token-only-0001",
      LOCAL_OWNER_ID: "00000000-0000-4000-8000-000000000001",
    });
    expect(config.services["backup-scheduler"]?.environment?.BACKUP_SIGNING_KEY).toBe("local-backup-signing-key-only-0001");
  });

  it("binds only web to loopback and never publishes postgres", () => {
    const config = parseConfig(composeConfig(["compose.yaml"]));
    expect(config.services.web?.ports).toEqual([
      expect.objectContaining({ host_ip: "127.0.0.1", published: "3001", target: 3001 }),
    ]);
    expect(config.services.postgres?.ports).toBeUndefined();
  });

  it("fails production rendering when required values are absent", () => {
    const result = composeConfig(["compose.production.yaml"], {
      APP_DATABASE_URL: "",
      WORKER_DATABASE_URL: "",
      BACKUP_DATABASE_URL: "",
      MIGRATION_DATABASE_URL: "",
      APP_ORIGIN: "",
      OWNER_API_TOKEN: "",
      METRICS_BEARER_TOKEN: "",
      LOCAL_OWNER_ID: "",
      BACKUP_SIGNING_KEY: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required for production");
  });

  it("routes all four production roles and applies production security defaults", () => {
    const config = parseConfig(composeConfig(["compose.production.yaml"], productionEnvironment));
    expect(config.services.migrate?.environment?.DATABASE_URL).toBe(productionEnvironment.MIGRATION_DATABASE_URL);
    expect(config.services.web?.environment).toMatchObject({
      DATABASE_URL: productionEnvironment.APP_DATABASE_URL,
      APP_DATABASE_URL: productionEnvironment.APP_DATABASE_URL,
      APP_ORIGIN: productionEnvironment.APP_ORIGIN,
      NODE_ENV: "production",
      DB_SSLMODE: "verify-full",
    });
    for (const service of ["review-outbox-worker", "llm-reservation-reaper"]) {
      expect(config.services[service]?.environment?.DATABASE_URL).toBe(productionEnvironment.WORKER_DATABASE_URL);
    }
    expect(config.services["backup-scheduler"]?.environment?.DATABASE_URL).toBe(productionEnvironment.BACKUP_DATABASE_URL);
    for (const service of ["migrate", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"]) {
      expect(config.services[service]?.environment?.DB_SSLMODE).toBe("verify-full");
    }
    expect(config.services.web?.ports?.[0]?.host_ip).toBe("127.0.0.1");
    expect(config.services.postgres).toBeUndefined();
    expect(config.services.migrate?.depends_on).toBeUndefined();
    expect(config.services.migrate?.environment?.DB_SSLMODE).toBe("verify-full");
  });
});
