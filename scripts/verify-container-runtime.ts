import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
const dockerignoreLines = readFileSync(resolve(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

function requirePattern(source: string, pattern: RegExp, label: string): void {
  if (!pattern.test(source)) throw new Error(`${label} is missing or malformed`);
}

requirePattern(dockerfile, /^FROM node:22\.22\.2-bookworm-slim AS runtime$/m, "Pinned runtime stage");
requirePattern(dockerfile, /^FROM build AS migration$/m, "Dedicated migration stage");
requirePattern(dockerfile, /^RUN npm ci --omit=dev --ignore-scripts/m, "Production-only dependency install");
requirePattern(dockerfile, /FROM node:22\.22\.2-bookworm-slim AS runtime[\s\S]*?^USER node$/m, "Non-root final runtime");
requirePattern(dockerfile, /^RUN npm run frontend:build$/m, "Frontend build");

for (const service of ["migrate", "web", "review-outbox-worker", "llm-reservation-reaper"]) {
  requirePattern(compose, new RegExp(`^  ${service}:$`, "m"), `Compose service ${service}`);
}
requirePattern(compose, /condition: service_completed_successfully/, "Migration dependency");
requirePattern(compose, /target: migration/, "Migration image target");
requirePattern(compose, /scripts\/run-review-outbox-worker\.ts/, "Outbox worker command");
requirePattern(compose, /scripts\/run-llm-reservation-reaper\.ts/, "Reservation reaper command");
requirePattern(compose, /stop_grace_period: \$\{OUTBOX_STOP_GRACE_PERIOD:-75s\}/, "Lease-aware stop grace");
requirePattern(compose, /METRICS_BEARER_TOKEN: \$\{METRICS_BEARER_TOKEN:\?METRICS_BEARER_TOKEN is required\}/, "Metrics bearer token injection");

if (!dockerignoreLines.includes(".env") || !dockerignoreLines.includes(".env.*")) {
  throw new Error("Docker build context must exclude .env and .env.*");
}
if (!dockerignoreLines.includes("node_modules")) {
  throw new Error("Docker build context must exclude node_modules");
}

console.log(JSON.stringify({
  ok: true,
  services: 4,
  productionDependenciesOnly: true,
  nonRoot: true,
  migrationGate: true,
}));
