import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  verifyCiReleaseManifestContract,
  verifyDatabaseVerificationScriptContract,
  verifyMonthlyRecoveryDrillContract,
  verifyReleaseWorkflow,
} from "../../scripts/verify-release-workflow";

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
const promotionWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/promote-release.yml"), "utf8");
const ciWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
const monthlyDrillWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/monthly-drill.yml"), "utf8");
const packageSource = readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8");
const producerNames = ["migration-rehearsal", "database-roles", "backup-restore", "rollback-compatibility", "alerting-drill", "secret-rotation"] as const;
const producers = Object.fromEntries(producerNames.map((name) => [name, readFileSync(resolve(import.meta.dirname, `../../.github/workflows/release-check-${name}.yml`), "utf8")])) as Record<(typeof producerNames)[number], string>;

describe("release workflow structured contract", () => {
  it("accepts repository workflows", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, producers)).not.toThrow());
  it("rejects an extra prepare deployment job", () => expect(() => verifyReleaseWorkflow(`${workflow}\n  staging:\n    runs-on: ubuntu-24.04\n`, promotionWorkflow, producers)).toThrow(/only verify and publish/));
  it("rejects an extra promotion publish job", () => expect(() => verifyReleaseWorkflow(workflow, `${promotionWorkflow}\n  publish:\n    runs-on: ubuntu-24.04\n`, producers)).toThrow(/job set/));
  it("rejects production write permissions", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replaceAll("      packages: read", "      packages: read\n      id-token: write"), producers)).toThrow(/permissions/));
  it("rejects missing production environment", () => {
    const value = parse(promotionWorkflow);
    delete value.jobs.production.environment;
    expect(() => verifyReleaseWorkflow(workflow, stringify(value), producers)).toThrow(/runner or environment/);
  });
  it("rejects changed prepare triggers", () => expect(() => verifyReleaseWorkflow(workflow.replace('      - "v*"', '      - "release-*"'), promotionWorkflow, producers)).toThrow(/triggers/));
  it("rejects missing workflow_dispatch trigger", () => {
    const value = parse(workflow);
    delete value.on.workflow_dispatch;
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(/triggers/);
  });
  it("rejects extra prepare triggers", () => {
    const value = parse(workflow);
    value.on.schedule = [{ cron: "0 0 * * *" }];
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(/triggers/);
  });
  it("rejects changed prepare runner", () => expect(() => verifyReleaseWorkflow(workflow.replace("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest"), promotionWorkflow, producers)).toThrow(/ubuntu-24.04/));
  it("rejects missing publish manifest step", () => expect(() => verifyReleaseWorkflow(workflow.replace("npm run release:manifest:verify", "echo skipped"), promotionWorkflow, producers)).toThrow(/manifest identity/));
  it("rejects weak publish artifact upload", () => expect(() => verifyReleaseWorkflow(workflow.replace("retention-days: 90", "retention-days: 1"), promotionWorkflow, producers)).toThrow(/immutable artifact upload/));
  it("rejects a changed staging runner", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("runs-on: [self-hosted, linux, vocab-staging]", "runs-on: ubuntu-24.04"), producers)).toThrow(/runner or environment/));
  it("rejects production bypassing acceptance", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("needs: [resolve-release, production-acceptance]", "needs: staging"), producers)).toThrow(/dependencies/));
  it("rejects checkout moved out of staging", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("      - name: Check out deploy adapter", "      - name: Removed checkout"), producers)).toThrow(/exactly once/));
  it("rejects release download moved out of acceptance", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("      - name: Download immutable release evidence", "      - name: Removed release download"), producers)).toThrow(/exactly once/));
  it("rejects missing acceptance verifier", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("      - name: Create and verify fail-closed acceptance declaration", "      - name: Removed acceptance verifier"), producers)).toThrow(/exactly once/));
  it("rejects artifact consumers falling back to names", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("artifact-ids: ${{ needs.resolve-release.outputs.prepare-artifact-id }}", "name: release-latest"), producers)).toThrow(/verified artifact ID/));
  it("rejects incomplete prepare run metadata predicate", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace('.status == "completed" and .conclusion == "success"', '.status == "completed"'), producers)).toThrow(/complete trusted prepare metadata/));
  it("rejects incomplete evidence run metadata predicate", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace('select(.path == $path and .event == "workflow_dispatch")', 'select(.path == $path)'), producers)).toThrow(/complete trusted evidence metadata/));
  it.each([0, 1])("rejects missing pagination guard in resolver branch %i", (index) => {
    const value = parse(promotionWorkflow);
    const step = value.jobs["resolve-release"].steps.find((candidate: { id?: string }) => candidate.id === "resolve");
    const guard = '[[ "$total" -le 100 ]]';
    const positions = [...step.run.matchAll(/\[\[ "\$total" -le 100 \]\]/g)].map((match: RegExpMatchArray) => match.index!);
    step.run = `${step.run.slice(0, positions[index])}${step.run.slice(positions[index] + guard.length)}`;
    expect(() => verifyReleaseWorkflow(workflow, stringify(value), producers)).toThrow(/pagination/);
  });
  it.each([0, 1])("rejects weak uniqueness in resolver branch %i", (index) => {
    const value = parse(promotionWorkflow);
    const step = value.jobs["resolve-release"].steps.find((candidate: { id?: string }) => candidate.id === "resolve");
    const guard = "[.artifacts[] | select(.name == $name)] | select(length == 1 and .[0].expired == false)";
    const positions = [...step.run.matchAll(/\[\.artifacts\[\] \| select\(\.name == \$name\)\] \| select\(length == 1 and \.\[0\]\.expired == false\)/g)].map((match: RegExpMatchArray) => match.index!);
    step.run = `${step.run.slice(0, positions[index])}${step.run.slice(positions[index] + guard.length)}`;
    expect(() => verifyReleaseWorkflow(workflow, stringify(value), producers)).toThrow(/uniqueness/);
  });
  it("rejects checkout credential persistence", () => {
    const value = parse(promotionWorkflow);
    value.jobs.staging.steps.find((step: { name?: string }) => step.name === "Check out deploy adapter").with["persist-credentials"] = true;
    expect(() => verifyReleaseWorkflow(workflow, stringify(value), producers)).toThrow(/persisted credentials/);
  });
  it("rejects production concurrency changes", () => {
    const value = parse(promotionWorkflow);
    value.jobs.production.concurrency.group = "other";
    value.jobs.production.concurrency["cancel-in-progress"] = true;
    expect(() => verifyReleaseWorkflow(workflow, stringify(value), producers)).toThrow(/concurrency/);
  });
  it("rejects a producer with expanded permissions", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "database-roles": producers["database-roles"].replace("permissions: { actions: read, contents: read }", "permissions: { actions: read, contents: write }") })).toThrow(/read-only/));
  it("rejects producer missing positive prepare run validation", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "database-roles": producers["database-roles"].replace('[[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]]', 'true') })).toThrow(/validate prepare metadata/));
  it("rejects producer missing raw manifest hash", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "backup-restore": producers["backup-restore"].replace("sha256sum prepare/release-manifest.json", "echo digest") })).toThrow(/raw manifest hash/));
  it("rejects producer builder removed from check job", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "backup-restore": producers["backup-restore"].replace("release:check:evidence", "removed-builder") })).toThrow(/builder/));
  it("rejects producer real check removed", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "alerting-drill": producers["alerting-drill"].replace("npm run alerting:drill -- --confirm-staging --confirm-reversible", "echo fake") })).toThrow(/real check/));
  it("rejects database roles producer using the legacy TEST_DATABASE_URL", () => {
    const value = parse(producers["database-roles"]);
    value.jobs.check.env.TEST_DATABASE_URL = value.jobs.check.env.DATABASE_ADMIN_URL;
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "database-roles": stringify(value),
    })).toThrow(/legacy TEST_DATABASE_URL/);
  });
  it("rejects migration rehearsal producer migrating outside the migration LOGIN", () => {
    const value = parse(producers["migration-rehearsal"]);
    const migrate = value.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Run authoritative migrations as vocab_migration",
    );
    migrate.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "migration-rehearsal": stringify(value),
    })).toThrow(/MIGRATION_DATABASE_URL/);
  });
  it("rejects migration rehearsal producer without the governance chain", () => {
    const value = parse(producers["migration-rehearsal"]);
    value.jobs.check.steps = value.jobs.check.steps.filter(
      (step: { name?: string }) => step.name !== "Converge database role ownership and privileges",
    );
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "migration-rehearsal": stringify(value),
    })).toThrow(/Converge database role ownership and privileges/);
  });
  it("rejects migration rehearsal using the admin identity for release verification", () => {
    const value = parse(producers["migration-rehearsal"]);
    const rehearsal = value.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Run real migration rehearsal",
    );
    rehearsal.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "migration-rehearsal": stringify(value),
    })).toThrow(/migration DATABASE_URL and admin TEST_DATABASE_URL/);
  });
  it("rejects database roles producer migrating outside the migration LOGIN", () => {
    const value = parse(producers["database-roles"]);
    const migrate = value.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Run authoritative migrations as vocab_migration",
    );
    migrate.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "database-roles": stringify(value),
    })).toThrow(/MIGRATION_DATABASE_URL/);
  });
  it("rejects database roles producer collapsing to migrate and test under one identity", () => {
    const value = parse(producers["database-roles"]);
    const prepare = value.jobs.check.steps.find(
      (step: { name?: string }) => step.name === "Prepare real database LOGIN roles",
    );
    prepare.run = "npm run db:migrate && npm run test:db-roles";
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "database-roles": stringify(value),
    })).toThrow(/prepare phase|fake superuser role isolation/);
  });
  it("rejects database roles producer with reordered convergence", () => {
    const value = parse(producers["database-roles"]);
    const allSteps = value.jobs.check.steps as Array<{ name?: string }>;
    const migrateIndex = allSteps.findIndex((step) => step.name === "Run authoritative migrations as vocab_migration");
    const convergeIndex = allSteps.findIndex((step) => step.name === "Converge database role ownership and privileges");
    [allSteps[migrateIndex], allSteps[convergeIndex]] = [allSteps[convergeIndex], allSteps[migrateIndex]];
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "database-roles": stringify(value),
    })).toThrow(/must run before/);
  });
  it("rejects database roles producer inserting work between converge revocation and membership verification", () => {
    const value = parse(producers["database-roles"]);
    const allSteps = value.jobs.check.steps as Array<{ name?: string; run?: string }>;
    const verifyIndex = allSteps.findIndex((step) => step.name === "Verify real database LOGIN isolation");
    allSteps.splice(verifyIndex, 0, { name: "Unsafe membership window", run: "true" });
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "database-roles": stringify(value),
    })).toThrow(/immediately after converge/);
  });
  it("rejects backup restore producer that reuses the admin password for a runtime role", () => {
    const value = parse(producers["backup-restore"]);
    value.jobs.check.env.APP_DATABASE_URL = "postgresql://vocab_app:vocab@127.0.0.1:5432/vocab";
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "backup-restore": stringify(value),
    })).toThrow(/five distinct test-only passwords/);
  });
  it("rejects backup restore producer omitting the complete RLS backup restore", () => {
    const value = parse(producers["backup-restore"]);
    value.jobs.check.steps = value.jobs.check.steps.filter(
      (step: { name?: string }) => step.name !== "Verify complete RLS backup and restore",
    );
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "backup-restore": stringify(value),
    })).toThrow(/Verify complete RLS backup and restore/);
  });
  it("rejects database roles producer adding a SET ROLE impersonation path", () => {
    const value = parse(producers["database-roles"]);
    value.jobs.check.steps.push({ name: "Legacy impersonation", run: "psql \"$DATABASE_ADMIN_URL\" -c 'SET ROLE vocab_app'" });
    expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, {
      ...producers,
      "database-roles": stringify(value),
    })).toThrow(/fake superuser role isolation/);
  });
  it("rejects producer upload with weak retention", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "migration-rehearsal": producers["migration-rehearsal"].replace("retention-days: 90", "retention-days: 1") })).toThrow(/upload/));
  it("rejects producer sidecar outside artifact directory", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "rollback-compatibility": producers["rollback-compatibility"].replace("(cd prepare && sha256sum --check release-manifest.sha256)", "sha256sum --check prepare/release-manifest.sha256") })).toThrow(/sidecar/));
  it("rejects alerting drill without a protected persistent lock path", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "alerting-drill": producers["alerting-drill"].replace("DRILL_LOCK_FILE: ${{ vars.DRILL_LOCK_FILE }}", "DRILL_LOCK_FILE: /tmp/drill.lock") })).toThrow(/DRILL_LOCK_FILE/));
  it("rejects secret rotation without serialized protected staging execution", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "secret-rotation": producers["secret-rotation"].replace("group: release-secret-rotation-staging", "group: other") })).toThrow(/Secret rotation producer/));
  it("rejects missing secret rotation acceptance input", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("      secret_rotation_run_id:\n        description: \"Run ID producing release-check-secret-rotation\"\n        required: true\n        type: string\n", ""), producers)).toThrow(/input schema/));
  it("rejects acceptance evidence uploaded from a different path", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("path: release-evidence/production-acceptance-evidence.json", "path: ${{ runner.temp }}/other.json"), producers)).toThrow(/Acceptance evidence/));
  it("rejects acceptance evidence written or verified outside the declared path", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow.replace("writeFileSync(process.env.RELEASE_ACCEPTANCE_EVIDENCE_PATH", "writeFileSync(\"release-evidence/production-acceptance.json\"").replace("--acceptance \"$RELEASE_ACCEPTANCE_EVIDENCE_PATH\"", "--acceptance release-evidence/production-acceptance.json"), producers)).toThrow(/write and verify the declared evidence path/));
  it("keeps CI release evidence and the restricted RLS acceptance contract", () => expect(() => verifyCiReleaseManifestContract(ciWorkflow)).not.toThrow());
  it("rejects CI without backup PostgreSQL client provenance verification", () => {
    const value = parse(ciWorkflow);
    value.jobs.verify.steps = value.jobs.verify.steps.filter(
      (step: { name?: string }) => step.name !== "Verify backup SBOM PostgreSQL client provenance",
    );
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/Verify backup SBOM PostgreSQL client provenance/);
  });
  it("rejects CI when backup provenance is merged after SBOM upload", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const provenanceIndex = allSteps.findIndex((step) => step.name === "Verify backup SBOM PostgreSQL client provenance");
    const uploadIndex = allSteps.findIndex((step) => step.name === "Upload image SBOMs");
    [allSteps[provenanceIndex], allSteps[uploadIndex]] = [allSteps[uploadIndex], allSteps[provenanceIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects CI when backup provenance skips final image version verification", () => {
    const value = parse(ciWorkflow);
    const provenance = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Verify backup SBOM PostgreSQL client provenance",
    );
    provenance.run = provenance.run.replace("docker run --rm --entrypoint pg_restore vocab-observatory-v2-backup:ci --version", "true");
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/verify and merge backup PostgreSQL client provenance/);
  });
  it("rejects CI without the dedicated RLS acceptance URL", () => {
    const value = parse(ciWorkflow);
    const verification = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Database release verification",
    );
    delete verification.env.RLS_ACCEPTANCE_DATABASE_URL;
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(
      /dedicated RLS acceptance database URL/,
    );
  });
  it("rejects CI when the acceptance role name is not the database username", () => {
    const value = parse(ciWorkflow);
    const verification = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Database release verification",
    );
    verification.env.RLS_ACCEPTANCE_DATABASE_URL =
      "postgresql://vocab:vocab_rls_acceptance@localhost:5432/vocab";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(
      /distinct dedicated RLS acceptance login/,
    );
  });
  it("rejects CI when required bootstrap commands only appear in comments", () => {
    const value = parse(ciWorkflow);
    const bootstrap = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Prepare dedicated NOBYPASSRLS acceptance principal",
    );
    bootstrap.run = [
      "# psql \"$DATABASE_ADMIN_URL\" \\",
      "#   -v ON_ERROR_STOP=1 \\",
      "#   -f scripts/rls-acceptance-bootstrap.sql",
      "true",
    ].join("\n");
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(
      /bootstrap the restricted RLS acceptance principal/,
    );
  });
  it("rejects CI when database verification only appears in a comment", () => {
    const value = parse(ciWorkflow);
    const verification = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Database release verification",
    );
    verification.run = "# npm run verify:db\ntrue";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(
      /database verification command is missing/,
    );
  });
  it("rejects release when database verification only appears in a comment", () => {
    const value = parse(workflow);
    const verification = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Verify database release gates",
    );
    verification.run = "# npm run verify:db\ntrue";
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(
      /database verification command is missing/,
    );
  });
  it("rejects CI without an existing-volume role upgrade rehearsal", () => {
    const value = parse(ciWorkflow);
    value.jobs.verify.steps = value.jobs.verify.steps.filter(
      (step: { name?: string }) => step.name !== "Existing-volume database role upgrade rehearsal",
    );
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/Existing-volume database role upgrade rehearsal/);
  });
  it("rejects CI when the existing-volume rehearsal is only a comment", () => {
    const value = parse(ciWorkflow);
    const rehearsal = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Existing-volume database role upgrade rehearsal",
    );
    rehearsal.run = "# npm run db-roles:upgrade:acceptance\ntrue";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/existing-volume database role upgrade rehearsal/);
  });
  it("rejects CI verify migrating before role preparation", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const prepareIndex = allSteps.findIndex((step) => step.name === "Prepare real database LOGIN roles");
    const migrateIndex = allSteps.findIndex((step) => step.name === "Run authoritative migrations as vocab_migration");
    [allSteps[prepareIndex], allSteps[migrateIndex]] = [allSteps[migrateIndex], allSteps[prepareIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects CI verify converging before migration", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const migrateIndex = allSteps.findIndex((step) => step.name === "Run authoritative migrations as vocab_migration");
    const convergeIndex = allSteps.findIndex((step) => step.name === "Converge database role ownership and privileges");
    [allSteps[migrateIndex], allSteps[convergeIndex]] = [allSteps[convergeIndex], allSteps[migrateIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects CI verify migrations outside vocab_migration", () => {
    const value = parse(ciWorkflow);
    const migrate = value.jobs.verify.steps.find((step: { name?: string }) => step.name === "Run authoritative migrations as vocab_migration");
    migrate.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/MIGRATION_DATABASE_URL/);
  });
  it("rejects CI verify database gates using the wrong identities", () => {
    const value = parse(ciWorkflow);
    const verification = value.jobs.verify.steps.find((step: { name?: string }) => step.name === "Database release verification");
    verification.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    verification.env.TEST_DATABASE_URL = "${{ env.MIGRATION_DATABASE_URL }}";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/migration DATABASE_URL and admin TEST_DATABASE_URL/);
  });
  it("rejects CI verify without a real LOGIN isolation step", () => {
    const value = parse(ciWorkflow);
    value.jobs.verify.steps = value.jobs.verify.steps.filter(
      (step: { name?: string }) => step.name !== "Verify real database LOGIN isolation",
    );
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/Verify real database LOGIN isolation/);
  });
  it("rejects CI verify replacing the real LOGIN isolation command", () => {
    const value = parse(ciWorkflow);
    const verification = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Verify real database LOGIN isolation",
    );
    verification.run = "npm run test:integration";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/LOGIN verification phase/);
  });
  it("rejects CI verify separating LOGIN isolation from convergence", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string; run?: string }>;
    const verificationIndex = allSteps.findIndex((step) => step.name === "Verify real database LOGIN isolation");
    allSteps.splice(verificationIndex, 0, { name: "Unrelated step", run: "true" });
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/immediately after converge/);
  });
  it("rejects CI without the real backup container restore acceptance", () => {
    const value = parse(ciWorkflow);
    value.jobs.verify.steps = value.jobs.verify.steps.filter(
      (step: { name?: string }) => step.name !== "Verify backup image create, signature, and isolated restore",
    );
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/Verify backup image create/);
  });
  it("rejects CI when backup container acceptance is replaced or uses another image", () => {
    const value = parse(ciWorkflow);
    const acceptance = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Verify backup image create, signature, and isolated restore",
    );
    acceptance.run = "echo skipped";
    acceptance.env.BACKUP_IMAGE = "another:latest";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/real backup container restore acceptance/);
  });
  it("rejects CI when backup container acceptance runs after RLS bootstrap", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const acceptanceIndex = allSteps.findIndex((step) => step.name === "Verify backup image create, signature, and isolated restore");
    const bootstrapIndex = allSteps.findIndex((step) => step.name === "Prepare dedicated NOBYPASSRLS acceptance principal");
    [allSteps[acceptanceIndex], allSteps[bootstrapIndex]] = [allSteps[bootstrapIndex], allSteps[acceptanceIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects CI verify creating the RLS login before convergence", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const convergeIndex = allSteps.findIndex((step) => step.name === "Converge database role ownership and privileges");
    const bootstrapIndex = allSteps.findIndex((step) => step.name === "Prepare dedicated NOBYPASSRLS acceptance principal");
    [allSteps[convergeIndex], allSteps[bootstrapIndex]] = [allSteps[bootstrapIndex], allSteps[convergeIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects CI verify migration replay outside vocab_migration", () => {
    const value = parse(ciWorkflow);
    const replay = value.jobs.verify.steps.find((step: { name?: string }) => step.name === "Migration replay is a no-op");
    replay.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/replay must authenticate through MIGRATION_DATABASE_URL/);
  });
  it("rejects CI data lifecycle integration using a stale database identity", () => {
    const value = parse(ciWorkflow);
    const lifecycle = value.jobs.verify.steps.find((step: { name?: string }) => step.name === "Data lifecycle integration and contract gate");
    lifecycle.env.TEST_DATABASE_URL = "postgresql://vocab:vocab@localhost:5432/vocab";
    lifecycle.env.DATA_LIFECYCLE_DATABASE_URL = "postgresql://vocab:vocab@localhost:5432/vocab";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/dedicated test database admin/);
  });
  it("rejects CI when RLS bootstrap runs after database verification", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const bootstrapIndex = allSteps.findIndex(
      (step) => step.name === "Prepare dedicated NOBYPASSRLS acceptance principal",
    );
    const verificationIndex = allSteps.findIndex(
      (step) => step.name === "Database release verification",
    );
    [allSteps[bootstrapIndex], allSteps[verificationIndex]] = [
      allSteps[verificationIndex],
      allSteps[bootstrapIndex],
    ];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(
      /must run before/,
    );
  });
  it("rejects Browser E2E migrating before role preparation", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.e2e.steps as Array<{ name?: string }>;
    const prepareIndex = allSteps.findIndex((step) => step.name === "Prepare real database LOGIN roles");
    const migrateIndex = allSteps.findIndex((step) => step.name === "Run authoritative migrations as vocab_migration");
    [allSteps[prepareIndex], allSteps[migrateIndex]] = [allSteps[migrateIndex], allSteps[prepareIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects Browser E2E converging before migration", () => {
    const value = parse(ciWorkflow);
    const allSteps = value.jobs.e2e.steps as Array<{ name?: string }>;
    const migrateIndex = allSteps.findIndex((step) => step.name === "Run authoritative migrations as vocab_migration");
    const convergeIndex = allSteps.findIndex((step) => step.name === "Converge database role ownership and privileges");
    [allSteps[migrateIndex], allSteps[convergeIndex]] = [allSteps[convergeIndex], allSteps[migrateIndex]];
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/must run before/);
  });
  it("rejects Browser E2E role governance commands that only appear in comments", () => {
    const value = parse(ciWorkflow);
    const prepare = value.jobs.e2e.steps.find((step: { name?: string }) => step.name === "Prepare real database LOGIN roles");
    prepare.run = "# npm exec -- tsx scripts/bootstrap-database-roles.ts prepare\ntrue";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/prepare phase/);
  });
  it("rejects Browser E2E migrations outside vocab_migration", () => {
    const value = parse(ciWorkflow);
    const migrate = value.jobs.e2e.steps.find((step: { name?: string }) => step.name === "Run authoritative migrations as vocab_migration");
    migrate.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/MIGRATION_DATABASE_URL/);
  });
  it("rejects Browser E2E fixture setup falling back to vocab_app", () => {
    const value = parse(ciWorkflow);
    const runtime = value.jobs.e2e.steps.find((step: { name?: string }) => step.name === "Run Playwright E2E tests as vocab_app");
    runtime.env.E2E_SETUP_DATABASE_URL = "${{ env.APP_DATABASE_URL }}";
    expect(() => verifyCiReleaseManifestContract(stringify(value))).toThrow(/fixture setup isolated to the database admin/);
  });
  it("rejects release verification migrating outside vocab_migration", () => {
    const value = parse(workflow);
    const migrate = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Run authoritative migrations as vocab_migration",
    );
    migrate.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(/MIGRATION_DATABASE_URL/);
  });
  it("rejects release verification with reordered convergence", () => {
    const value = parse(workflow);
    const allSteps = value.jobs.verify.steps as Array<{ name?: string }>;
    const migrateIndex = allSteps.findIndex((step) => step.name === "Run authoritative migrations as vocab_migration");
    const convergeIndex = allSteps.findIndex((step) => step.name === "Converge database role ownership and privileges");
    [allSteps[migrateIndex], allSteps[convergeIndex]] = [allSteps[convergeIndex], allSteps[migrateIndex]];
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(/must run before/);
  });
  it("rejects release verification database gates under the wrong identities", () => {
    const value = parse(workflow);
    const verification = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Verify database release gates",
    );
    verification.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(/migration DATABASE_URL and admin TEST_DATABASE_URL/);
  });
  it("rejects release verification without the RLS bootstrap SQL", () => {
    const value = parse(workflow);
    const bootstrap = value.jobs.verify.steps.find(
      (step: { name?: string }) => step.name === "Prepare dedicated NOBYPASSRLS acceptance principal",
    );
    bootstrap.run = "npm run db:migrate";
    expect(() => verifyReleaseWorkflow(stringify(value), promotionWorkflow, producers)).toThrow(
      /bootstrap the restricted RLS acceptance principal/,
    );
  });
  it("accepts the migration-free database verification script", () => {
    expect(() => verifyDatabaseVerificationScriptContract(packageSource)).not.toThrow();
  });
  it.each([
    "verify:db",
    "test:db-release",
    "test:integration",
    "test:db-roles",
    "test:capacity",
  ])("rejects database verification script %s when it hides another migration", (name) => {
    const value = JSON.parse(packageSource);
    value.scripts[name] = `npm run db:migrate && ${value.scripts[name]}`;
    expect(() => verifyDatabaseVerificationScriptContract(JSON.stringify(value))).toThrow(/migration-free/);
  });
  it("accepts the governed monthly recovery drill", () => {
    expect(() => verifyMonthlyRecoveryDrillContract(monthlyDrillWorkflow)).not.toThrow();
  });
  it("rejects monthly recovery migrations outside vocab_migration", () => {
    const value = parse(monthlyDrillWorkflow);
    const migrate = value.jobs.drill.steps.find(
      (step: { name?: string }) => step.name === "Run authoritative migrations as vocab_migration",
    );
    migrate.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/MIGRATION_DATABASE_URL/);
  });
  it("rejects monthly recovery backups using the administration identity", () => {
    const value = parse(monthlyDrillWorkflow);
    const backup = value.jobs.drill.steps.find(
      (step: { name?: string }) => step.name === "Create signed backup as vocab_backup",
    );
    backup.env.DATABASE_URL = "${{ env.DATABASE_ADMIN_URL }}";
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/BACKUP_DATABASE_URL/);
  });
  it("rejects monthly recovery drill databases owned by the administrator", () => {
    const value = parse(monthlyDrillWorkflow);
    const create = value.jobs.drill.steps.find(
      (step: { name?: string }) => step.name === "Create isolated drill database owned by vocab_migration",
    );
    create.run = create.run.replace("OWNER vocab_migration", "OWNER vocab_drill_admin");
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/database creation/);
  });
  it("rejects monthly recovery restores outside the migration identity", () => {
    const value = parse(monthlyDrillWorkflow);
    const restore = value.jobs.drill.steps.find(
      (step: { name?: string }) => step.name === "Run isolated restore drill as vocab_migration",
    );
    restore.env.DRILL_DATABASE_URL = "${{ env.DRILL_DATABASE_ADMIN_URL }}";
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/restore as vocab_migration/);
  });
  it("rejects monthly recovery release verification under the restore identity", () => {
    const value = parse(monthlyDrillWorkflow);
    const restore = value.jobs.drill.steps.find(
      (step: { name?: string }) => step.name === "Run isolated restore drill as vocab_migration",
    );
    restore.env.DRILL_TEST_DATABASE_URL = "${{ env.DRILL_MIGRATION_DATABASE_URL }}";
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/verify through the drill admin/);
  });
  it("rejects monthly recovery restore verification without convergence", () => {
    const value = parse(monthlyDrillWorkflow);
    value.jobs.drill.steps = value.jobs.drill.steps.filter(
      (step: { name?: string }) => step.name !== "Converge restored database ownership and privileges",
    );
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/Converge restored database ownership and privileges/);
  });
  it("rejects monthly recovery restore verification against the source database", () => {
    const value = parse(monthlyDrillWorkflow);
    const verification = value.jobs.drill.steps.find(
      (step: { name?: string }) => step.name === "Verify restored database LOGIN isolation",
    );
    verification.env.APP_DATABASE_URL = "${{ env.APP_DATABASE_URL }}";
    expect(() => verifyMonthlyRecoveryDrillContract(stringify(value))).toThrow(/DRILL_APP_DATABASE_URL/);
  });
  it("uploads layered coverage only after engineering verification succeeds", () => {
    const value = parse(ciWorkflow);
    const upload = value.jobs.verify.steps.find((step: { name?: string }) => step.name === "Upload layered coverage evidence");
    expect(upload?.if).toBeUndefined();
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });
});
