import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, process.env.RELEASE_MANIFEST_PATH ?? "release-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  schemaVersion: number;
  git: { sha: string };
  images: Record<string, { id: string }>;
  evidence: Record<string, { path: string; sha256: string }>;
  gates: string[];
};
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.git.sha)) throw new Error("Invalid release manifest identity");
for (const [name, image] of Object.entries(manifest.images)) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image.id)) throw new Error(`Invalid ${name} image digest`);
}
for (const [name, evidence] of Object.entries(manifest.evidence)) {
  if (evidence.path.includes("..") || evidence.path.startsWith("/") || /^[A-Za-z]:/.test(evidence.path)) throw new Error(`Unsafe ${name} evidence path`);
  const resolved = resolve(root, evidence.path);
  if (resolved !== root && !resolved.startsWith(`${root}\\`) && !resolved.startsWith(`${root}/`)) throw new Error(`Unsafe ${name} evidence path`);
  const actual = createHash("sha256").update(readFileSync(resolved)).digest("hex");
  if (actual !== evidence.sha256) throw new Error(`${name} evidence digest mismatch`);
}
const required = ["engineering", "database-release", "database-roles", "capacity", "browser-e2e", "supply-chain", "container-runtime", "migration-replay"];
for (const gate of required) if (!manifest.gates.includes(gate)) throw new Error(`Missing release gate: ${gate}`);
console.log(JSON.stringify({ ok: true, manifest: manifestPath, evidence: Object.keys(manifest.evidence).length }));
