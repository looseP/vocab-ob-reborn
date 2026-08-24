/**
 * VocabImportService — orchestrates the L1 rich-note import pipeline.
 *
 * Per file: parse (domain/ingest) → per-word quality gate → hash-guarded
 * full upsert through the batch-import role. Files are independent: one
 * failing file never blocks the others, and every file gets a structured
 * result so callers (plugin / manual bulk UI) can surface precise feedback.
 *
 * dryRun computes the exact same outcomes without touching the repository.
 */

import {
  assessWordCompleteness,
  computeIngestHash,
  parseVocabCollection,
  type IngestWord,
  type QualityStrictness,
  type WordQualityTier,
} from "../domain/ingest";
import type { IWordRepository, UpsertFullWordInput } from "../repositories/interfaces";
import { ValidationError } from "../errors";

export interface ImportVocabNoteFileInput {
  path: string;
  content: string;
  updatedAt?: string | null;
}

export interface ImportVocabNotesOptions {
  strictness?: QualityStrictness;
  /** Compute outcomes without writing anything. */
  dryRun?: boolean;
}

export type ImportVocabNoteFileStatus =
  | "imported"
  | "unchanged"
  | "needs_supplement"
  | "rejected"
  | "failed";

export interface ImportVocabNoteFileResult {
  path: string;
  status: ImportVocabNoteFileStatus;
  total: number;
  imported: number;
  unchanged: number;
  needsSupplement: number;
  rejected: number;
  failedWords: number;
  /** Lowest completeness score among the file's words. */
  minScore: number | null;
  issues: string[];
  error?: string;
  /** Per-word parse outcome — powers preview drill-down in the UI. */
  words: ImportVocabNoteWordEntry[];
}

export interface ImportVocabNoteWordEntry {
  slug: string;
  pos: string | null;
  cefr: string | null;
  tier: WordQualityTier;
  score: number;
  issues: string[];
  /** Write outcome in a real run; absent during dryRun (nothing written). */
  outcome?: "imported" | "unchanged";
}

export interface ImportVocabNotesResult {
  /** Echoes the effective dry-run flag so consumers can trust the server's verdict, not their own request state. */
  dryRun: boolean;
  results: ImportVocabNoteFileResult[];
  stats: {
    files: number;
    imported: number;
    unchanged: number;
    needsSupplement: number;
    rejected: number;
    failed: number;
  };
}

function deriveFileStatus(counters: Omit<ImportVocabNoteFileResult, "path" | "status" | "minScore" | "issues">): ImportVocabNoteFileStatus {
  if (counters.failedWords > 0) return "failed";
  if (counters.rejected > 0) return "rejected";
  if (counters.needsSupplement > 0) return "needs_supplement";
  if (counters.imported > 0) return "imported";
  return "unchanged";
}

export class VocabImportService {
  constructor(private readonly words: IWordRepository) {}

  async importFiles(
    files: ImportVocabNoteFileInput[],
    options: ImportVocabNotesOptions = {},
  ): Promise<ImportVocabNotesResult> {
    const strictness = options.strictness ?? "standard";
    if (files.length === 0) {
      throw new ValidationError("files must not be empty", "files");
    }

    const results: ImportVocabNoteFileResult[] = [];
    // Upsert is keyed by slug and overwrites wholesale, so two entries with the
    // same headword in one batch silently lose everything but the last one.
    // Scope: this request only — chunked uploads arrive as separate requests.
    const seenSlugs = new Map<string, string>();
    for (const file of files) {
      results.push(await this.importOneFile(file, strictness, options.dryRun === true, seenSlugs));
    }

    const stats = {
      files: results.length,
      imported: 0,
      unchanged: 0,
      needsSupplement: 0,
      rejected: 0,
      failed: 0,
    };
    for (const result of results) {
      stats.imported += result.imported;
      stats.unchanged += result.unchanged;
      stats.needsSupplement += result.needsSupplement;
      stats.rejected += result.rejected;
      if (result.status === "failed") stats.failed += 1;
    }
    return { dryRun: options.dryRun === true, results, stats };
  }

  private async importOneFile(
    file: ImportVocabNoteFileInput,
    strictness: QualityStrictness,
    dryRun: boolean,
    seenSlugs: Map<string, string>,
  ): Promise<ImportVocabNoteFileResult> {
    const base = {
      path: file.path,
      total: 0,
      imported: 0,
      unchanged: 0,
      needsSupplement: 0,
      rejected: 0,
      failedWords: 0,
      minScore: null as number | null,
      issues: [] as string[],
      words: [] as ImportVocabNoteWordEntry[],
    };

    try {
      if (!file.content?.trim()) throw new Error("empty note content");
      const collection = parseVocabCollection(file.content);
      if (collection.words.length === 0) throw new Error("no word entries parsed");

      for (const word of collection.words) {
        attachSource(word, file);
        const quality = assessWordCompleteness(word, strictness);
        base.total += 1;
        base.minScore =
          base.minScore == null ? quality.score : Math.min(base.minScore, quality.score);

        const entry: ImportVocabNoteWordEntry = {
          slug: word.slug,
          pos: word.pos,
          cefr: word.cefr,
          tier: quality.tier,
          score: quality.score,
          issues: quality.issues.map((issue) => issue.reason),
        };
        if (word.slug) {
          const firstPath = seenSlugs.get(word.slug);
          if (firstPath !== undefined) {
            const origin = firstPath === file.path ? "本文件前文" : firstPath;
            const reason = `重复词条 slug "${word.slug}"（首次出现于 ${origin}）；后导入者将整体覆盖先导入者`;
            entry.issues.push(reason);
            base.issues.push(`${word.slug}: ${reason}`);
          } else {
            seenSlugs.set(word.slug, file.path);
          }
        }
        base.words.push(entry);

        if (quality.tier === "rejected") {
          base.rejected += 1;
          for (const issue of quality.issues) base.issues.push(`${word.slug}: ${issue.reason}`);
          continue;
        }
        if (quality.tier === "needs_supplement") base.needsSupplement += 1;

        if (dryRun) {
          base.imported += 1;
          continue;
        }
        const outcome = await this.upsertWord(
          word,
          quality.tier,
          quality.issues.map((issue) => issue.reason),
          file,
        );
        entry.outcome = outcome;
        if (outcome === "imported") base.imported += 1;
        else base.unchanged += 1;
      }

      return { ...base, status: deriveFileStatus(base) };
    } catch (error) {
      return {
        ...base,
        status: "failed",
        failedWords: Math.max(base.failedWords, 1),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async upsertWord(
    word: IngestWord,
    tier: "ok" | "needs_supplement",
    issueReasons: string[],
    file: ImportVocabNoteFileInput,
  ): Promise<"imported" | "unchanged"> {
    if (!this.words.upsertFullWord) throw new Error("upsertFullWord not configured");
    const input: UpsertFullWordInput = {
      slug: word.slug,
      title: word.title,
      lemma: word.lemma,
      pos: word.pos,
      cefr: word.cefr,
      ipa: word.ipa,
      aliases: word.aliases,
      shortDefinition: word.shortDefinition,
      definitionMd: word.definitionMd,
      bodyMd: word.bodyMd,
      examplesJson: [],
      metadataJson: word.metadata,
      coreDefinitionsJson: word.coreDefinitions,
      prototypeText: word.prototypeText,
      contentHash: computeIngestHash(word),
      sourcePath: file.path,
      sourceUpdatedAt: file.updatedAt ?? null,
      isPublished: tier === "ok",
      qualityStatus: tier,
      qualityIssuesJson: issueReasons,
    };
    return this.words.upsertFullWord(input);
  }
}

function attachSource(word: IngestWord, file: ImportVocabNoteFileInput): void {
  word.metadata.source_path = file.path;
}
