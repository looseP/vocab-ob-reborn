import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const release = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const promote = readFileSync(resolve(root, ".github/workflows/promote-release.yml"), "utf8");
const ciWorkflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const producerChecks = ["migration-rehearsal", "database-roles", "backup-restore", "rollback-compatibility", "alerting-drill", "secret-rotation"] as const;
type ProducerCheck = (typeof producerChecks)[number];
const producerWorkflows = Object.fromEntries(producerChecks.map((check) => [check, readFileSync(resolve(root, `.github/workflows/release-check-${check}.yml`), "utf8")])) as Record<ProducerCheck, string>;

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { needs?: string | string[]; "runs-on"?: unknown; environment?: unknown; concurrency?: { group?: unknown; "cancel-in-progress"?: unknown }; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = { permissions?: Record<string, string>; on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean; type?: string }> } | null; push?: { tags?: string[] } }; jobs?: Record<string, Job> };

function parseWorkflow(source: string, name: string): Workflow {
  const value: unknown = parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${name} YAML`);
  return value as Workflow;
}
function exactKeys(value: object | undefined, expected: readonly string[], message: string): void {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(message);
}
function exactPermissions(job: Job, expected: Record<string, string>, name: string): void {
  exactKeys(job.permissions, Object.keys(expected), `${name} permissions are not minimal`);
  for (const [key, value] of Object.entries(expected)) if (job.permissions?.[key] !== value) throw new Error(`${name} permission ${key} must be ${value}`);
}
function exactNeeds(job: Job, expected: readonly string[], name: string): void {
  const actual = typeof job.needs === "string" ? [job.needs] : job.needs ?? [];
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new Error(`${name} dependencies are invalid`);
}
function steps(job: Job, name: string): Step[] {
  if (!Array.isArray(job.steps)) throw new Error(`${name} steps are required`);
  return job.steps;
}
function namedStep(job: Job, name: string, jobName: string): Step {
  const matches = steps(job, jobName).filter((step) => step.name === name);
  if (matches.length !== 1) throw new Error(`${name} must occur exactly once in ${jobName}`);
  return matches[0]!;
}
function pinnedActions(value: Workflow, name: string): void {
  for (const job of Object.values(value.jobs ?? {})) for (const step of steps(job, name)) if (step.uses && !/@[a-f0-9]{40}$/.test(step.uses)) throw new Error(`${name} action is not pinned: ${step.uses}`);
}
function requireRun(step: Step, pattern: RegExp, message: string): void {
  if (typeof step.run !== "string" || !pattern.test(step.run)) throw new Error(message);
}
function requireDownload(step: Step, artifactOutput: string, path: string, name: string): void {
  if (!step.uses?.startsWith("actions/download-artifact@")) throw new Error(`${name} must use download-artifact`);
  if (step.with?.["artifact-ids"] !== `\${{ needs.resolve-release.outputs.${artifactOutput}-artifact-id }}` || step.with.path !== path || step.with.repository !== "${{ github.repository }}" || step.with["github-token"] !== "${{ secrets.GITHUB_TOKEN }}") throw new Error(`${name} must consume the verified artifact ID in the current repository`);
  if ("name" in (step.with ?? {}) || "run-id" in (step.with ?? {})) throw new Error(`${name} must not re-resolve by name or run ID`);
}

export function verifyReleaseWorkflow(source: string, promotionSource = promote, producers: Record<ProducerCheck, string> = producerWorkflows): void {
  const prepare = parseWorkflow(source, "prepare workflow");
  const promotion = parseWorkflow(promotionSource, "promotion workflow");
  exactKeys(prepare.permissions, [], "Prepare top-level permissions must be empty");
  exactKeys(promotion.permissions, [], "Promotion top-level permissions must be empty");
  exactKeys(prepare.jobs, ["verify", "publish"], "Prepare workflow must contain only verify and publish jobs");
  exactKeys(promotion.jobs, ["resolve-release", "staging", "production-acceptance", "production"], "Promotion workflow job set is invalid");
  exactKeys(prepare.on, ["workflow_dispatch", "push"], "Prepare triggers must contain only workflow_dispatch and push");
  if (!prepare.on || !Object.prototype.hasOwnProperty.call(prepare.on, "workflow_dispatch") || JSON.stringify(prepare.on.push?.tags) !== JSON.stringify(["v*"])) throw new Error("Prepare triggers must be workflow_dispatch and v* tag push");
  const verify = prepare.jobs!.verify!;
  const publish = prepare.jobs!.publish!;
  if (verify["runs-on"] !== "ubuntu-24.04" || publish["runs-on"] !== "ubuntu-24.04") throw new Error("Prepare jobs must use ubuntu-24.04");
  exactPermissions(verify, { contents: "read" }, "verify");
  exactPermissions(publish, { contents: "read", packages: "write" }, "publish");
  exactNeeds(publish, ["verify"], "publish");
  const verifyCheckout = namedStep(verify, "Check out release source", "verify");
  const publishCheckout = namedStep(publish, "Check out release source", "publish");
  for (const [checkout, name] of [[verifyCheckout, "verify"], [publishCheckout, "publish"]] as const) if (!checkout.uses?.startsWith("actions/checkout@") || checkout.with?.["persist-credentials"] !== false) throw new Error(`${name} checkout must not persist credentials`);
  requireRun(namedStep(verify, "Verify supply chain and dependency audit", "verify"), /npm run security:verify/, "Verify security gate is missing");
  requireRun(namedStep(verify, "Verify engineering gates", "verify"), /npm run verify:engineering/, "Verify engineering gate is missing");
  requireRun(namedStep(verify, "Verify database release gates", "verify"), /npm run verify:db/, "Verify database gate is missing");
  const manifestStep = namedStep(publish, "Generate release evidence and manifest", "publish");
  requireRun(manifestStep, /npm run release:manifest[\s\S]*release:manifest:verify[\s\S]*sha256sum --check release-manifest\.sha256[\s\S]*artifact="release-\$\{GITHUB_SHA\}"/, "Publish manifest identity step is incomplete");
  const publishUpload = namedStep(publish, "Upload immutable release evidence", "publish");
  if (!publishUpload.uses?.startsWith("actions/upload-artifact@") || publishUpload.with?.name !== "${{ steps.release.outputs.artifact-name }}" || publishUpload.with?.["if-no-files-found"] !== "error" || publishUpload.with?.["retention-days"] !== 90 || typeof publishUpload.with.path !== "string" || !publishUpload.with.path.includes("release-manifest.json") || !publishUpload.with.path.includes("release-manifest.sha256")) throw new Error("Publish immutable artifact upload is invalid");

  const promotionInputs = promotion.on?.workflow_dispatch?.inputs;
  const requiredInputs = ["prepare_run_id", "migration_rehearsal_run_id", "database_roles_run_id", "backup_restore_run_id", "rollback_compatibility_run_id", "alerting_drill_run_id", "secret_rotation_run_id"];
  exactKeys(promotionInputs, requiredInputs, "Promotion input schema is invalid");
  for (const input of requiredInputs) if (promotionInputs?.[input]?.required !== true || promotionInputs[input]?.type !== "string") throw new Error(`Promotion input ${input} must be a required string`);
  const resolver = promotion.jobs!["resolve-release"]!;
  const staging = promotion.jobs!.staging!;
  const acceptance = promotion.jobs!["production-acceptance"]!;
  const production = promotion.jobs!.production!;
  exactPermissions(resolver, { actions: "read", contents: "read" }, "resolve-release");
  exactPermissions(staging, { actions: "read", contents: "read", packages: "read" }, "staging");
  exactPermissions(acceptance, { actions: "read", contents: "read" }, "production-acceptance");
  exactPermissions(production, { actions: "read", contents: "read", packages: "read" }, "production");
  exactNeeds(staging, ["resolve-release"], "staging");
  exactNeeds(acceptance, ["resolve-release", "staging"], "production-acceptance");
  exactNeeds(production, ["resolve-release", "production-acceptance"], "production");
  if (JSON.stringify(staging["runs-on"]) !== JSON.stringify(["self-hosted", "linux", "vocab-staging"]) || staging.environment !== "staging") throw new Error("Staging runner or environment is invalid");
  if (JSON.stringify(production["runs-on"]) !== JSON.stringify(["self-hosted", "linux", "vocab-production"]) || production.environment !== "production") throw new Error("Production runner or environment is invalid");
  if (acceptance["runs-on"] !== "ubuntu-24.04" || acceptance.environment !== "production" || resolver["runs-on"] !== "ubuntu-24.04") throw new Error("Hosted acceptance/resolve environment is invalid");
  if (staging.concurrency?.group !== "deploy-staging" || staging.concurrency["cancel-in-progress"] !== false || production.concurrency?.group !== "deploy-production" || production.concurrency["cancel-in-progress"] !== false) throw new Error("Deployment concurrency is invalid");

  const resolverStep = namedStep(resolver, "Resolve successful prepare run and unique artifact", "resolve-release");
  requireRun(resolverStep, /prepare-artifact-id=.*GITHUB_OUTPUT[\s\S]*migration-rehearsal-artifact-id[\s\S]*alerting-drill-artifact-id[\s\S]*secret-rotation-artifact-id/, "Resolver must output every verified artifact ID");
  requireRun(resolverStep, /select\(\.status == "completed" and \.conclusion == "success"\)[\s\S]*select\(\.path == "\.github\/workflows\/release\.yml"\)[\s\S]*select\(\.event == "workflow_dispatch" or \.event == "push"\)[\s\S]*select\(\.head_repository\.full_name == \$repo\)[\s\S]*\.head_sha/, "Resolver must bind complete trusted prepare metadata");
  requireRun(resolverStep, /select\(\.status == "completed" and \.conclusion == "success"\)[\s\S]*select\(\.path == \$path and \.event == "workflow_dispatch"\)[\s\S]*select\(\.head_repository\.full_name == \$repo and \.head_sha == \$sha\)/, "Resolver must bind complete trusted evidence metadata");
  const resolverRun = resolverStep.run ?? "";
  if ((resolverRun.match(/\[\.artifacts\[\] \| select\(\.name == \$name\)\] \| select\(length == 1 and \.\[0\]\.expired == false\)/g) ?? []).length !== 2) throw new Error("Resolver prepare and evidence branches must enforce strict artifact uniqueness");
  if ((resolverRun.match(/\[\[ "\$total" -le 100 \]\]/g) ?? []).length !== 2) throw new Error("Resolver prepare and evidence branches must fail closed on artifact pagination");

  for (const [job, jobName] of [[staging, "staging"], [acceptance, "production-acceptance"], [production, "production"]] as const) {
    const checkout = namedStep(job, jobName === "production-acceptance" ? "Check out acceptance verifier" : "Check out deploy adapter", jobName);
    if (!checkout.uses?.startsWith("actions/checkout@") || checkout.with?.ref !== "${{ needs.resolve-release.outputs.release-sha }}" || checkout.with?.["persist-credentials"] !== false) throw new Error(`${jobName} checkout must use resolved release SHA without persisted credentials`);
    const releaseDownloadName = jobName === "production" ? "Download the same immutable release evidence" : "Download immutable release evidence";
    requireDownload(namedStep(job, releaseDownloadName, jobName), "prepare", ".", `${jobName} release download`);
  }
  const verifyStaging = namedStep(staging, "Verify release manifest and identity", "staging");
  const verifyProduction = namedStep(production, "Verify release manifest and identity", "production");
  requireRun(verifyStaging, /manifest\.git\?\.sha !== process\.env\.RELEASE_SHA/, "Staging manifest must bind release SHA");
  requireRun(verifyProduction, /manifest\.git\?\.sha !== process\.env\.RELEASE_SHA/, "Production manifest must bind release SHA");
  const acceptanceStep = namedStep(acceptance, "Create and verify fail-closed acceptance declaration", "production-acceptance");
  requireRun(acceptanceStep, /release:acceptance:verify[\s\S]*--migration-rehearsal-evidence[\s\S]*--alerting-drill-evidence[\s\S]*--secret-rotation-evidence/, "Acceptance verifier step is missing or incomplete");
  if (acceptanceStep.env?.RELEASE_ACCEPTANCE_EVIDENCE_PATH !== "release-evidence/production-acceptance-evidence.json") throw new Error("Acceptance evidence path must be explicit and artifact-aligned");
  const acceptanceUpload = namedStep(acceptance, "Upload final acceptance evidence", "production-acceptance");
  if (!acceptanceUpload.uses?.startsWith("actions/upload-artifact@") || acceptanceUpload.with?.path !== "release-evidence/production-acceptance-evidence.json" || acceptanceUpload.with?.["if-no-files-found"] !== "error" || acceptanceUpload.with?.["retention-days"] !== 90) throw new Error("Acceptance evidence upload must use the verified output path");
  const evidenceDownloads: Array<[string, string, string]> = [
    ["Download migration rehearsal evidence", "migration-rehearsal", "release-evidence/migration-rehearsal"],
    ["Download database roles evidence", "database-roles", "release-evidence/database-roles"],
    ["Download backup restore evidence", "backup-restore", "release-evidence/backup-restore"],
    ["Download rollback compatibility evidence", "rollback-compatibility", "release-evidence/rollback-compatibility"],
    ["Download alerting drill evidence", "alerting-drill", "release-evidence/alerting-drill"],
    ["Download secret rotation evidence", "secret-rotation", "release-evidence/secret-rotation"],
  ];
  for (const [stepName, output, path] of evidenceDownloads) requireDownload(namedStep(acceptance, stepName, "production-acceptance"), output, path, stepName);

  const producerCommands: Record<ProducerCheck, RegExp> = {
    "migration-rehearsal": /npm run db:migrate && npm run test:db-release/,
    "database-roles": /npm run db:migrate && npm run test:db-roles/,
    "backup-restore": /npm run db:restore:drill/,
    "rollback-compatibility": /npm run release:rollback-check/,
    "alerting-drill": /npm run alerting:drill -- --confirm-staging --confirm-reversible/,
    "secret-rotation": /npm run secret-rotation:evidence:verify/,
  };
  for (const check of producerChecks) {
    const producer = parseWorkflow(producers[check], `producer ${check}`);
    exactKeys(producer.jobs, ["check"], `Producer ${check} must contain only check job`);
    exactKeys(producer.permissions, ["actions", "contents"], `Producer ${check} permissions are not minimal`);
    if (producer.permissions?.actions !== "read" || producer.permissions.contents !== "read") throw new Error(`Producer ${check} permissions are not read-only`);
    const input = producer.on?.workflow_dispatch?.inputs?.prepare_run_id;
    if (!input || input.required !== true || input.type !== "string" || Object.keys(producer.on?.workflow_dispatch?.inputs ?? {}).length !== 1) throw new Error(`Producer ${check} must require only prepare_run_id`);
    const job = producer.jobs!.check!;
    const expectedRunner = check === "secret-rotation" ? ["self-hosted", "linux", "vocab-staging"] : "ubuntu-24.04";
    if (JSON.stringify(job["runs-on"]) !== JSON.stringify(expectedRunner)) throw new Error(`Producer ${check} runner is invalid`);
    if (check === "secret-rotation") {
      if (job.environment !== "staging" || job.concurrency?.group !== "release-secret-rotation-staging" || job.concurrency["cancel-in-progress"] !== false) throw new Error("Secret rotation producer must use protected staging environment and serialized execution");
    }
    if (check === "alerting-drill") {
      if (job.environment !== "staging" || job.concurrency?.group !== "release-alerting-drill-staging" || job.concurrency["cancel-in-progress"] !== false) throw new Error("Alerting drill producer must use protected staging environment and serialized execution");
      const drillStep = namedStep(job, "Execute live reversible alert delivery drill", "producer alerting-drill");
      if (drillStep.env?.DRILL_LOCK_FILE !== "${{ vars.DRILL_LOCK_FILE }}") throw new Error("Alerting drill must consume the protected persistent DRILL_LOCK_FILE");
    }
    if (job.permissions) throw new Error(`Producer ${check} must not add job permissions`);
    const allSteps = steps(job, `producer ${check}`);
    if (!allSteps.some((step) => typeof step.run === "string" && /\[\[ "\$PREPARE_RUN_ID" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/.test(step.run) && /\.status == "completed" and \.conclusion == "success" and \.path == "\.github\/workflows\/release\.yml" and \.head_repository\.full_name == \$repo and \.head_sha == \$sha/.test(step.run) && /\[\[ "\$\(jq -er '\.total_count' <<<"\$artifacts"\)" -le 100 \]\]/.test(step.run) && /\(cd prepare && sha256sum --check release-manifest\.sha256\)/.test(step.run) && /sha256sum prepare\/release-manifest\.json/.test(step.run) && /actions\/artifacts\/\$artifact_id\/zip/.test(step.run) && /select\(length == 1 and \.\[0\]\.expired == false\)/.test(step.run))) throw new Error(`Producer ${check} must validate prepare metadata, unique artifact ID, sidecar, and raw manifest hash`);
    if (!allSteps.some((step) => typeof step.run === "string" && producerCommands[check].test(step.run))) throw new Error(`Producer ${check} real check command is missing from check job`);
    const builder = allSteps.filter((step) => step.run?.includes("release:check:evidence"));
    if (builder.length !== 1 || !builder[0]!.run?.includes(`--check ${check.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`) || !builder[0]!.run.includes(`--producer release-check/${check}`) || !builder[0]!.run.includes('--release-sha "$GITHUB_SHA" --manifest-sha256 "$MANIFEST_SHA256"')) throw new Error(`Producer ${check} builder is invalid or outside check job`);
    const uploads = allSteps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    if (uploads.length !== 1 || uploads[0]!.with?.name !== `release-check-${check}` || uploads[0]!.with?.path !== "evidence.json" || uploads[0]!.with?.["if-no-files-found"] !== "error" || uploads[0]!.with?.["retention-days"] !== 90) throw new Error(`Producer ${check} fixed artifact upload is invalid`);
    pinnedActions(producer, `producer ${check}`);
  }
  pinnedActions(prepare, "prepare");
  pinnedActions(promotion, "promotion");
  if (/continue-on-error\s*:\s*true/.test(source + promotionSource + Object.values(producers).join("\n"))) throw new Error("Release workflows must not continue on error");
}

export function verifyCiReleaseManifestContract(source: string): void {
  if (!/docker build --target backup-runtime --tag vocab-observatory-v2-backup:ci/.test(source)) throw new Error("CI must build backup image");
  for (const image of ["runtime", "migration", "backup"]) if (!new RegExp(`sbom-${image}\\.cdx\\.json`).test(source)) throw new Error(`CI must retain ${image} SBOM`);
  if (!/release-manifest\.sha256/.test(source)) throw new Error("CI must retain manifest digest");
}

verifyReleaseWorkflow(release, promote);
verifyCiReleaseManifestContract(ciWorkflow);
console.log("Release workflow contract passed.");
