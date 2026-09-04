import { z } from "zod";
import type { PaginatedResult, WordDetail, WordSummary } from "../domain";
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

export const wordDetailResponseSchema: z.ZodType<WordDetail> = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  ipa: z.string().nullable(),
  aliases: z.array(z.string()),
  short_definition: z.string().nullable(),
  definition_md: z.string(),
  body_md: z.string(),
  examples: jsonValueSchema,
  prototype_text: z.string().nullable(),
  metadata: jsonValueSchema,
}).strict();

export const wordListResponseSchema: z.ZodType<PaginatedResult<WordSummary>> = z.object({
  items: z.array(wordSummaryResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict();

// L1-2：输入联想响应——仅 items（无需分页元数据）。
export const wordSuggestResponseSchema = z.object({
  items: z.array(wordSummaryResponseSchema),
}).strict();

export const wordBatchCreateResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
}).strict();
