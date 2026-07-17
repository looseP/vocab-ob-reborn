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
  requirePattern(compose, /- "\$\{CADDY_HTTP_BIND_ADDRESS:\?CADDY_HTTP_BIND_ADDRESS is required\}:\$\{CADDY_HTTP_HOST_PORT:-80\}:80"/, "Fail-fast Caddy HTTP loopback binding");
  requirePattern(compose, /- "\$\{CADDY_HTTPS_BIND_ADDRESS:\?CADDY_HTTPS_BIND_ADDRESS is required\}:\$\{CADDY_HTTPS_HOST_PORT:-443\}:443"/, "Fail-fast Caddy HTTPS loopback binding");
  requirePattern(compose, /- type: bind\n        source: \$\{CADDY_CONFIG_FILE:\?CADDY_CONFIG_FILE is required\}\n        target: \/etc\/caddy\/Caddyfile\n        read_only: true/, "Fail-fast Caddy configuration file long syntax");
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
  requirePattern(compose, /- type: bind\n        source: \$\{BACKUP_HOST_DIR:\?BACKUP_HOST_DIR is required\}\n        target: \/backups/, "Fail-fast backup directory long syntax");
  requirePattern(compose, /BACKUP_OBJECT_LOCK: "false"/, "Personal-host backup object lock disabled explicitly");
  requirePattern(compose, /read_only: true/, "Read-only application filesystems");
  requirePattern(compose, /no-new-privileges:true/, "No-new-privileges hardening");
  requirePattern(compose, /cap_drop:\n    - ALL/, "Capabilities dropped");
  const serviceBlock = (service: string): string => {
    const match = compose.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^networks:)`, "m"));
    if (!match) throw new Error(`Single-host service ${service} is missing or malformed`);
    return match[0];
  };
  for (const service of [
    "postgres",
    "database-role-bootstrap",
    "migrate",
    "database-role-converge",
    "web",
    "review-outbox-worker",
    "llm-reservation-reaper",
    "backup-scheduler",
  ]) serviceBlock(service);
  if (/^\s+ports:/m.test(compose.replace(/  caddy:[\s\S]*?(?=^  [a-z]|^networks:)/m, ""))) {
    throw new Error("Only Caddy may publish host ports in the single-host Compose file");
  }

  const roleJobEnvironment = [
    "DATABASE_ADMIN_URL",
    "APP_DATABASE_URL",
    "WORKER_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
  ];
  for (const service of ["database-role-bootstrap", "database-role-converge"]) {
    const block = serviceBlock(service);
    requirePattern(block, /image: \$\{MIGRATION_IMAGE:\?MIGRATION_IMAGE is required\}/, `${service} migration image`);
    for (const variable of roleJobEnvironment) {
      requirePattern(block, new RegExp(`${variable}: \\$\\{${variable}:\\?${variable} is required\\}`), `${service} ${variable}`);
    }
    requirePattern(block, new RegExp(`bootstrap-database-roles\\.ts", "${service === "database-role-bootstrap" ? "prepare" : "converge"}"`), `${service} mode`);
  }
  requirePattern(serviceBlock("database-role-bootstrap"), /depends_on:\r?\n      postgres:\r?\n        condition: service_healthy/, "Bootstrap after healthy PostgreSQL");
  requirePattern(serviceBlock("migrate"), /DATABASE_URL: \$\{MIGRATION_DATABASE_URL:\?MIGRATION_DATABASE_URL is required\}/, "Migration role routing");
  requirePattern(serviceBlock("migrate"), /depends_on:\r?\n      database-role-bootstrap:\r?\n        condition: service_completed_successfully/, "Migration after role bootstrap");
  requirePattern(serviceBlock("database-role-converge"), /depends_on:\r?\n      migrate:\r?\n        condition: service_completed_successfully/, "Privilege convergence after migration");

  const runtimeRoutes: Record<string, string> = {
    web: "APP_DATABASE_URL",
    "review-outbox-worker": "WORKER_DATABASE_URL",
    "llm-reservation-reaper": "WORKER_DATABASE_URL",
    "backup-scheduler": "BACKUP_DATABASE_URL",
  };
  for (const [service, variable] of Object.entries(runtimeRoutes)) {
    const block = serviceBlock(service);
    requirePattern(block, new RegExp(`DATABASE_URL: \\$\\{${variable}:\\?${variable} is required\\}`), `${service} database role routing`);
    if (/DATABASE_ADMIN_URL|MIGRATION_DATABASE_URL|\$\{POSTGRES_(?:USER|PASSWORD)/.test(block)) {
      throw new Error(`${service} must not receive administration, migration, or shared PostgreSQL credentials`);
    }
  }
  if (/DATABASE_URL:\s+postgresql:\/\/\$\{POSTGRES_USER/.test(compose)) {
    throw new Error("Shared POSTGRES_USER database URLs are forbidden");
  }

  requirePattern(environment, /^APP_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable runtime image template");
  requirePattern(environment, /^MIGRATION_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable migration image template");
  requirePattern(environment, /^BACKUP_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable backup image template");
  requirePattern(environment, /^CADDY_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable Caddy image template");
  requirePattern(environment, /^POSTGRES_IMAGE=.+@sha256:REPLACE_WITH_64_HEX_DIGEST$/m, "Immutable PostgreSQL image template");
  requirePattern(environment, /^APP_ORIGIN=https:\/\/localhost$/m, "Local HTTPS origin template");
  requirePattern(environment, /^CADDY_SITE_ADDRESS=localhost$/m, "Local Caddy site address template");
  requirePattern(environment, /^CADDY_HTTP_BIND_ADDRESS=127\.0\.0\.1$/m, "Loopback HTTP bind template");
  requirePattern(environment, /^CADDY_HTTP_HOST_PORT=80$/m, "Default Caddy HTTP host port template");
  requirePattern(environment, /^CADDY_HTTPS_BIND_ADDRESS=127\.0\.0\.1$/m, "Loopback HTTPS bind template");
  requirePattern(environment, /^CADDY_HTTPS_HOST_PORT=443$/m, "Default Caddy HTTPS host port template");
  requirePattern(environment, /^CADDY_CONFIG_FILE=[A-Za-z]:\/.+\/Caddyfile$/m, "Absolute Windows Caddy configuration template");
  requirePattern(environment, /^BACKUP_HOST_DIR=[A-Za-z]:\/.+/m, "Absolute Windows backup directory template");

  const expectedRoleUsernames: Record<string, string> = {
    DATABASE_ADMIN_URL: "vocab_admin",
    APP_DATABASE_URL: "vocab_app",
    WORKER_DATABASE_URL: "vocab_worker",
    BACKUP_DATABASE_URL: "vocab_backup",
    MIGRATION_DATABASE_URL: "vocab_migration",
  };
  const rolePasswords = new Map<string, string>();
  for (const [variable, username] of Object.entries(expectedRoleUsernames)) {
    const match = environment.match(new RegExp(`^${variable}=postgresql:\\/\\/([^:]+):([^@]+)@postgres:5432/vocab$`, "m"));
    if (!match) throw new Error(`${variable} template is missing or malformed`);
    if (match[1] !== username) throw new Error(`${variable} username must be exactly ${username}`);
    if (match[2]!.length < 24) throw new Error(`${variable} password placeholder must be long`);
    rolePasswords.set(variable, match[2]!);
  }
  if (new Set(rolePasswords.values()).size !== Object.keys(expectedRoleUsernames).length) {
    throw new Error("Database role password placeholders must be distinct");
  }
  requirePattern(environment, /^POSTGRES_USER=vocab_admin$/m, "Dedicated PostgreSQL initialization identity");
  const postgresPassword = environment.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
  if (!postgresPassword || postgresPassword !== rolePasswords.get("DATABASE_ADMIN_URL")) {
    throw new Error("POSTGRES_PASSWORD must equal the DATABASE_ADMIN_URL password");
  }
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
