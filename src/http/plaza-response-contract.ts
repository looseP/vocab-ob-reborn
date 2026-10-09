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
  /** 核心义（0052 词典命中时；未命中 null，前端降级）。 */
  meaning: z.string().nullable(),
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
  /** 核心义（0052 词典命中时；未命中 null，前端降级）。 */
  meaning: z.string().nullable(),
  /** 同族变体 token（0052 词典命中时；未命中空数组）。 */
  variants: z.array(z.string()),
  words: z.array(rootWordCardResponseSchema),
}).strict();

/** 集合内复习统计（E1）：已追踪 / 待复习 / 掌握分档（P1-B 掌握环，additive）。 */
export const plazaReviewStatsResponseSchema = z.object({
  tracked: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  mastered: z.number().int().nonnegative(),
  learning: z.number().int().nonnegative(),
}).strict();

/** P2-2 掌握矩阵家族行（未学 = total - mastered - learning，suspended 并入未学段）。 */
export const rootMasteryFamilyResponseSchema = z.object({
  token: z.string(),
  slug: z.string(),
  total: z.number().int().nonnegative(),
  mastered: z.number().int().nonnegative(),
  learning: z.number().int().nonnegative(),
  /** 核心义（0052 词典命中时；未命中 null）。 */
  meaning: z.string().nullable(),
}).strict();

/** P2-2 词根掌握矩阵响应（矩阵视图 + P2-3 图谱着色共用一份端点）。 */
export const plazaRootsMasteryResponseSchema = z.object({
  available: z.boolean(),
  total: z.number().int().nonnegative(),
  families: z.array(rootMasteryFamilyResponseSchema),
}).strict();
