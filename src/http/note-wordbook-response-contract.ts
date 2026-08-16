/**
 * Response contracts for the note and wordbook read endpoints added by the
 * frontend rebuild (GET /api/notes, word note fetch/upsert, wordbook list).
 */
import { z } from "zod";

export const noteListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    wordSlug: z.string(),
    wordLemma: z.string(),
    wordTitle: z.string(),
    contentMd: z.string(),
    version: z.number().int().nonnegative(),
    updatedAt: z.string().nullable(),
  }).strict()),
  total: z.number().int().nonnegative(),
}).strict();

export const wordNoteResponseSchema = z.object({
  content_md: z.string(),
  updated_at: z.string().nullable(),
  version: z.number().int().nonnegative(),
}).strict();

export const wordNoteUpsertResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

const wordbookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
}).strict();

export const wordbookListResponseSchema = z.object({
  items: z.array(wordbookSummarySchema),
  total: z.number().int().nonnegative(),
}).strict();

export const wordbookDefaultResponseSchema = wordbookSummarySchema;
