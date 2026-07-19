import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const release = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const promote = readFileSync(resolve(root, ".github/workflows/promote-release.yml"), "utf8");
const ciWorkflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const monthlyDrillWorkflow = readFileSync(resolve(root, ".github/workflows/monthly-drill.yml"), "utf8");
const packageSource = readFileSync(resolve(root, "package.json"), "utf8");
const producerChecks = ["migration-rehearsal", "database-roles", "backup-restore", "rollback-compatibility", "alerting-drill", "secret-rotation"] as const;
type ProducerCheck = (typeof producerChecks)[number];
const producerWorkflows = Object.fromEntries(producerChecks.map((check) => [check, readFileSync(resolve(root, `.github/workflows/release-check-${check}.yml`), "utf8")])) as Record<ProducerCheck, string>;

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { needs?: string | string[]; "runs-on"?: unknown; environment?: unknown; concurrency?: { group?: unknown; "cancel-in-progress"?: unknown }; permissions?: Record<string, string>; env?: Record<string, unknown>; steps?: Step[] };
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
function executableScript(step: Step): string {
  return (step.run ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}
function requireExactExecutableScript(step: Step, expected: string, message: string): void {
  if (executableScript(step) !== expected) throw new Error(message);
}
function requireStepOrder(job: Job, before: string, after: string, jobName: string): void {
  const allSteps = steps(job, jobName);
  const beforeIndex = allSteps.findIndex((step) => step.name === before);
  const afterIndex = allSteps.findIndex((step) => step.name === after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`${before} must run before ${after} in ${jobName}`);
  }
}
function requireDatabaseRolesProducerContract(job: Job, producerName = "database-roles"): void {
  const jobName = `producer ${producerName}`;
  const expectedUsers = {
    APP_DATABASE_URL: "vocab_app",
    WORKER_DATABASE_URL: "vocab_worker",
    BACKUP_DATABASE_URL: "vocab_backup",
    MIGRATION_DATABASE_URL: "vocab_migration",
  } as const;
  const adminValue = job.env?.DATABASE_ADMIN_URL;
  if (typeof adminValue !== "string") throw new Error(`${jobName} must provide DATABASE_ADMIN_URL`);
  if ("TEST_DATABASE_URL" in (job.env ?? {})) throw new Error(`${jobName} must not use the legacy TEST_DATABASE_URL superuser path`);
  let admin: URL;
  try {
    admin = new URL(adminValue);
  } catch {
    throw new Error(`${jobName} DATABASE_ADMIN_URL must be valid`);
  }
  const adminUser = decodeURIComponent(admin.username);
  if (!adminUser || Object.values(expectedUsers).includes(adminUser as (typeof expectedUsers)[keyof typeof expectedUsers])) {
    throw new Error(`${jobName} must use a dedicated administration LOGIN`);
  }
  const passwords = new Set<string>([decodeURIComponent(admin.password)]);
  for (const [name, username] of Object.entries(expectedUsers)) {
    const value = job.env?.[name];
    if (typeof value !== "string") throw new Error(`${jobName} must provide ${name}`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${jobName} ${name} must be valid`);
    }
    if (
      url.protocol !== "postgresql:"
      || decodeURIComponent(url.username) !== username
      || url.hostname !== admin.hostname
      || url.port !== admin.port
      || url.pathname !== admin.pathname
    ) {
      throw new Error(`${jobName} ${name} must authenticate as ${username} on the admin database`);
    }
    passwords.add(decodeURIComponent(url.password));
  }
  if (passwords.size !== 5 || [...passwords].some((password) => password.length < 16)) {
    throw new Error(`${jobName} must use five distinct test-only passwords`);
  }

  const prepare = namedStep(job, "Prepare real database LOGIN roles", jobName);
  const migrate = namedStep(job, "Run authoritative migrations as vocab_migration", jobName);
  const converge = namedStep(job, "Converge database role ownership and privileges", jobName);
  const verifyLogin = namedStep(job, "Verify real database LOGIN isolation", jobName);
  const verify = producerName === "backup-restore"
    ? namedStep(job, "Verify complete RLS backup and restore", jobName)
    : verifyLogin;
  requireExactExecutableScript(prepare, "npm exec -- tsx scripts/bootstrap-database-roles.ts prepare", `${jobName} prepare phase is invalid`);
  requireExactExecutableScript(migrate, "npm run db:migrate", `${jobName} migration phase is invalid`);
  requireExactExecutableScript(converge, "npm exec -- tsx scripts/bootstrap-database-roles.ts converge", `${jobName} converge phase is invalid`);
  requireExactExecutableScript(verifyLogin, "npm run test:db-roles", `${jobName} LOGIN verification phase is invalid`);
  if (producerName === "backup-restore") {
    requireExactExecutableScript(verify, "npm run test:backup-rls", `${jobName} backup verification phase is invalid`);
  }
  if (migrate.env?.DATABASE_URL !== "${{ env.MIGRATION_DATABASE_URL }}") {
    throw new Error(`${jobName} migrations must authenticate through MIGRATION_DATABASE_URL`);
  }
  requireStepOrder(job, prepare.name!, migrate.name!, jobName);
  requireStepOrder(job, migrate.name!, converge.name!, jobName);
  requireStepOrder(job, converge.name!, verifyLogin.name!, jobName);
  if (producerName === "backup-restore") requireStepOrder(job, verifyLogin.name!, verify.name!, jobName);
  const allSteps = steps(job, jobName);
  const convergeIndex = allSteps.indexOf(converge);
  const verifyIndex = allSteps.indexOf(verifyLogin);
  if (verifyIndex !== convergeIndex + 1) {
    throw new Error(`${jobName} must verify memberships immediately after converge revokes temporary migration authority`);
  }
  const executable = steps(job, jobName).map(executableScript).join("\n");
  if (/npm run db:migrate\s*&&\s*npm run test:db-roles/.test(executable) || /\bSET\s+ROLE\b/i.test(executable)) {
    throw new Error(`${jobName} must not fall back to fake superuser role isolation`);
  }
}

function requireRlsAcceptanceContract(
  job: Job,
  jobName: string,
  verificationStepName: string,
  bootstrapScript = [
    "set -euo pipefail",
    "npm run db:migrate",
    "psql \"$DATABASE_URL\" \\",
    "-v ON_ERROR_STOP=1 \\",
    "-f scripts/rls-acceptance-bootstrap.sql",
  ].join("\n"),
): void {
  const verification = namedStep(job, verificationStepName, jobName);
  const resolveJobEnvReference = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const match = value.match(/^\$\{\{ env\.([A-Z0-9_]+) \}\}$/);
    return match ? job.env?.[match[1]!] : value;
  };
  const acceptanceUrl = resolveJobEnvReference(
    verification.env?.RLS_ACCEPTANCE_DATABASE_URL ?? job.env?.RLS_ACCEPTANCE_DATABASE_URL,
  );
  const adminUrl = resolveJobEnvReference(verification.env?.TEST_DATABASE_URL ?? job.env?.TEST_DATABASE_URL);
  if (typeof acceptanceUrl !== "string" || typeof adminUrl !== "string") {
    throw new Error(`${jobName} must provide admin and dedicated RLS acceptance database URLs`);
  }
  let acceptance: URL;
  let admin: URL;
  try {
    acceptance = new URL(acceptanceUrl);
    admin = new URL(adminUrl);
  } catch {
    throw new Error(`${jobName} database URLs must be valid URLs`);
  }
  if (
    acceptance.protocol !== "postgresql:"
    || decodeURIComponent(acceptance.username) !== "vocab_rls_acceptance"
    || decodeURIComponent(admin.username) === "vocab_rls_acceptance"
    || acceptanceUrl === adminUrl
    || acceptance.hostname !== admin.hostname
    || acceptance.port !== admin.port
    || acceptance.pathname !== admin.pathname
  ) {
    throw new Error(`${jobName} must use a distinct dedicated RLS acceptance login on the admin database`);
  }
  const bootstrap = namedStep(job, "Prepare dedicated NOBYPASSRLS acceptance principal", jobName);
  requireExactExecutableScript(
    bootstrap,
    bootstrapScript,
    `${jobName} must migrate and bootstrap the restricted RLS acceptance principal`,
  );
  requireStepOrder(
    job,
    "Prepare dedicated NOBYPASSRLS acceptance principal",
    verificationStepName,
    jobName,
  );
  requireExactExecutableScript(
    verification,
    "npm run verify:db",
    `${jobName} database verification command is missing`,
  );
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
  requireDatabaseRolesProducerContract(verify, "release verify");
  const releaseVerification = namedStep(verify, "Verify database release gates", "release verify");
  if (
    releaseVerification.env?.DATABASE_URL !== "${{ env.MIGRATION_DATABASE_URL }}"
    || releaseVerification.env?.TEST_DATABASE_URL !== "${{ env.DATABASE_ADMIN_URL }}"
  ) {
    throw new Error("Release database gate must use migration DATABASE_URL and admin TEST_DATABASE_URL");
  }
  requireRlsAcceptanceContract(
    verify,
    "release verify",
    "Verify database release gates",
    [
      "set -euo pipefail",
      "psql \"$DATABASE_ADMIN_URL\" \\",
      "-v ON_ERROR_STOP=1 \\",
      "-f scripts/rls-acceptance-bootstrap.sql",
    ].join("\n"),
  );
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
  const acceptanceEvidencePath = "release-evidence/production-acceptance-evidence.json";
  if (acceptanceStep.env?.RELEASE_ACCEPTANCE_EVIDENCE_PATH !== acceptanceEvidencePath) throw new Error("Acceptance evidence path must be explicit and artifact-aligned");
  requireRun(acceptanceStep, /writeFileSync\(process\.env\.RELEASE_ACCEPTANCE_EVIDENCE_PATH,[\s\S]*--acceptance "\$RELEASE_ACCEPTANCE_EVIDENCE_PATH"/, "Acceptance declaration must write and verify the declared evidence path");
  const acceptanceUpload = namedStep(acceptance, "Upload final acceptance evidence", "production-acceptance");
  if (!acceptanceUpload.uses?.startsWith("actions/upload-artifact@") || acceptanceUpload.with?.path !== acceptanceEvidencePath || acceptanceUpload.with?.["if-no-files-found"] !== "error" || acceptanceUpload.with?.["retention-days"] !== 90) throw new Error("Acceptance evidence upload must use the verified output path");
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
    "migration-rehearsal": /npm run test:db-release/,
    "database-roles": /npm run test:db-roles/,
    "backup-restore": /npm run test:backup-rls/,
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
    if (check === "migration-rehearsal" || check === "database-roles" || check === "backup-restore") {
      requireDatabaseRolesProducerContract(job, check);
    }
    if (check === "migration-rehearsal") {
      const rehearsal = namedStep(job, "Run real migration rehearsal", "producer migration-rehearsal");
      requireExactExecutableScript(rehearsal, "npm run test:db-release", "Migration rehearsal verification command is invalid");
      if (
        rehearsal.env?.DATABASE_URL !== "${{ env.MIGRATION_DATABASE_URL }}"
        || rehearsal.env?.TEST_DATABASE_URL !== "${{ env.DATABASE_ADMIN_URL }}"
      ) {
        throw new Error("Migration rehearsal must use migration DATABASE_URL and admin TEST_DATABASE_URL");
      }
      requireStepOrder(job, "Verify real database LOGIN isolation", rehearsal.name!, "producer migration-rehearsal");
    }
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
  const ci = parseWorkflow(source, "CI workflow");
  const verify = ci.jobs?.verify;
  if (!verify) throw new Error("CI verify job is required");
  const volumeUpgrade = namedStep(verify, "Existing-volume database role upgrade rehearsal", "CI verify");
  requireExactExecutableScript(
    volumeUpgrade,
    "npm run db-roles:upgrade:acceptance",
    "CI verify must execute the existing-volume database role upgrade rehearsal",
  );
  requireRlsAcceptanceContract(
    verify,
    "CI verify",
    "Database release verification",
    [
      "set -euo pipefail",
      "psql \"$DATABASE_ADMIN_URL\" \\",
      "-v ON_ERROR_STOP=1 \\",
      "-f scripts/rls-acceptance-bootstrap.sql",
    ].join("\n"),
  );
  requireDatabaseRolesProducerContract(verify, "CI verify");
  const backupRestore = namedStep(verify, "Verify backup image create, signature, and isolated restore", "CI verify");
  requireExactExecutableScript(
    backupRestore,
    "npm run db:restore:container:acceptance",
    "CI verify must execute the real backup container restore acceptance",
  );
  if (backupRestore.env?.BACKUP_IMAGE !== "vocab-observatory-v2-backup:ci") {
    throw new Error("CI backup restore acceptance must use the built backup image");
  }
  const backupSigningKey = backupRestore.env?.BACKUP_SIGNING_KEY;
  if (typeof backupSigningKey !== "string" || backupSigningKey.length < 24) {
    throw new Error("CI backup restore acceptance must use a test-only signing key of at least 24 characters");
  }
  requireStepOrder(verify, "Verify real database LOGIN isolation", backupRestore.name!, "CI verify");
  requireStepOrder(verify, backupRestore.name!, "Prepare dedicated NOBYPASSRLS acceptance principal", "CI verify");
  const verifyPrepare = namedStep(verify, "Prepare real database LOGIN roles", "CI verify");
  const verifyMigrate = namedStep(verify, "Run authoritative migrations as vocab_migration", "CI verify");
  const verifyConverge = namedStep(verify, "Converge database role ownership and privileges", "CI verify");
  requireStepOrder(verify, verifyPrepare.name!, verifyMigrate.name!, "CI verify");
  requireStepOrder(verify, verifyMigrate.name!, verifyConverge.name!, "CI verify");

  const verification = namedStep(verify, "Database release verification", "CI verify");
  if (
    verification.env?.DATABASE_URL !== "${{ env.MIGRATION_DATABASE_URL }}"
    || verification.env?.TEST_DATABASE_URL !== "${{ env.DATABASE_ADMIN_URL }}"
  ) {
    throw new Error("CI verify database gate must use migration DATABASE_URL and admin TEST_DATABASE_URL");
  }
  const bootstrap = namedStep(verify, "Prepare dedicated NOBYPASSRLS acceptance principal", "CI verify");
  requireStepOrder(verify, verifyConverge.name!, bootstrap.name!, "CI verify");
  const replay = namedStep(verify, "Migration replay is a no-op", "CI verify");
  requireExactExecutableScript(replay, "npm run db:migrate", "CI verify migration replay command is invalid");
  if (replay.env?.DATABASE_URL !== "${{ env.MIGRATION_DATABASE_URL }}") {
    throw new Error("CI verify migration replay must authenticate through MIGRATION_DATABASE_URL");
  }
  const lifecycle = namedStep(verify, "Data lifecycle integration and contract gate", "CI verify");
  if (
    lifecycle.env?.TEST_DATABASE_URL !== "${{ env.DATABASE_ADMIN_URL }}"
    || lifecycle.env?.DATA_LIFECYCLE_DATABASE_URL !== "${{ env.DATABASE_ADMIN_URL }}"
  ) {
    throw new Error("CI verify data lifecycle integration must use the dedicated test database admin");
  }

  const e2e = ci.jobs?.e2e;
  if (!e2e) throw new Error("CI Browser E2E job is required");
  const jobName = "CI Browser E2E";
  const expectedUsers = {
    APP_DATABASE_URL: "vocab_app",
    WORKER_DATABASE_URL: "vocab_worker",
    BACKUP_DATABASE_URL: "vocab_backup",
    MIGRATION_DATABASE_URL: "vocab_migration",
  } as const;
  const adminValue = e2e.env?.DATABASE_ADMIN_URL;
  if (typeof adminValue !== "string") throw new Error(`${jobName} must provide DATABASE_ADMIN_URL`);
  let admin: URL;
  try {
    admin = new URL(adminValue);
  } catch {
    throw new Error(`${jobName} DATABASE_ADMIN_URL must be valid`);
  }
  const passwords = new Set([decodeURIComponent(admin.password)]);
  for (const [name, username] of Object.entries(expectedUsers)) {
    const value = e2e.env?.[name];
    if (typeof value !== "string") throw new Error(`${jobName} must provide ${name}`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${jobName} ${name} must be valid`);
    }
    if (
      url.protocol !== "postgresql:"
      || decodeURIComponent(url.username) !== username
      || url.hostname !== admin.hostname
      || url.port !== admin.port
      || url.pathname !== admin.pathname
    ) {
      throw new Error(`${jobName} ${name} must authenticate as ${username} on the admin database`);
    }
    passwords.add(decodeURIComponent(url.password));
  }
  if (passwords.size !== 5 || [...passwords].some((password) => password.length < 16)) {
    throw new Error(`${jobName} must use five distinct test-only passwords`);
  }

  const prepare = namedStep(e2e, "Prepare real database LOGIN roles", jobName);
  const migrate = namedStep(e2e, "Run authoritative migrations as vocab_migration", jobName);
  const converge = namedStep(e2e, "Converge database role ownership and privileges", jobName);
  const runtime = namedStep(e2e, "Run Playwright E2E tests as vocab_app", jobName);
  requireExactExecutableScript(prepare, "npm exec -- tsx scripts/bootstrap-database-roles.ts prepare", `${jobName} prepare phase is invalid`);
  requireExactExecutableScript(migrate, "npm run db:migrate", `${jobName} migration phase is invalid`);
  requireExactExecutableScript(converge, "npm exec -- tsx scripts/bootstrap-database-roles.ts converge", `${jobName} converge phase is invalid`);
  requireExactExecutableScript(runtime, "npm run test:e2e", `${jobName} runtime phase is invalid`);
  if (migrate.env?.DATABASE_URL !== "${{ env.MIGRATION_DATABASE_URL }}") {
    throw new Error(`${jobName} migrations must authenticate through MIGRATION_DATABASE_URL`);
  }
  if (
    runtime.env?.DATABASE_URL !== "${{ env.APP_DATABASE_URL }}"
    || runtime.env?.E2E_SETUP_DATABASE_URL !== "${{ env.DATABASE_ADMIN_URL }}"
  ) {
    throw new Error(`${jobName} must run application traffic as vocab_app with privileged fixture setup isolated to the database admin`);
  }
  requireStepOrder(e2e, prepare.name!, migrate.name!, jobName);
  requireStepOrder(e2e, migrate.name!, converge.name!, jobName);
  requireStepOrder(e2e, converge.name!, runtime.name!, jobName);
}

export function verifyDatabaseVerificationScriptContract(source: string): void {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package.json must be an object");
  }
  const scripts = (value as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("package.json scripts are required");
  }
  const actual = scripts as Record<string, unknown>;
  const expected = {
    "verify:db": "npm run test:db-release && npm run test:integration && npm run test:db-roles && npm run test:capacity",
    "test:db-release": "tsx scripts/verify-release-database.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts --reporter=verbose",
    "test:db-roles": "tsx scripts/verify-database-roles.ts",
    "test:capacity": "tsx scripts/verify-capacity.ts",
  } as const;
  for (const [name, command] of Object.entries(expected)) {
    if (actual[name] !== command) {
      throw new Error(`${name} must match the migration-free database verification contract`);
    }
  }
}

export function verifyMonthlyRecoveryDrillContract(source: string): void {
  const workflow = parseWorkflow(source, "monthly recovery drill");
  exactKeys(workflow.permissions, ["contents"], "Monthly recovery drill permissions are not minimal");
  if (workflow.permissions?.contents !== "read") throw new Error("Monthly recovery drill contents permission must be read");
  exactKeys(workflow.jobs, ["drill"], "Monthly recovery drill must contain only the drill job");
  const drill = workflow.jobs!.drill!;
  const jobName = "monthly recovery drill";
  if (drill["runs-on"] !== "ubuntu-24.04") throw new Error("Monthly recovery drill must use ubuntu-24.04");
  if (drill.permissions) throw new Error("Monthly recovery drill must not add job permissions");
  requireDatabaseRolesProducerContract(drill, jobName);

  const expectedUsers = {
    DRILL_APP_DATABASE_URL: "vocab_app",
    DRILL_WORKER_DATABASE_URL: "vocab_worker",
    DRILL_BACKUP_DATABASE_URL: "vocab_backup",
    DRILL_MIGRATION_DATABASE_URL: "vocab_migration",
  } as const;
  const sourceAdminValue = drill.env?.DATABASE_ADMIN_URL;
  const drillAdminValue = drill.env?.DRILL_DATABASE_ADMIN_URL;
  if (typeof sourceAdminValue !== "string" || typeof drillAdminValue !== "string") {
    throw new Error("Monthly recovery drill must provide source and drill administration URLs");
  }
  let sourceAdmin: URL;
  let drillAdmin: URL;
  try {
    sourceAdmin = new URL(sourceAdminValue);
    drillAdmin = new URL(drillAdminValue);
  } catch {
    throw new Error("Monthly recovery drill administration URLs must be valid");
  }
  if (
    sourceAdmin.protocol !== "postgresql:"
    || drillAdmin.protocol !== "postgresql:"
    || sourceAdmin.username !== drillAdmin.username
    || sourceAdmin.password !== drillAdmin.password
    || sourceAdmin.hostname !== drillAdmin.hostname
    || sourceAdmin.port !== drillAdmin.port
    || sourceAdmin.pathname === drillAdmin.pathname
    || decodeURIComponent(drillAdmin.pathname.slice(1)) !== "vocab_drill"
  ) {
    throw new Error("Monthly recovery drill administration URL must isolate vocab_drill on the source cluster");
  }
  for (const [drillName, username] of Object.entries(expectedUsers)) {
    const sourceName = drillName.replace(/^DRILL_/, "");
    const sourceValue = drill.env?.[sourceName];
    const drillValue = drill.env?.[drillName];
    if (typeof sourceValue !== "string" || typeof drillValue !== "string") {
      throw new Error(`Monthly recovery drill must provide ${sourceName} and ${drillName}`);
    }
    let sourceUrl: URL;
    let drillUrl: URL;
    try {
      sourceUrl = new URL(sourceValue);
      drillUrl = new URL(drillValue);
    } catch {
      throw new Error(`Monthly recovery drill ${drillName} must be valid`);
    }
    if (
      decodeURIComponent(sourceUrl.username) !== username
      || sourceUrl.username !== drillUrl.username
      || sourceUrl.password !== drillUrl.password
      || sourceUrl.hostname !== drillUrl.hostname
      || sourceUrl.port !== drillUrl.port
      || sourceUrl.pathname === drillUrl.pathname
      || drillUrl.pathname !== drillAdmin.pathname
    ) {
      throw new Error(`Monthly recovery drill ${drillName} must reuse ${username} only on the isolated drill database`);
    }
  }

  const backup = namedStep(drill, "Create signed backup as vocab_backup", jobName);
  requireExactExecutableScript(backup, "npm run db:backup", "Monthly recovery drill backup command is invalid");
  if (backup.env?.DATABASE_URL !== "${{ env.BACKUP_DATABASE_URL }}") {
    throw new Error("Monthly recovery drill backup must authenticate through BACKUP_DATABASE_URL");
  }
  const create = namedStep(drill, "Create isolated drill database owned by vocab_migration", jobName);
  requireExactExecutableScript(
    create,
    [
      "set -euo pipefail",
      "psql \"$DATABASE_ADMIN_URL\" -v ON_ERROR_STOP=1 -c \"CREATE DATABASE vocab_drill OWNER vocab_migration;\"",
    ].join("\n"),
    "Monthly recovery drill database creation is invalid",
  );
  const restore = namedStep(drill, "Run isolated restore drill as vocab_migration", jobName);
  if (
    restore.env?.DATABASE_URL !== "${{ env.BACKUP_DATABASE_URL }}"
    || restore.env?.DRILL_DATABASE_URL !== "${{ env.DRILL_MIGRATION_DATABASE_URL }}"
    || restore.env?.DRILL_TEST_DATABASE_URL !== "${{ env.DRILL_DATABASE_ADMIN_URL }}"
  ) {
    throw new Error("Monthly recovery drill restore must read as vocab_backup, restore as vocab_migration, and verify through the drill admin");
  }
  requireExactExecutableScript(
    restore,
    [
      "set -euo pipefail",
      "MANIFEST=$(ls -t backups/*.manifest.json | head -1)",
      "npm run db:restore:drill -- \"$MANIFEST\"",
    ].join("\n"),
    "Monthly recovery drill restore command is invalid",
  );
  const restoredConverge = namedStep(drill, "Converge restored database ownership and privileges", jobName);
  const restoredVerify = namedStep(drill, "Verify restored database LOGIN isolation", jobName);
  requireExactExecutableScript(restoredConverge, "npm exec -- tsx scripts/bootstrap-database-roles.ts converge", "Monthly recovery drill restored converge phase is invalid");
  requireExactExecutableScript(restoredVerify, "npm run test:db-roles", "Monthly recovery drill restored LOGIN verification is invalid");
  for (const [name] of Object.entries(expectedUsers)) {
    const sourceName = name.replace(/^DRILL_/, "");
    if (restoredConverge.env?.[sourceName] !== `\${{ env.${name} }}` || restoredVerify.env?.[sourceName] !== `\${{ env.${name} }}`) {
      throw new Error(`Monthly recovery drill restored verification must route ${sourceName} to ${name}`);
    }
  }
  if (
    restoredConverge.env?.DATABASE_ADMIN_URL !== "${{ env.DRILL_DATABASE_ADMIN_URL }}"
    || restoredVerify.env?.DATABASE_ADMIN_URL !== "${{ env.DRILL_DATABASE_ADMIN_URL }}"
  ) {
    throw new Error("Monthly recovery drill restored governance must use DRILL_DATABASE_ADMIN_URL");
  }
  requireStepOrder(drill, "Verify real database LOGIN isolation", backup.name!, jobName);
  requireStepOrder(drill, backup.name!, create.name!, jobName);
  requireStepOrder(drill, create.name!, restore.name!, jobName);
  requireStepOrder(drill, restore.name!, restoredConverge.name!, jobName);
  requireStepOrder(drill, restoredConverge.name!, restoredVerify.name!, jobName);
  const allSteps = steps(drill, jobName);
  if (allSteps.indexOf(restoredVerify) !== allSteps.indexOf(restoredConverge) + 1) {
    throw new Error("Monthly recovery drill must verify restored LOGIN isolation immediately after converge");
  }
  pinnedActions(workflow, jobName);
  if (/continue-on-error\s*:\s*true/.test(source)) throw new Error("Monthly recovery drill must not continue on error");
}

verifyDatabaseVerificationScriptContract(packageSource);
verifyReleaseWorkflow(release, promote);
verifyCiReleaseManifestContract(ciWorkflow);
verifyMonthlyRecoveryDrillContract(monthlyDrillWorkflow);
console.log("Release workflow contract passed.");
