/**
 * Full-corpus acceptance against the real L1 migration package.
 * Runs only when INGEST_CORPUS_DIR points at the corpus root — CI (and any
 * machine without the corpus) skips automatically.
 *
 *   INGEST_CORPUS_DIR="D:\Notes\L1_雅思词汇_迁移包_2026-08-22\L1词库_完整迁移包_2026-08-22" npx vitest run tests/ingest/corpus-acceptance.test.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessWordCompleteness, parseVocabCollection } from "@/domain/ingest";

const CORPUS_DIR = process.env.INGEST_CORPUS_DIR ?? "";
const LIBRARIES = ["L0_基础词", "L0_单词集合", "L0_超纲词", "L1_雅思词汇"] as const;

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.name.endsWith(".md") && entry.name !== "README.md") out.push(full);
  }
  return out;
}

const describeCorpus =
  CORPUS_DIR && existsSync(CORPUS_DIR) ? describe : describe.skip;

describeCorpus("corpus acceptance — real migration package", () => {
  const files = LIBRARIES.flatMap((lib) => listMarkdownFiles(join(CORPUS_DIR!, lib)).map((path) => ({ lib, path })));
  const parsed = files.map(({ lib, path }) => ({
    lib,
    path,
    collection: parseVocabCollection(readFileSync(path, "utf8")),
  }));
  const allWords = parsed.flatMap((entry) =>
    entry.collection.words.map((word) => ({ ...word, lib: entry.lib })),
  );

  it("matches the manifest scale (264 files / 6767 lemmas)", () => {
    const manifest = readFileSync(join(CORPUS_DIR!, "_manifest.txt"), "utf8");
    const declaredFiles = Number(/files=(\d+)/.exec(manifest)?.[1]);
    const declaredLemmas = Number(/lemmas=(\d+)/.exec(manifest)?.[1]);
    expect(files.length).toBe(declaredFiles);
    expect(allWords.length).toBe(declaredLemmas);
  });

  it("parses every file into at least one word", () => {
    const empties = parsed.filter((entry) => entry.collection.words.length === 0);
    expect(empties).toEqual([]);
  });

  it("produces a non-empty slug for every word", () => {
    const slugless = allWords.filter((word) => !word.slug);
    expect(slugless).toEqual([]);
  });

  it("rejects nothing under standard strictness (definitions are complete)", () => {
    const rejected = allWords.filter(
      (word) => assessWordCompleteness(word, "standard").tier === "rejected",
    );
    expect(rejected).toEqual([]);
  });

  it("keeps fatal parse warnings at zero", () => {
    const fatal = allWords.filter((word) =>
      word.warnings.some((warning) => warning.includes("Identity 小节缺失") || warning.includes("slug 为空")),
    );
    expect(fatal).toEqual([]);
  });

  it("reports duplicate slugs across libraries as intel (not failure)", () => {
    const seen = new Map<string, number>();
    for (const word of allWords) seen.set(word.slug, (seen.get(word.slug) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    console.log(
      `[corpus] slugs=${seen.size} duplicatedSlugs=${duplicates.length} ` +
        `top=${duplicates
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([slug, count]) => `${slug}×${count}`)
          .join(", ")}`,
    );
    expect(duplicates.length).toBeGreaterThanOrEqual(0);
  });
});
