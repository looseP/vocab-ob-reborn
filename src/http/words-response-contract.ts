import { z } from "zod";
import type { PaginatedResult, WordSummary } from "../domain";
import { jsonValueSchema } from "./l3-response-contract";

export const wordSummaryResponseSchema: z.ZodType<WordSummary> = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  ipa: z.string().nullable(),
  short_definition: z.string().nullable(),
  metadata: jsonValueSchema,
}).strict();

export const wordListResponseSchema: z.ZodType<PaginatedResult<WordSummary>> = z.object({
  items: z.array(wordSummaryResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict();
