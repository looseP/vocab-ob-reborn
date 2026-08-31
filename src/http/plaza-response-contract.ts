import { z } from "zod";

// 词汇广场（P4）响应契约——语义场集合由 words.source_path 实时聚合推导。

export const plazaWordCardResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  lemma: z.string(),
  cefr: z.string().nullable(),
  short_definition: z.string().nullable(),
  semantic_chain: z.string().nullable(),
}).strict();

export const plazaCollectionSummaryResponseSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.literal("semantic_field"),
  count: z.number().int().nonnegative(),
  updatedAt: z.string(),
}).strict();

export const plazaGroupResponseSchema = z.object({
  kind: z.literal("semantic_field"),
  label: z.string(),
  count: z.number().int().nonnegative(),
  collections: z.array(plazaCollectionSummaryResponseSchema),
}).strict();

export const plazaOverviewResponseSchema = z.object({
  available: z.boolean(),
  counts: z.object({
    showing: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  groups: z.array(plazaGroupResponseSchema),
  total: z.number().int().nonnegative(),
}).strict();

export const plazaCollectionResponseSchema = plazaCollectionSummaryResponseSchema.extend({
  words: z.array(plazaWordCardResponseSchema),
}).strict();
