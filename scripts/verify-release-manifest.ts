import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyReleaseManifest } from "./release-manifest-contract.js";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, process.env.RELEASE_MANIFEST_PATH ?? "release-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
const result = verifyReleaseManifest(manifest, root);
console.log(JSON.stringify({ ok: true, manifest: manifestPath, evidence: result.evidenceCount }));
