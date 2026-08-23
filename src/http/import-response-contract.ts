import { z } from "zod";
import type { ImportVocabNoteFileResult, ImportVocabNotesResult } from "../services/vocab-import.service";

export const vocabNoteImportFileStatusSchema = z.enum([
  "imported",
  "unchanged",
  "needs_supplement",
  "rejected",
  "failed",
]);

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
}).strict();

export const vocabNotesImportResponseSchema: z.ZodType<ImportVocabNotesResult> = z.object({
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
