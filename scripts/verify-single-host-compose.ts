import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifySingleHostCompose(compose: string, caddyfile: string, environment: string): void {
  const requirePattern = (source: string, pattern: RegExp, label: string): void => {
    if (!pattern.test(source)) throw new Error(`${label} is missing or malformed`);
  };

  requirePattern(compose, /^name: vocab-observatory$/m, "Single-host Compose project name");
  requirePattern(compose, /^  caddy:$/m, "Caddy service");
  requirePattern(compose, /image: \$\{CADDY_IMAGE:\?CADDY_IMAGE is required\}/, "Fail-fast pinned Caddy image");
  requirePattern(compose, /image: \$\{POSTGRES_IMAGE:\?POSTGRES_IMAGE is required\}/, "Fail-fast pinned PostgreSQL image");
  requirePattern(compose, /- "\$\{CADDY_HTTP_BIND_ADDRESS:\?CADDY_HTTP_BIND_ADDRESS is required\}:80:80"/, "Fail-fast Caddy HTTP loopback binding");
  requirePattern(compose, /- "\$\{CADDY_HTTPS_BIND_ADDRESS:\?CADDY_HTTPS_BIND_ADDRESS is required\}:443:443"/, "Fail-fast Caddy HTTPS loopback binding");
  requirePattern(compose, /- \$\{CADDY_CONFIG_FILE:\?CADDY_CONFIG_FILE is required\}:\/etc\/caddy\/Caddyfile:ro/, "Fail-fast Caddy configuration file");
  requirePattern(compose, /CADDY_SITE_ADDRESS: \$\{CADDY_SITE_ADDRESS:\?CADDY_SITE_ADDRESS is required\}/, "Fail-fast Caddy site address");
  requirePattern(compose, /APP_ORIGIN: \$\{APP_ORIGIN:\?APP_ORIGIN is required and must be HTTPS\}/, "Fail-fast HTTPS application origin");
  requirePattern(compose, /SINGLE_HOST_DEPLOYMENT: "true"/, "Explicit isolated single-host topology");
  requirePattern(compose, /^  app:\n    internal: true$/m, "Internal app network");
  requirePattern(compose, /^  database:\n    internal: true$/m, "Internal database network");
  requirePattern(compose, /networks:\n      - public\n      - app/, "Caddy public and app network attachment");
  requirePattern(caddyfile, /tls internal/, "Caddy local internal TLS");
  requirePattern(caddyfile, /reverse_proxy web:3001/, "Caddy to web upstream");
  requirePattern(caddyfile, /health_uri \/readyz/, "Caddy readiness health check");
  requirePattern(caddyfile, /Strict-Transport-Security/, "HSTS header");
  requirePattern(caddyfile, /X-Content-Type-Options/, "Content-type protection header");
  requirePattern(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?POSTGRES_PASSWORD is required\}/, "Fail-fast database password");
  requirePattern(compose, /BACKUP_HOST_DIR:\?BACKUP_HOST_DIR is required/, "Fail-fast backup directory");
  requirePattern(compose, /BACKUP_OBJECT_LOCK: "false"/, "Personal-host backup object lock disabled explicitly");
  requirePattern(compose, /read_only: true/, "Read-only application filesystems");
  requirePattern(compose, /no-new-privileges:true/, "No-new-privileges hardening");
  requirePattern(compose, /cap_drop:\n    - ALL/, "Capabilities dropped");
  for (const service of ["postgres", "migrate", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"]) {
    requirePattern(compose, new RegExp(`^  ${service}:$`, "m"), `Single-host service ${service}`);
  }
  if (/^\s+ports:/m.test(compose.replace(/  caddy:[\s\S]*?(?=^  [a-z]|^networks:)/m, ""))) {
    throw new Error("Only Caddy may publish host ports in the single-host Compose file");
  }

  requirePattern(environment, /^APP_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable runtime image template");
  requirePattern(environment, /^MIGRATION_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable migration image template");
  requirePattern(environment, /^BACKUP_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable backup image template");
  requirePattern(environment, /^CADDY_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable Caddy image template");
  requirePattern(environment, /^POSTGRES_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable PostgreSQL image template");
  requirePattern(environment, /^APP_ORIGIN=https:\/\/localhost$/m, "Local HTTPS origin template");
  requirePattern(environment, /^CADDY_SITE_ADDRESS=localhost$/m, "Local Caddy site address template");
  requirePattern(environment, /^CADDY_HTTP_BIND_ADDRESS=127\.0\.0\.1$/m, "Loopback HTTP bind template");
  requirePattern(environment, /^CADDY_HTTPS_BIND_ADDRESS=127\.0\.0\.1$/m, "Loopback HTTPS bind template");
  requirePattern(environment, /^CADDY_CONFIG_FILE=[A-Za-z]:\/.+\/Caddyfile$/m, "Absolute Windows Caddy configuration template");
  requirePattern(environment, /^BACKUP_HOST_DIR=[A-Za-z]:\/.+/m, "Absolute Windows backup directory template");
}

const isDirectExecution = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const root = resolve(import.meta.dirname, "..");
  verifySingleHostCompose(
    readFileSync(resolve(root, "compose.single-host.yaml"), "utf8"),
    readFileSync(resolve(root, "Caddyfile"), "utf8"),
    readFileSync(resolve(root, ".env.single-host.example"), "utf8"),
  );
  console.log(JSON.stringify({ ok: true, deployment: "single-host", proxy: "caddy", databaseNetwork: "database" }));
}
