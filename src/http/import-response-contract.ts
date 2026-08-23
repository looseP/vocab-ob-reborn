import { z } from "zod";
import type {
  ImportVocabNoteFileResult,
  ImportVocabNoteWordEntry,
  ImportVocabNotesResult,
} from "../services/vocab-import.service";

export const vocabNoteImportFileStatusSchema = z.enum([
  "imported",
  "unchanged",
  "needs_supplement",
  "rejected",
  "failed",
]);

export const vocabNoteImportWordTierSchema = z.enum([
  "ok",
  "needs_supplement",
  "rejected",
]);

export const vocabNoteImportWordEntrySchema: z.ZodType<ImportVocabNoteWordEntry> = z.object({
  slug: z.string(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  tier: vocabNoteImportWordTierSchema,
  score: z.number(),
  issues: z.array(z.string()),
  outcome: z.enum(["imported", "unchanged"]).optional(),
}).strict();

export const vocabNoteImportFileResultSchema: z.ZodType<ImportVocabNoteFileResult> = z.object({
  path: z.string(),
  status: vocabNoteImportFileStatusSchema,
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  needsSupplement: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  failedWords: z.number().int().nonnegative(),
  minScore: z.number().nullable(),
  issues: z.array(z.string()),
  error: z.string().optional(),
  words: z.array(vocabNoteImportWordEntrySchema),
}).strict();

export const vocabNotesImportResponseSchema: z.ZodType<ImportVocabNotesResult> = z.object({
  dryRun: z.boolean(),
  results: z.array(vocabNoteImportFileResultSchema),
  stats: z.object({
    files: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    needsSupplement: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict(),
}).strict();
