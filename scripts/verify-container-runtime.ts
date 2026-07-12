import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
const dockerignoreLines = readFileSync(resolve(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

function requirePattern(source: string, pattern: RegExp, label: string): void {
  if (!pattern.test(source)) throw new Error(`${label} is missing or malformed`);
}

requirePattern(dockerfile, /^FROM node:22\.22\.2-bookworm-slim AS runtime$/m, "Pinned runtime stage");
requirePattern(dockerfile, /^FROM build AS migration$/m, "Dedicated migration stage");
requirePattern(dockerfile, /^FROM runtime AS backup-runtime$/m, "Dedicated backup runtime stage");
requirePattern(dockerfile, /^ARG POSTGRES_CLIENT_MAJOR=17$/m, "Pinned PostgreSQL client major");
requirePattern(dockerfile, /postgresql-client-\$\{POSTGRES_CLIENT_MAJOR\}/, "PostgreSQL backup client install");
requirePattern(dockerfile, /FROM runtime AS backup-runtime[\s\S]*?^USER node$/m, "Non-root backup runtime");
requirePattern(dockerfile, /^RUN npm ci --omit=dev --ignore-scripts/m, "Production-only dependency install");
requirePattern(dockerfile, /FROM node:22\.22\.2-bookworm-slim AS runtime[\s\S]*?^USER node$/m, "Non-root final runtime");
requirePattern(dockerfile, /^RUN npm run frontend:build$/m, "Frontend build");

for (const service of ["migrate", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler", "data-lifecycle"]) {
  requirePattern(compose, new RegExp(`^  ${service}:$`, "m"), `Compose service ${service}`);
}
requirePattern(compose, /condition: service_completed_successfully/, "Migration dependency");
requirePattern(compose, /target: migration/, "Migration image target");
requirePattern(compose, /scripts\/run-review-outbox-worker\.ts/, "Outbox worker command");
requirePattern(compose, /scripts\/run-llm-reservation-reaper\.ts/, "Reservation reaper command");
requirePattern(compose, /scripts\/run-backup-scheduler\.ts/, "Backup scheduler command");
const backupService = compose.match(/^  backup-scheduler:\r?\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|^volumes:)/m)?.[1];
if (!backupService) throw new Error("Compose backup scheduler service is missing or malformed");
requirePattern(backupService, /target: backup-runtime/, "Backup runtime image target");
requirePattern(backupService, /POSTGRES_CLIENT_MAJOR: \$\{POSTGRES_CLIENT_MAJOR:-17\}/, "PostgreSQL client major build argument");
requirePattern(backupService, /BACKUP_REQUIRE_SIGNING_KEY: \$\{BACKUP_REQUIRE_SIGNING_KEY:-true\}/, "Production backup signing requirement");
requirePattern(backupService, /pg_dump --version[^\n]*pg_restore --version/, "Backup client binary healthcheck");
requirePattern(envExample, /^BACKUP_IMAGE=vocab-observatory-v2-backup:local$/m, "Backup image example");
requirePattern(envExample, /^BACKUP_REQUIRE_SIGNING_KEY=true$/m, "Backup signing requirement example");
requirePattern(envExample, /^POSTGRES_CLIENT_MAJOR=17$/m, "PostgreSQL client major example");
requirePattern(dockerfile, /scripts\/run-data-lifecycle\.ts/, "Lifecycle script in runtime image");
const lifecycleService = compose.match(/^  data-lifecycle:\r?\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|^volumes:)/m)?.[1];
if (!lifecycleService) throw new Error("Compose lifecycle service is missing or malformed");
requirePattern(lifecycleService, /profiles: \["data-lifecycle"\]/, "Lifecycle opt-in profile");
requirePattern(lifecycleService, /restart: "no"/, "Lifecycle one-shot restart policy");
requirePattern(lifecycleService, /read_only: true/, "Lifecycle read-only filesystem");
requirePattern(lifecycleService, /no-new-privileges:true/, "Lifecycle no-new-privileges option");
requirePattern(lifecycleService, /cap_drop:\s*\n\s*- ALL/, "Lifecycle capabilities dropped");
requirePattern(lifecycleService, /DATA_LIFECYCLE_DATABASE_URL: \$\{DATA_LIFECYCLE_DATABASE_URL:\?/, "Dedicated lifecycle database URL");
requirePattern(lifecycleService, /DATA_LIFECYCLE_CUTOFF: \$\{DATA_LIFECYCLE_CUTOFF:\?/, "Lifecycle approved cutoff");
requirePattern(lifecycleService, /DATA_LIFECYCLE_CONFIRM_CUTOFF: \$\{DATA_LIFECYCLE_CONFIRM_CUTOFF:-\}/, "Lifecycle cutoff confirmation");
requirePattern(lifecycleService, /DATA_LIFECYCLE_CONFIRM: \$\{DATA_LIFECYCLE_CONFIRM:-\}/, "Lifecycle database confirmation");
requirePattern(lifecycleService, /DATA_LIFECYCLE_ALLOW_WRITE: \$\{DATA_LIFECYCLE_ALLOW_WRITE:-\}/, "Lifecycle write confirmation");
requirePattern(lifecycleService, /DATA_LIFECYCLE_ENVIRONMENT: \$\{DATA_LIFECYCLE_ENVIRONMENT:-\}/, "Explicit lifecycle environment");
requirePattern(lifecycleService, /DATA_LIFECYCLE_PRODUCTION_CONFIRM: \$\{DATA_LIFECYCLE_PRODUCTION_CONFIRM:-\}/, "Lifecycle production confirmation");
for (const variable of [
  "DATA_LIFECYCLE_OUTBOX_PROCESSED_DAYS", "DATA_LIFECYCLE_AUTH_SESSION_DAYS",
  "DATA_LIFECYCLE_LLM_TERMINAL_DAYS", "DATA_LIFECYCLE_LLM_SETTLED_DAYS",
  "DATA_LIFECYCLE_REVIEW_LOG_DAYS",
  "DATA_LIFECYCLE_BATCH_SIZE", "DATA_LIFECYCLE_MAX_BATCHES", "DATA_LIFECYCLE_MAX_ROWS",
  "DATA_LIFECYCLE_LOCK_TIMEOUT_MS", "DATA_LIFECYCLE_STATEMENT_TIMEOUT_MS",
]) {
  requirePattern(lifecycleService, new RegExp(`${variable}: \\$\\{${variable}:-`), `Lifecycle setting ${variable}`);
}
requirePattern(lifecycleService, /command: \["\.\/node_modules\/\.bin\/tsx", "scripts\/run-data-lifecycle\.ts"\]/, "Lifecycle default dry-run command");
if (/\bDATABASE_URL\s*:/.test(lifecycleService)) {
  throw new Error("Lifecycle service must not receive DATABASE_URL or fall back to it");
}
if (/\bNODE_ENV\s*:/.test(lifecycleService)) {
  throw new Error("Lifecycle service must use DATA_LIFECYCLE_ENVIRONMENT, not NODE_ENV");
}
requirePattern(compose, /stop_grace_period: \$\{OUTBOX_STOP_GRACE_PERIOD:-75s\}/, "Lease-aware stop grace");
requirePattern(compose, /METRICS_BEARER_TOKEN: \$\{METRICS_BEARER_TOKEN:\?METRICS_BEARER_TOKEN is required\}/, "Metrics bearer token injection");
requirePattern(compose, /BACKUP_SIGNING_KEY: \$\{BACKUP_SIGNING_KEY/, "Backup signing key injection");
requirePattern(compose, /read_only: true/, "Read-only application filesystem");
requirePattern(compose, /no-new-privileges:true/, "No-new-privileges security option");
requirePattern(compose, /cap_drop:\s*\n\s*- ALL/, "All Linux capabilities dropped");
requirePattern(compose, /tmpfs:\s*\n\s*- \/tmp:size=64m,mode=1777/, "Bounded writable tmpfs");

if (!dockerignoreLines.includes(".env") || !dockerignoreLines.includes(".env.*")) {
  throw new Error("Docker build context must exclude .env and .env.*");
}
if (!dockerignoreLines.includes("node_modules")) {
  throw new Error("Docker build context must exclude node_modules");
}

console.log(JSON.stringify({
  ok: true,
  services: 6,
  productionDependenciesOnly: true,
  nonRoot: true,
  readOnlyRootFilesystem: true,
  capabilitiesDropped: true,
  migrationGate: true,
}));
