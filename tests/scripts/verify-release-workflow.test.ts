import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { verifyCiReleaseManifestContract, verifyReleaseWorkflow } from "../../scripts/verify-release-workflow";

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
const promotionWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/promote-release.yml"), "utf8");
const ciWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
const producerNames = ["migration-rehearsal", "database-roles", "backup-restore", "rollback-compatibility", "alerting-drill"] as const;
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
  it("rejects producer upload with weak retention", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "migration-rehearsal": producers["migration-rehearsal"].replace("retention-days: 90", "retention-days: 1") })).toThrow(/upload/));
  it("rejects producer sidecar outside artifact directory", () => expect(() => verifyReleaseWorkflow(workflow, promotionWorkflow, { ...producers, "rollback-compatibility": producers["rollback-compatibility"].replace("(cd prepare && sha256sum --check release-manifest.sha256)", "sha256sum --check prepare/release-manifest.sha256") })).toThrow(/sidecar/));
  it("keeps CI release evidence", () => expect(() => verifyCiReleaseManifestContract(ciWorkflow)).not.toThrow());
  it("uploads layered coverage only after engineering verification succeeds", () => {
    const value = parse(ciWorkflow);
    const upload = value.jobs.verify.steps.find((step: { name?: string }) => step.name === "Upload layered coverage evidence");
    expect(upload?.if).toBeUndefined();
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });
});
