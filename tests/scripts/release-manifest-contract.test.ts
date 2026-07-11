import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  immutableImageFromEnvironment,
  releaseManifestSummary,
  safeRepositoryOutputPath,
  verifyReleaseManifest,
} from "../../scripts/release-manifest-contract.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const image = (name: string, character: string) => ({
  reference: `ghcr.io/example/${name}@${digest(character)}`,
  digest: digest(character),
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-manifest-"));
  mkdirSync(join(root, "evidence"));
  const evidence = Object.fromEntries(["npmSbom", "runtimeSbom", "migrationSbom", "backupSbom", "migrationJournal"].map((name) => {
    const path = `evidence/${name}.json`;
    const content = JSON.stringify({ name });
    writeFileSync(join(root, path), content);
    return [name, { path, sha256: createHash("sha256").update(content).digest("hex") }];
  }));
  return {
    root,
    manifest: {
      schemaVersion: 2,
      releaseCandidate: "rc-contract-test",
      git: { sha: "a".repeat(40) },
      runtime: { node: "v22.22.0", npm: "10.9.7", postgres: "17" },
      images: { runtime: image("runtime", "1"), migration: image("migration", "2"), backup: image("backup", "3") },
      evidence,
      gates: ["engineering", "database-release", "database-roles", "capacity", "browser-e2e", "supply-chain", "container-runtime", "migration-replay"],
    },
  };
}

describe("release manifest v2 contract", () => {
  it("accepts three complete immutable OCI references", () => {
    const { root, manifest } = fixture();
    expect(verifyReleaseManifest(manifest, root)).toEqual({ evidenceCount: 5 });
  });

  it("rejects mutable tags and local Docker image IDs", () => {
    expect(() => immutableImageFromEnvironment("ghcr.io/example/runtime:latest", "runtime")).toThrow(/immutable OCI reference/);
    expect(() => immutableImageFromEnvironment(digest("1"), "runtime")).toThrow(/immutable OCI reference/);
  });

  it("rejects missing backup and digest/reference mismatch", () => {
    const { root, manifest } = fixture();
    const withoutBackup = structuredClone(manifest);
    delete (withoutBackup.images as Partial<typeof withoutBackup.images>).backup;
    expect(() => verifyReleaseManifest(withoutBackup, root)).toThrow(/images keys/);

    const withExtraImage = structuredClone(manifest) as typeof manifest & { images: typeof manifest.images & { debug: ReturnType<typeof image> } };
    withExtraImage.images.debug = image("debug", "4");
    expect(() => verifyReleaseManifest(withExtraImage, root)).toThrow(/images keys/);

    const mismatch = structuredClone(manifest);
    mismatch.images.runtime.digest = digest("f");
    expect(() => verifyReleaseManifest(mismatch, root)).toThrow(/digest\/reference mismatch/);
  });

  it("rejects traversal, absolute and non-canonical evidence paths", () => {
    for (const path of ["../secret", "/tmp/secret", "C:/secret", "evidence\\npmSbom.json", "evidence//npmSbom.json"]) {
      const { root, manifest } = fixture();
      manifest.evidence.npmSbom.path = path;
      expect(() => verifyReleaseManifest(manifest, root)).toThrow(/Unsafe npmSbom evidence path/);
    }
  });

  it("fails closed on unknown fields and missing input", () => {
    const { root, manifest } = fixture();
    expect(() => verifyReleaseManifest({ ...manifest, unexpected: true }, root)).toThrow(/release manifest keys/);
    expect(() => immutableImageFromEnvironment(undefined, "backup")).toThrow(/Missing backup/);
    expect(() => safeRepositoryOutputPath(root, "../release-manifest.sha256", "release manifest digest")).toThrow(/Unsafe/);
    expect(() => safeRepositoryOutputPath(root, "C:/release-manifest.sha256", "release manifest digest")).toThrow(/Unsafe/);
  });

  it("omits complete registry references from the generator summary", () => {
    const { manifest } = fixture();
    const summary = releaseManifestSummary("f".repeat(64), manifest.images);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("ghcr.io/");
    expect(serialized).not.toContain("@sha256:");
    expect(summary.imageDigests).toEqual({ runtime: digest("1"), migration: digest("2"), backup: digest("3") });
  });
});
