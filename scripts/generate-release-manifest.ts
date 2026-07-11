import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  immutableImageFromEnvironment,
  releaseManifestSummary,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  REQUIRED_GATES,
  safeRepositoryOutputPath,
} from "./release-manifest-contract.js";

const root = resolve(import.meta.dirname, "..");
const output = safeRepositoryOutputPath(root, process.env.RELEASE_MANIFEST_PATH ?? "release-manifest.json", "release manifest");
const digestOutput = safeRepositoryOutputPath(root, process.env.RELEASE_MANIFEST_DIGEST_PATH ?? "release-manifest.sha256", "release manifest digest");
if (output === digestOutput) throw new Error("Release manifest and digest paths must differ");

function command(binary: string, args: string[]): string {
  return execFileSync(binary, args, { cwd: root, encoding: "utf8" }).trim();
}
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}
function requireFile(path: string): string {
  readFileSync(resolve(root, path));
  return path;
}

const gitSha = command("git", ["rev-parse", "HEAD"]);
const trackedChanges = command("git", ["status", "--porcelain", "--untracked-files=no"]);
if (trackedChanges) throw new Error("Release manifest requires no tracked working-tree changes");

const runtimeImage = immutableImageFromEnvironment(process.env.RUNTIME_IMAGE, "runtime");
const migrationImage = immutableImageFromEnvironment(process.env.MIGRATION_IMAGE, "migration");
const backupImage = immutableImageFromEnvironment(process.env.BACKUP_IMAGE, "backup");
const npmSbom = requireFile("sbom-npm.cdx.json");
const runtimeSbom = requireFile("sbom-runtime.cdx.json");
const migrationSbom = requireFile("sbom-migration.cdx.json");
const backupSbom = requireFile("sbom-backup.cdx.json");
const migrationJournal = requireFile("drizzle-release/meta/_journal.json");

const manifest = {
  schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseCandidate: process.env.RELEASE_CANDIDATE ?? `rc-${gitSha.slice(0, 12)}`,
  git: { sha: gitSha },
  runtime: {
    node: process.version,
    npm: command(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    postgres: process.env.POSTGRES_VERSION ?? "17",
  },
  images: { runtime: runtimeImage, migration: migrationImage, backup: backupImage },
  evidence: {
    npmSbom: { path: npmSbom, sha256: sha256(npmSbom) },
    runtimeSbom: { path: runtimeSbom, sha256: sha256(runtimeSbom) },
    migrationSbom: { path: migrationSbom, sha256: sha256(migrationSbom) },
    backupSbom: { path: backupSbom, sha256: sha256(backupSbom) },
    migrationJournal: { path: migrationJournal, sha256: sha256(migrationJournal) },
  },
  gates: [...REQUIRED_GATES],
};
const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = createHash("sha256").update(manifestContents).digest("hex");
writeFileSync(output, manifestContents, { flag: "wx" });
writeFileSync(digestOutput, `${manifestSha256}\n`, { flag: "wx" });
console.log(JSON.stringify(releaseManifestSummary(manifestSha256, manifest.images)));
