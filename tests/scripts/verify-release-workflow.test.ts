import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCiReleaseManifestContract, verifyReleaseWorkflow } from "../../scripts/verify-release-workflow";

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
const ciWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

describe("release workflow contract", () => {
  it("accepts the repository release workflow", () => {
    expect(() => verifyReleaseWorkflow(workflow)).not.toThrow();
  });

  it("rejects write access on more than publish", () => {
    expect(() => verifyReleaseWorkflow(workflow.replace("packages: read", "packages: write"))).toThrow(/packages: write/);
  });

  it("rejects mutable Syft images", () => {
    expect(() => verifyReleaseWorkflow(workflow.replace(/anchore\/syft@sha256:[a-f0-9]{64}/, "anchore/syft:latest"))).toThrow(/Syft/);
  });

  it("rejects production that does not follow staging", () => {
    expect(() => verifyReleaseWorkflow(workflow.replace("needs: [publish, staging]", "needs: publish"))).toThrow(/follow staging/);
  });

  it("keeps CI aligned with the release manifest v2 evidence contract", () => {
    expect(() => verifyCiReleaseManifestContract(ciWorkflow)).not.toThrow();
    expect(() => verifyCiReleaseManifestContract(ciWorkflow.replace("BACKUP_IMAGE:", "REMOVED_BACKUP_IMAGE:"))).toThrow(/immutable backup/);
    expect(() => verifyCiReleaseManifestContract(ciWorkflow.replaceAll("sbom-migration.cdx.json", "removed-migration-sbom.json"))).toThrow(/migration CycloneDX/);
  });
});
