import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = resolve(import.meta.dirname, "../../scripts/verify-backup-sbom.mjs");
const sourceDigest = "sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394";

function provenance(extra = ""): string {
  return [
    "meta\tschemaVersion\t1",
    `meta\tsourceImageDigest\t${sourceDigest}`,
    "tool\tpg_dump\t17.10",
    "tool\tpg_restore\t17.10",
    "file\t/opt/postgres-client/bin/pg_dump.real\tpostgresql-client-17\t17.10-1.pgdg12+1\tamd64\tpostgresql-17",
    "file\t/opt/postgres-client/bin/pg_restore.real\tpostgresql-client-17\t17.10-1.pgdg12+1\tamd64\tpostgresql-17",
    "file\t/opt/postgres-client/lib/libpq.so.5\tlibpq5\t18.4-1.pgdg12+1\tamd64\tpostgresql-18",
    extra,
  ].filter(Boolean).join("\n") + "\n";
}

function sbom(): string {
  return JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [] });
}

describe("backup SBOM provenance", () => {
  it("adds attributed PostgreSQL client packages to the image SBOM", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      const outputPath = resolve(directory, "verified.json");
      await writeFile(provenancePath, provenance());
      await writeFile(sbomPath, sbom());
      await execFileAsync(process.execPath, [script, provenancePath, sbomPath, outputPath]);
      const verified = JSON.parse(await readFile(outputPath, "utf8")) as { components: Array<{ name: string; version: string }> };
      expect(verified.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "postgresql-client-17", version: "17.10-1.pgdg12+1" }),
        expect.objectContaining({ name: "libpq5", version: "18.4-1.pgdg12+1" }),
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the input is not a CycloneDX 1.6 SBOM", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance());
      await writeFile(sbomPath, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] }));
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(
        /CycloneDX 1\.6/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a tool version declaration is not exact", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance().replace("tool\tpg_dump\t17.10", "tool\tpg_dump\t17.10.1"));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(/17\.10/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when provenance contains an unexpected declaration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance("tool\tpsql\t17.10"));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(
        /unexpected tool record psql/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when provenance contains duplicate declarations", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance("tool\tpg_dump\t17.10"));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(/duplicate tool record pg_dump/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when provenance contains duplicate file records", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      const duplicate =
        "file\t/opt/postgres-client/lib/libpq.so.5\tlibpq5\t18.4-1.pgdg12+1\tamd64\tpostgresql-18";
      await writeFile(provenancePath, provenance(duplicate));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(
        /duplicate file record \/opt\/postgres-client\/lib\/libpq\.so\.5/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a package has conflicting metadata", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      const conflicting = provenance(
        "file\t/opt/postgres-client/lib/libpq-extra.so\tlibpq5\t18.5-1.pgdg12+1\tamd64\tpostgresql-18",
      );
      await writeFile(provenancePath, conflicting);
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(
        /conflicting package metadata for libpq5/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when required package attribution is absent", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance().replace("libpq5", "libssl3"));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(/libpq5/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a client binary is attributed to the wrong package", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      const wrongOwner = provenance().replace(
        "file\t/opt/postgres-client/bin/pg_dump.real\tpostgresql-client-17\t17.10-1.pgdg12+1\tamd64\tpostgresql-17",
        "file\t/opt/postgres-client/bin/pg_dump.real\tpostgresql-common\t267.pgdg12+1\tall\tpostgresql-common",
      );
      await writeFile(provenancePath, wrongOwner);
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(
        /attribute \/opt\/postgres-client\/bin\/pg_dump\.real to postgresql-client-17/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a required client binary attribution is absent", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance().replace(/^file\t\/opt\/postgres-client\/bin\/pg_restore\.real.*\n/m, ""));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(/pg_restore\.real/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a forbidden server binary is attributed", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "backup-sbom-"));
    try {
      const provenancePath = resolve(directory, "provenance.tsv");
      const sbomPath = resolve(directory, "sbom.json");
      await writeFile(provenancePath, provenance("file\t/opt/postgres-client/bin/postgres\tpostgresql-17\t17.10\tamd64\tpostgresql-17"));
      await writeFile(sbomPath, sbom());
      await expect(execFileAsync(process.execPath, [script, provenancePath, sbomPath])).rejects.toThrow(/forbidden/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
