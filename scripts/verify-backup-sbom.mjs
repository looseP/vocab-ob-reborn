import { readFileSync, writeFileSync } from "node:fs";

const [provenancePath, sbomPath, outputPath = sbomPath] = process.argv.slice(2);
if (!provenancePath || !sbomPath) {
  throw new Error("Usage: verify-backup-sbom.mjs <provenance.tsv> <sbom.cdx.json> [output.cdx.json]");
}

const records = readFileSync(provenancePath, "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line, index) => {
    const fields = line.split("\t");
    if (fields.some((field) => field.length === 0)) throw new Error(`Backup client provenance line ${index + 1} has an empty field`);
    const expectedFields = fields[0] === "file" ? 6 : 3;
    if (!["meta", "tool", "file"].includes(fields[0]) || fields.length !== expectedFields) {
      throw new Error(`Backup client provenance line ${index + 1} has an unknown record shape`);
    }
    return fields;
  });
const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));

function uniqueRecordMap(kind) {
  const entries = records.filter(([recordKind]) => recordKind === kind).map(([, name, value]) => [name, value]);
  const result = new Map();
  for (const [name, value] of entries) {
    if (result.has(name)) throw new Error(`Backup client provenance contains duplicate ${kind} record ${name}`);
    result.set(name, value);
  }
  return result;
}

const metadata = uniqueRecordMap("meta");
const tools = uniqueRecordMap("tool");
for (const [kind, actual, allowed] of [
  ["meta", metadata, new Set(["schemaVersion", "sourceImageDigest"])],
  ["tool", tools, new Set(["pg_dump", "pg_restore"])],
]) {
  for (const name of actual.keys()) {
    if (!allowed.has(name)) throw new Error(`Backup client provenance contains unexpected ${kind} record ${name}`);
  }
}
const files = records.filter(([kind]) => kind === "file").map(([, path, packageName, version, architecture, sourcePackage]) => ({
  path, packageName, version, architecture, sourcePackage,
}));
const filePaths = new Set();
for (const file of files) {
  if (filePaths.has(file.path)) throw new Error(`Backup client provenance contains duplicate file record ${file.path}`);
  filePaths.add(file.path);
}

if (metadata.get("schemaVersion") !== "1" || metadata.get("sourceImageDigest") !== "sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394") {
  throw new Error("Backup client provenance must identify the pinned PostgreSQL 17.10 source image");
}
if (tools.get("pg_dump") !== "17.10" || tools.get("pg_restore") !== "17.10") {
  throw new Error("Backup client provenance must pin pg_dump and pg_restore to 17.10");
}
if (files.length < 2) throw new Error("Backup client provenance is incomplete");

const packages = new Map();
for (const file of files) {
  const identity = `${file.version}\t${file.architecture}\t${file.sourcePackage}`;
  const existing = packages.get(file.packageName);
  if (existing && existing.identity !== identity) {
    throw new Error(`Backup client provenance contains conflicting package metadata for ${file.packageName}`);
  }
  const entry = existing ?? {
    name: file.packageName,
    version: file.version,
    architecture: file.architecture,
    sourcePackage: file.sourcePackage,
    identity,
    files: [],
  };
  entry.files.push(file.path);
  packages.set(file.packageName, entry);
}
const packageNames = new Set([...packages.values()].map((entry) => entry.name));
for (const required of ["postgresql-client-17", "libpq5"]) {
  if (!packageNames.has(required)) throw new Error(`Backup client provenance is missing ${required}`);
}
const libpq = files.find((entry) => entry.path === "/opt/postgres-client/lib/libpq.so.5");
if (!libpq || libpq.packageName !== "libpq5" || !/^postgresql-\d+$/.test(libpq.sourcePackage)) {
  throw new Error("Backup client provenance must attribute libpq.so.5 to libpq5 and its PostgreSQL source package");
}
for (const path of ["/opt/postgres-client/bin/pg_dump.real", "/opt/postgres-client/bin/pg_restore.real"]) {
  const file = files.find((entry) => entry.path === path);
  if (!file || file.packageName !== "postgresql-client-17" || file.sourcePackage !== "postgresql-17") {
    throw new Error(`Backup client provenance must attribute ${path} to postgresql-client-17 from postgresql-17`);
  }
}
if (files.some((entry) => /\/(?:postgres|psql)$/.test(entry.path))) {
  throw new Error("Backup client provenance includes a forbidden PostgreSQL server or interactive client binary");
}
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || !Array.isArray(sbom.components)) {
  throw new Error("CycloneDX 1.6 SBOM components are missing");
}

const components = new Map(sbom.components.map((component) => [component["bom-ref"] ?? component.purl ?? `${component.name}@${component.version}`, component]));
for (const entry of packages.values()) {
  const purl = `pkg:deb/debian/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}?arch=${encodeURIComponent(entry.architecture)}`;
  const bomRef = `backup-client:${entry.name}@${entry.version}:${entry.architecture}`;
  components.set(bomRef, {
    type: "library",
    "bom-ref": bomRef,
    name: entry.name,
    version: entry.version,
    purl,
    scope: "required",
    properties: [
      { name: "vocab-observatory:source", value: "digest-pinned postgres:17.10-bookworm" },
      { name: "vocab-observatory:source-package", value: entry.sourcePackage },
      { name: "vocab-observatory:owned-files", value: String(entry.files.length) },
    ],
  });
}
sbom.components = [...components.values()];
sbom.metadata ??= {};
sbom.metadata.properties ??= [];
sbom.metadata.properties.push({ name: "vocab-observatory:backup-client-provenance", value: "verified" });
writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, packages: packages.size, files: files.length, output: outputPath }));
