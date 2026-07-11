import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.env.RELEASE_MANIFEST_PATH ?? "release-manifest.json");

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

const runtimeImage = process.env.RUNTIME_IMAGE ?? "vocab-observatory-v2:ci";
const migrationImage = process.env.MIGRATION_IMAGE ?? "vocab-observatory-v2-migration:ci";
const runtimeImageId = command("docker", ["image", "inspect", runtimeImage, "--format", "{{.Id}}"]).replace(/^sha256:/, "");
const migrationImageId = command("docker", ["image", "inspect", migrationImage, "--format", "{{.Id}}"]).replace(/^sha256:/, "");
const npmSbom = requireFile("sbom-npm.cdx.json");
const containerSbom = requireFile("sbom-container.cdx.json");
const migrationJournal = requireFile("drizzle-release/meta/_journal.json");

const manifest = {
  schemaVersion: 1,
  releaseCandidate: process.env.RELEASE_CANDIDATE ?? `rc-${gitSha.slice(0, 12)}`,
  git: { sha: gitSha },
  runtime: {
    node: process.version,
    npm: command(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    postgres: process.env.POSTGRES_VERSION ?? "17",
  },
  images: {
    runtime: { reference: runtimeImage, id: `sha256:${runtimeImageId}` },
    migration: { reference: migrationImage, id: `sha256:${migrationImageId}` },
  },
  evidence: {
    npmSbom: { path: npmSbom, sha256: sha256(npmSbom) },
    containerSbom: { path: containerSbom, sha256: sha256(containerSbom) },
    migrationJournal: { path: migrationJournal, sha256: sha256(migrationJournal) },
  },
  gates: [
    "engineering",
    "database-release",
    "database-roles",
    "capacity",
    "browser-e2e",
    "supply-chain",
    "container-runtime",
    "migration-replay",
  ],
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ok: true, output, gitSha, runtimeImageId, migrationImageId }));
