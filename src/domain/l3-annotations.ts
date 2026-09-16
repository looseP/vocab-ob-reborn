/**
 * 做题注记（原文分析条目）与规律标签字典的 domain 契约（批次一，2026-09-16）。
 * 纯类型 + zod 校验，零 IO；锚点三元组一致性、标签上限、选项键白名单在此收口，
 * 数据库 CHECK 是第二道防线。
 */
import { z, type RefinementCtx } from "zod";

export const OPTION_KEYS = ["A", "B", "C", "D"] as const;
export type AnnotationOptionKey = (typeof OPTION_KEYS)[number];

/** entry_tags 预置题型标签（冻结，用户可在字典中增删）。 */
export const PRESET_ENTRY_TAGS = ["细节题", "推断题", "主旨题", "态度题", "词汇题", "例证题"] as const;

/** option_tags 预置错误类型标签（冻结）。 */
export const PRESET_OPTION_TAGS = ["同义替换", "偷换概念", "无中生有", "过度推断", "正反颠倒", "张冠李戴", "答非所问"] as const;

const tagSchema = z.string().trim().min(1).max(30);

/**
 * A–D 选项打标：每键独立可选、值为标签数组；strict 拒绝白名单外的键
 * （zod 4 的 z.record(z.enum(KEYS), …) 要求四键齐全，与部分打标语义冲突）。
 */
const optionTagsSchema = z.object({
  A: z.array(tagSchema).max(8).optional(),
  B: z.array(tagSchema).max(8).optional(),
  C: z.array(tagSchema).max(8).optional(),
  D: z.array(tagSchema).max(8).optional(),
}).strict();

/** 宽松形状：input（全字段）与 patch（全可选）共用同一套 refine。 */
type AnnotationShape = {
  anchorStart?: number | null;
  anchorEnd?: number | null;
  excerpt?: string | null;
  note?: string;
  entryTags?: string[];
  optionTags?: Partial<Record<AnnotationOptionKey, string[]>>;
};

/**
 * 锚点三元组 + 空条目校验。undefined（PATCH 未提交）与 null（显式无锚点）
 * 统一归一——前端编辑表单按整组提交，未提交锚点即按无锚点参与一致性判断。
 */
function refineAnnotation(v: AnnotationShape, ctx: RefinementCtx): void {
  const start = v.anchorStart ?? null;
  const end = v.anchorEnd ?? null;
  const excerpt = v.excerpt ?? null;
  const anchored = start != null;
  if (anchored !== (end != null)) {
    ctx.addIssue({ code: "custom", message: "锚点起止必须成对出现" });
  }
  if (anchored && end != null && end <= start) {
    ctx.addIssue({ code: "custom", message: "锚点 end 必须大于 start" });
  }
  if (anchored !== (excerpt != null)) {
    ctx.addIssue({ code: "custom", message: "有锚点必须带原文摘录，无锚点不得带摘录" });
  }
  const noteLength = (v.note ?? "").length;
  const optionTagKeys = Object.keys(v.optionTags ?? {}).length;
  const entryTagCount = v.entryTags?.length ?? 0;
  if (!anchored && noteLength === 0 && optionTagKeys === 0 && entryTagCount === 0) {
    ctx.addIssue({ code: "custom", message: "空条目：无锚点时 note 或标签至少填一项" });
  }
}

const annotationObjectSchema = z.object({
  questionId: z.string().uuid(),
  anchorStart: z.number().int().nonnegative().nullable().default(null),
  anchorEnd: z.number().int().nonnegative().nullable().default(null),
  excerpt: z.string().trim().min(1).max(500).nullable().default(null),
  note: z.string().trim().max(2000).default(""),
  entryTags: z.array(tagSchema).max(8).default([]),
  optionTags: optionTagsSchema.default({}),
});

export const questionAnnotationInputSchema = annotationObjectSchema.superRefine(refineAnnotation);

export type QuestionAnnotationInput = z.infer<typeof questionAnnotationInputSchema>;

/**
 * PATCH 局部更新：questionId 不可改（条目永挂原题）。zod 4 不允许对带
 * refinement 的 schema 直接 partial，故从基础对象派生后挂同一套 refine
 * （调用方按整组提交三元组）。
 */
export const questionAnnotationPatchSchema = annotationObjectSchema
  .partial()
  .omit({ questionId: true })
  .superRefine(refineAnnotation);

export type QuestionAnnotationPatch = z.infer<typeof questionAnnotationPatchSchema>;

export const annotationTagDictSchema = z.object({
  entry: z.array(tagSchema).max(50),
  option: z.array(tagSchema).max(50),
});

export type AnnotationTagDict = z.infer<typeof annotationTagDictSchema>;
