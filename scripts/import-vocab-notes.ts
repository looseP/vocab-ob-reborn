/**
 * Manual bulk importer — walks the L1 migration corpus directory and pushes
 * every collection note through VocabImportService against a reachable
 * Postgres.
 *
 * The database is never exposed to the host (exposure-surface discipline),
 * so run this INSIDE the stack, where `postgres:5432` resolves:
 *
 *   docker compose build web   # after adding this script
 *   docker compose exec -T -e INGEST_CORPUS_DIR=/work/corpus \
 *     -e BATCH_IMPORT_DATABASE_URL='postgresql://vocab_batch_import:...@postgres:5432/vocab' \
 *     -e DB_SSLMODE=disable \
 *     web npx tsx scripts/import-vocab-notes.ts [--dry-run] [--strict]
 *
 * Mount the corpus with: docker compose run ... -v "D:\Notes\...:/work/corpus:ro"
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WordRepository } from "../src/repositories/word.repository";
import { VocabImportService } from "../src/services/vocab-import.service";
import type { ImportVocabNoteFileInput } from "../src/services/vocab-import.service";

const CORPUS_DIR = process.env.INGEST_CORPUS_DIR ?? "";
const LIBRARIES = ["L0_基础词", "L0_单词集合", "L0_超纲词", "L1_雅思词汇"] as const;
const FILES_PER_BATCH = 25;

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.name.endsWith(".md") && entry.name !== "README.md") out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  if (!CORPUS_DIR) throw new Error("INGEST_CORPUS_DIR is required");
  if (!process.env.BATCH_IMPORT_DATABASE_URL) {
    throw new Error("BATCH_IMPORT_DATABASE_URL is required (host-reachable vocab_batch_import role)");
  }

  const dryRun = process.argv.includes("--dry-run");
  const strict = process.argv.includes("--strict");
  const files: ImportVocabNoteFileInput[] = LIBRARIES.flatMap((lib) =>
    listMarkdownFiles(join(CORPUS_DIR, lib)).map((path) => ({
      path: `${lib}/${path.split(`${lib}\\`).pop() ?? path.split(`${lib}/`).pop()}`,
      content: readFileSync(path, "utf8"),
    })),
  );

  console.log(`[ingest] files=${files.length} dryRun=${dryRun} strict=${strict}`);
  const service = new VocabImportService(new WordRepository());

  const totals = { imported: 0, unchanged: 0, needsSupplement: 0, rejected: 0, failed: 0 };
  for (let i = 0; i < files.length; i += FILES_PER_BATCH) {
    const batch = files.slice(i, i + FILES_PER_BATCH);
    const result = await service.importFiles(batch, {
      strictness: strict ? "strict" : "standard",
      dryRun,
    });
    totals.imported += result.stats.imported;
    totals.unchanged += result.stats.unchanged;
    totals.needsSupplement += result.stats.needsSupplement;
    totals.rejected += result.stats.rejected;
    totals.failed += result.stats.failed;

    const failedFiles = result.results.filter((r) => r.status === "failed");
    for (const failed of failedFiles) {
      console.error(`[ingest] FAILED ${failed.path}: ${failed.error}`);
    }
    console.log(
      `[ingest] batch ${Math.floor(i / FILES_PER_BATCH) + 1}/` +
        `${Math.ceil(files.length / FILES_PER_BATCH)} done ` +
        `(cumulative imported=${totals.imported} unchanged=${totals.unchanged} ` +
        `needsSupplement=${totals.needsSupplement} rejected=${totals.rejected} failedFiles=${totals.failed})`,
    );
  }

  console.log(`[ingest] COMPLETE ${JSON.stringify(totals)}`);
}

main().catch((error) => {
  console.error("[ingest] fatal:", error);
  process.exit(1);
});
