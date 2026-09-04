import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifySingleHostCompose } from "../../scripts/verify-single-host-compose";

const root = resolve(import.meta.dirname, "..", "..");
const compose = readFileSync(resolve(root, "compose.single-host.yaml"), "utf8");
const caddyfile = readFileSync(resolve(root, "Caddyfile"), "utf8");
const environment = readFileSync(resolve(root, ".env.single-host.example"), "utf8");

describe("single-host Compose contract", () => {
  it("accepts the isolated Caddy deployment baseline", () => {
    expect(() => verifySingleHostCompose(compose, caddyfile, environment)).not.toThrow();
  });

  it("rejects a database port published to the host", () => {
    expect(() => verifySingleHostCompose(
      compose.replace("    networks:\n      - database\n    healthcheck:", "    networks:\n      - database\n    ports:\n      - \"5432:5432\"\n    healthcheck:"),
      caddyfile,
      environment,
    )).toThrow(/Only Caddy may publish host ports/);
  });

  it("rejects a Caddy route without readiness checking or local TLS for LF and CRLF", () => {
    for (const lineEnding of ["\n", "\r\n"]) {
      const platformCaddyfile = caddyfile.replace(/\r?\n/g, lineEnding);

      expect(() => verifySingleHostCompose(
        compose,
        platformCaddyfile.replace(
          /^[ \t]*health_uri \/readyz[ \t]*(?:\r?\n|$)/m,
          "",
        ),
        environment,
      )).toThrow(/readiness health check/);
      expect(() => verifySingleHostCompose(
        compose,
        platformCaddyfile.replace(
          /^[ \t]*tls internal[ \t]*(?:\r?\n|$)/m,
          "",
        ),
        environment,
      )).toThrow(/local internal TLS/);
    }
  });

  it("rejects a non-loopback proxy binding or Linux-only backup directory", () => {
    expect(() => verifySingleHostCompose(
      compose.replace("CADDY_HTTP_BIND_ADDRESS:?CADDY_HTTP_BIND_ADDRESS is required", "CADDY_HTTP_BIND_ADDRESS:-0.0.0.0"),
      caddyfile,
      environment,
    )).toThrow(/HTTP loopback binding/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("CADDY_HTTP_BIND_ADDRESS=127.0.0.1", "CADDY_HTTP_BIND_ADDRESS=0.0.0.0"),
    )).toThrow(/Loopback HTTP bind template/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("BACKUP_HOST_DIR=D:/vocab-observatory/backups", "BACKUP_HOST_DIR=/srv/vocab-observatory/backups"),
    )).toThrow(/Absolute Windows backup directory template/);
  });

  it("freezes default host ports and long-syntax Windows bind mounts", () => {
    expect(() => verifySingleHostCompose(
      compose.replace("${CADDY_HTTP_HOST_PORT:-80}:80", "80:80"),
      caddyfile,
      environment,
    )).toThrow(/HTTP loopback binding/);
    expect(() => verifySingleHostCompose(
      compose.replace("        target: /etc/caddy/Caddyfile\n        read_only: true", "        target: /etc/caddy/Caddyfile"),
      caddyfile,
      environment,
    )).toThrow(/configuration file long syntax/);
    expect(() => verifySingleHostCompose(
      compose.replace("      - type: bind\n        source: ${BACKUP_HOST_DIR:?BACKUP_HOST_DIR is required}\n        target: /backups", "      - ${BACKUP_HOST_DIR:?BACKUP_HOST_DIR is required}:/backups"),
      caddyfile,
      environment,
    )).toThrow(/backup directory long syntax/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("CADDY_HTTPS_HOST_PORT=443", "CADDY_HTTPS_HOST_PORT=8443"),
    )).toThrow(/Default Caddy HTTPS host port template/);
  });

  it("rejects an image template that can fall back to a tag", () => {
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("APP_IMAGE=ghcr.io/OWNER/vocab-observatory-runtime@sha256:REPLACE_WITH_64_HEX_DIGEST", "APP_IMAGE=ghcr.io/OWNER/vocab-observatory-runtime:latest"),
    )).toThrow(/Immutable runtime image template/);
  });

  it("rejects shared or leaked privileged database credentials", () => {
    expect(() => verifySingleHostCompose(
      compose.replace(
        "      DATABASE_URL: ${APP_DATABASE_URL:?APP_DATABASE_URL is required}",
        "      DATABASE_URL: postgresql://${POSTGRES_USER:?POSTGRES_USER is required}:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/${POSTGRES_DB:?POSTGRES_DB is required}",
      ),
      caddyfile,
      environment,
    )).toThrow(/shared PostgreSQL credentials|Shared POSTGRES_USER/);
    expect(() => verifySingleHostCompose(
      compose.replace(
        "      DATABASE_URL: ${WORKER_DATABASE_URL:?WORKER_DATABASE_URL is required}\n      OUTBOX_POLL_INTERVAL_MS:",
        "      DATABASE_URL: ${WORKER_DATABASE_URL:?WORKER_DATABASE_URL is required}\n      DATABASE_ADMIN_URL: ${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}\n      OUTBOX_POLL_INTERVAL_MS:",
      ),
      caddyfile,
      environment,
    )).toThrow(/must not receive administration/);
  });

  it("rejects database role username drift, password reuse, or an unusable admin URL", () => {
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("APP_DATABASE_URL=postgresql://vocab_app:", "APP_DATABASE_URL=postgresql://vocab_admin:"),
    )).toThrow(/APP_DATABASE_URL username must be exactly vocab_app/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace(
        "REPLACE_WITH_DISTINCT_LONG_WORKER_DATABASE_PASSWORD",
        "REPLACE_WITH_DISTINCT_LONG_APP_DATABASE_PASSWORD",
      ),
    )).toThrow(/password placeholders must be distinct/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace(
        "POSTGRES_PASSWORD=REPLACE_WITH_DISTINCT_LONG_ADMIN_DATABASE_PASSWORD",
        "POSTGRES_PASSWORD=REPLACE_WITH_DIFFERENT_ADMIN_DATABASE_PASSWORD",
      ),
    )).toThrow(/POSTGRES_PASSWORD must equal the DATABASE_ADMIN_URL password/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace(
        "REPLACE_WITH_DISTINCT_LONG_APP_DATABASE_PASSWORD",
        "REPLACE_WITH_DISTINCT_LONG_ADMIN_DATABASE_PASSWORD",
      ),
    )).toThrow(/password placeholders must be distinct/);
  });

  it("rejects missing or reordered role bootstrap, migration, and convergence", () => {
    expect(() => verifySingleHostCompose(
      compose.replace("      database-role-bootstrap:\n        condition: service_completed_successfully", "      postgres:\n        condition: service_healthy"),
      caddyfile,
      environment,
    )).toThrow(/Migration after role bootstrap/);
    expect(() => verifySingleHostCompose(
      compose.replace('"converge"', '"prepare"'),
      caddyfile,
      environment,
    )).toThrow(/database-role-converge mode/);
    expect(() => verifySingleHostCompose(
      compose.replace("      migrate:\n        condition: service_completed_successfully", "      postgres:\n        condition: service_healthy"),
      caddyfile,
      environment,
    )).toThrow(/Privilege convergence after migration/);
  });

  it("rejects a mutable Caddy image or an implicit topology", () => {
    expect(() => verifySingleHostCompose(
      compose.replace('      SINGLE_HOST_DEPLOYMENT: "true"\n', ""),
      caddyfile,
      environment,
    )).toThrow(/isolated single-host topology/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("CADDY_IMAGE=caddy@sha256:REPLACE_WITH_64_HEX_DIGEST", "CADDY_IMAGE=caddy:latest"),
    )).toThrow(/Immutable Caddy image template/);
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("POSTGRES_IMAGE=postgres@sha256:REPLACE_WITH_64_HEX_DIGEST", "POSTGRES_IMAGE=postgres:17-alpine"),
    )).toThrow(/Immutable PostgreSQL image template/);
  });
});
