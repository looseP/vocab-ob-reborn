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
      environment.replace("BACKUP_HOST_DIR=D:/vocab-observatory/backups", "BACKUP_HOST_DIR=/srv/vocab-observatory/backups"),
    )).toThrow(/Absolute Windows backup directory template/);
  });

  it("rejects an image template that can fall back to a tag", () => {
    expect(() => verifySingleHostCompose(
      compose,
      caddyfile,
      environment.replace("APP_IMAGE=ghcr.io/OWNER/vocab-observatory-runtime@sha256:REPLACE_WITH_64_HEX_DIGEST", "APP_IMAGE=ghcr.io/OWNER/vocab-observatory-runtime:latest"),
    )).toThrow(/Immutable runtime image template/);
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
