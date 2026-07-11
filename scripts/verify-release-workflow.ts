import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

export function verifyReleaseWorkflow(source: string): void {
  const requirePattern = (pattern: RegExp, message: string): void => {
    if (!pattern.test(source)) throw new Error(message);
  };
  if (/pull_request_target\s*:/.test(source)) throw new Error("Release workflow must not use pull_request_target");
  requirePattern(/^permissions: \{\}$/m, "Top-level permissions must be empty");
  for (const job of ["verify", "publish", "staging", "production-acceptance", "production"]) requirePattern(new RegExp(`^  ${job}:[\\s\\S]*?^    permissions:`, "m"), `${job} must declare permissions`);
  requirePattern(/^  publish:[\s\S]*?^    needs: verify$/m, "Publish must need verify");
  if ((source.match(/packages: write/g) ?? []).length !== 1) throw new Error("packages: write must appear exactly once");
  requirePattern(/^  publish:[\s\S]*?packages: write/m, "Only publish may write packages");
  for (const job of ["staging", "production"]) {
    requirePattern(new RegExp(`^  ${job}:[\\s\\S]*?packages: read`, "m"), `${job} must read packages`);
    requirePattern(new RegExp(`^  ${job}:[\\s\\S]*?runs-on: \\[self-hosted, linux, vocab-${job}\\]`, "m"), `${job} must use its self-hosted runner`);
    requirePattern(new RegExp(`^  ${job}:[\\s\\S]*?environment: ${job}`, "m"), `${job} environment is required`);
    requirePattern(new RegExp(`^  ${job}:[\\s\\S]*?group: deploy-${job}`, "m"), `${job} concurrency is required`);
    requirePattern(new RegExp(`^  ${job}:[\\s\\S]*?RELEASE_DEPLOY_ENV_FILE: `, "m"), `${job} persistent deploy env is required`);
  }
  requirePattern(/^  production-acceptance:[\s\S]*?needs: \[publish, staging\]/m, "Production acceptance must follow staging");
  requirePattern(/^  production-acceptance:[\s\S]*?environment: production/m, "Production acceptance must use the protected production environment");
  requirePattern(/^  production:[\s\S]*?needs: \[publish, production-acceptance\]/m, "Production must depend on acceptance");
  if (/continue-on-error\s*:\s*true/.test(source)) throw new Error("Release workflow must not continue on error");
  requirePattern(/RELEASE_DEPLOY_EVIDENCE_PATH: \$\{\{ runner\.temp \}\}\/staging-deployment-evidence\.json/, "Staging deployment evidence path is required");
  requirePattern(/^  staging:[\s\S]*?name: staging-evidence-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 90[\s\S]*?(?=^  production-acceptance:)/m, "Staging evidence must be retained for 90 days");
  requirePattern(/^  production-acceptance:[\s\S]*?name: production-acceptance-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 90[\s\S]*?(?=^  production:)/m, "Production acceptance evidence must be retained for 90 days");
  for (const input of ["migration_rehearsal", "database_roles", "backup_restore", "rollback_compatibility", "alerting_drill", "smoke"]) requirePattern(new RegExp(`${input}:`), `Missing acceptance input ${input}`);
  for (const check of ["MIGRATION_REHEARSAL", "DATABASE_ROLES", "BACKUP_RESTORE", "ROLLBACK_COMPATIBILITY", "ALERTING_DRILL"]) {
    requirePattern(new RegExp(`${check}_EVIDENCE_SHA256: \\$\\{\\{ vars\\.${check}_EVIDENCE_SHA256 \\}\\}`), `Missing ${check} provenance digest`);
    requirePattern(new RegExp(`${check}_OBSERVED_AT: \\$\\{\\{ vars\\.${check}_OBSERVED_AT \\}\\}`), `Missing ${check} provenance timestamp`);
  }
  requirePattern(/source: "staging-deployment-evidence"/, "Smoke must be derived from staging evidence");
  for (const target of ["runtime", "migration", "backup"]) requirePattern(new RegExp(`${target}: target\\("${target}"`), `Missing ${target} build target`);
  if ((source.match(/name: \$\{\{ needs\.publish\.outputs\.artifact-name \}\}/g) ?? []).length !== 3) throw new Error("Staging, acceptance, and production must consume the publish artifact");
  if ((source.match(/EXPECTED_MANIFEST_SHA256: \$\{\{ needs\.publish\.outputs\.manifest-sha256 \}\}/g) ?? []).length !== 3) throw new Error("Staging, acceptance, and production must bind the publish manifest digest");
  if ((source.match(/node-version-file: \.nvmrc/g) ?? []).length < 5) throw new Error("Every Node job must use .nvmrc");
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)@([^\s#]+)/gm)) {
    if (!/^[a-f0-9]{40}$/.test(match[2]!)) throw new Error(`Action is not pinned to a 40-hex SHA: ${match[1]}`);
  }
  requirePattern(/anchore\/syft@sha256:[a-f0-9]{64}/, "Syft image must be digest pinned");
  for (const image of ["runtime", "migration", "backup"]) requirePattern(new RegExp(`sbom-${image}\\.cdx\\.json`), `Missing ${image} CycloneDX SBOM`);
  requirePattern(/RELEASE_DEPLOY_ENV_FILE/, "Persistent deploy environment file is required");
}

export function verifyCiReleaseManifestContract(source: string): void {
  const requirePattern = (pattern: RegExp, message: string): void => {
    if (!pattern.test(source)) throw new Error(message);
  };
  requirePattern(/docker build --target backup-runtime --tag vocab-observatory-v2-backup:ci/, "CI must build the backup image");
  for (const image of ["runtime", "migration", "backup"]) {
    requirePattern(new RegExp(`sbom-${image}\\.cdx\\.json`), `CI must generate and retain the ${image} CycloneDX SBOM`);
    requirePattern(new RegExp(`^\\s+${image.toUpperCase()}_IMAGE: [^\\s]+@sha256:[a-f0-9]{64}$`, "m"), `CI must provide an immutable ${image} image reference`);
  }
  requirePattern(/release-manifest\.sha256/, "CI must retain the release manifest digest");
  requirePattern(/drizzle-release\/meta\/_journal\.json/, "CI must retain the migration journal evidence");
}

verifyReleaseWorkflow(workflow);
verifyCiReleaseManifestContract(ciWorkflow);
console.log("Release workflow contract passed.");
