import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const REQUIRED_IMAGES = ["runtime", "migration", "backup"] as const;
export const REQUIRED_EVIDENCE = ["npmSbom", "runtimeSbom", "migrationSbom", "backupSbom", "migrationJournal"] as const;
export const REQUIRED_GATES = [
  "engineering",
  "database-release",
  "database-roles",
  "capacity",
  "browser-e2e",
  "supply-chain",
  "container-runtime",
  "migration-replay",
] as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repositoryComponent = "[a-z0-9]+(?:(?:[._-]|__)[a-z0-9]+)*";
const registry = "(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[0-9]+)?";
const immutableReferencePattern = new RegExp(`^${registry}/${repositoryComponent}(?:/${repositoryComponent})*@sha256:[a-f0-9]{64}$`);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], name: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) throw new Error(`Invalid ${name} keys`);
}

export function parseImmutableImageReference(value: unknown, name: string): { reference: string; digest: string } {
  const image = record(value, `${name} image`);
  exactKeys(image, ["reference", "digest"], `${name} image`);
  if (typeof image.reference !== "string" || !immutableReferencePattern.test(image.reference)) {
    throw new Error(`Invalid ${name} immutable OCI reference`);
  }
  if (typeof image.digest !== "string" || !digestPattern.test(image.digest)) throw new Error(`Invalid ${name} image digest`);
  const referenceDigest = image.reference.slice(image.reference.lastIndexOf("@") + 1);
  if (referenceDigest !== image.digest) throw new Error(`${name} image digest/reference mismatch`);
  return { reference: image.reference, digest: image.digest };
}

export function immutableImageFromEnvironment(value: string | undefined, name: string): { reference: string; digest: string } {
  if (!value) throw new Error(`Missing ${name} immutable OCI reference`);
  const digest = value.slice(value.lastIndexOf("@") + 1);
  return parseImmutableImageReference({ reference: value, digest }, name);
}

export function safeRepositoryOutputPath(root: string, value: string, name: string): string {
  if (value.length === 0 || !/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("\\") || isAbsolute(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe ${name} path`);
  }
  const output = resolve(root, value);
  const fromRoot = relative(root, output);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`Unsafe ${name} path`);
  return output;
}

export function releaseManifestSummary(
  manifestSha256: string,
  images: Record<(typeof REQUIRED_IMAGES)[number], { digest: string }>,
): { ok: true; manifestSha256: string; imageDigests: Record<(typeof REQUIRED_IMAGES)[number], string> } {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("Invalid release manifest digest");
  return {
    ok: true,
    manifestSha256,
    imageDigests: Object.fromEntries(REQUIRED_IMAGES.map((name) => [name, images[name].digest])) as Record<(typeof REQUIRED_IMAGES)[number], string>,
  };
}

export function verifyReleaseManifest(value: unknown, root: string): { evidenceCount: number } {
  const manifest = record(value, "release manifest");
  exactKeys(manifest, ["schemaVersion", "releaseCandidate", "git", "runtime", "images", "evidence", "gates"], "release manifest");
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) throw new Error("Invalid release manifest schema version");
  if (typeof manifest.releaseCandidate !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseCandidate)) {
    throw new Error("Invalid release candidate");
  }

  const git = record(manifest.git, "git identity");
  exactKeys(git, ["sha"], "git identity");
  if (typeof git.sha !== "string" || !/^[a-f0-9]{40}$/.test(git.sha)) throw new Error("Invalid release manifest git SHA");

  const runtime = record(manifest.runtime, "runtime identity");
  exactKeys(runtime, ["node", "npm", "postgres"], "runtime identity");
  for (const [name, version] of Object.entries(runtime)) {
    if (typeof version !== "string" || version.length === 0 || version.length > 64) throw new Error(`Invalid ${name} runtime version`);
  }

  const images = record(manifest.images, "images");
  exactKeys(images, REQUIRED_IMAGES, "images");
  for (const name of REQUIRED_IMAGES) parseImmutableImageReference(images[name], name);

  const evidence = record(manifest.evidence, "evidence");
  exactKeys(evidence, REQUIRED_EVIDENCE, "evidence");
  const canonicalRoot = realpathSync(root);
  for (const name of REQUIRED_EVIDENCE) {
    const item = record(evidence[name], `${name} evidence`);
    exactKeys(item, ["path", "sha256"], `${name} evidence`);
    if (typeof item.path !== "string" || item.path.length === 0 || item.path.includes("\\") || isAbsolute(item.path)) {
      throw new Error(`Unsafe ${name} evidence path`);
    }
    if (item.path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`Unsafe ${name} evidence path`);
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`Invalid ${name} evidence digest`);
    const resolved = realpathSync(resolve(canonicalRoot, item.path));
    const fromRoot = relative(canonicalRoot, resolved);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`Unsafe ${name} evidence path`);
    const actual = createHash("sha256").update(readFileSync(resolved)).digest("hex");
    if (actual !== item.sha256) throw new Error(`${name} evidence digest mismatch`);
  }

  if (!Array.isArray(manifest.gates) || manifest.gates.some((gate) => typeof gate !== "string")) throw new Error("Invalid release gates");
  if (new Set(manifest.gates).size !== manifest.gates.length) throw new Error("Duplicate release gate");
  exactKeys(Object.fromEntries(manifest.gates.map((gate) => [gate, true])), REQUIRED_GATES, "release gates");
  return { evidenceCount: REQUIRED_EVIDENCE.length };
}
