import { z } from "zod";

// 词汇广场（P4）响应契约。
// 语义场（/api/plaza）契约自 Phase 1 起冻结；词根词缀走独立端点
// /api/plaza/roots，避免响应契约变更触发 verify-openapi-breaking 门禁。

export const plazaWordCardResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  lemma: z.string(),
  cefr: z.string().nullable(),
  short_definition: z.string().nullable(),
  semantic_chain: z.string().nullable(),
}).strict();

/** 词根集合词卡：词根结构（prefix/root/suffix，原始串）+ 语义链。 */
export const rootWordCardResponseSchema = plazaWordCardResponseSchema.extend({
  root: z.string().nullable(),
  prefix: z.string().nullable(),
  suffix: z.string().nullable(),
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

export const plazaCollectionResponseSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.literal("semantic_field"),
  count: z.number().int().nonnegative(),
  updatedAt: z.string(),
  words: z.array(plazaWordCardResponseSchema),
}).strict();

// ── 词根词缀（/api/plaza/roots）────────────────────────────────────────
export const rootFamilySummaryResponseSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.literal("root_affix"),
  count: z.number().int().nonnegative(),
  updatedAt: z.string(),
}).strict();

export const plazaRootsResponseSchema = z.object({
  available: z.boolean(),
  counts: z.object({
    showing: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  collections: z.array(rootFamilySummaryResponseSchema),
  total: z.number().int().nonnegative(),
}).strict();

export const rootCollectionDetailResponseSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.literal("root_affix"),
  count: z.number().int().nonnegative(),
  updatedAt: z.string(),
  type: z.enum(["simple", "compound", "mixed"]),
  words: z.array(rootWordCardResponseSchema),
}).strict();
