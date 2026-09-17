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
 * 统一归一参与一致性判断；空条目规则只对 create 整体生效——PATCH 可只提交
 * 单列（如仅清空 entryTags），不评判条目整体是否为空。
 */
function refineAnnotation(v: AnnotationShape, ctx: RefinementCtx, requireContent: boolean): void {
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
  if (!requireContent) return;
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
  // 批次二：挂题纸的草稿注记（做题中产生，随定格升格）。缺省 = 正式注记（confirmed）。
  sheetId: z.string().uuid().optional(),
});

export const questionAnnotationInputSchema = annotationObjectSchema.superRefine((v, ctx) =>
  refineAnnotation(v, ctx, true),
);

export type QuestionAnnotationInput = z.infer<typeof questionAnnotationInputSchema>;

/**
 * PATCH 局部更新：questionId 不可改（条目永挂原题）。zod 4 的 .partial() 会
 * 保留 default（未提交键被填成 null/空数组，将误清空未改列），故独立声明
 * 纯 optional（无 default）形状；refine 只保留三元组一致性，不做空条目拦截。
 */
export const questionAnnotationPatchSchema = z.object({
  anchorStart: z.number().int().nonnegative().nullable().optional(),
  anchorEnd: z.number().int().nonnegative().nullable().optional(),
  excerpt: z.string().trim().min(1).max(500).nullable().optional(),
  note: z.string().trim().max(2000).optional(),
  entryTags: z.array(tagSchema).max(8).optional(),
  optionTags: optionTagsSchema.optional(),
}).superRefine((v, ctx) => refineAnnotation(v, ctx, false));

export type QuestionAnnotationPatch = z.infer<typeof questionAnnotationPatchSchema>;

export const annotationTagDictSchema = z.object({
  entry: z.array(tagSchema).max(50),
  option: z.array(tagSchema).max(50),
});

export type AnnotationTagDict = z.infer<typeof annotationTagDictSchema>;

// ── 批次二（ADR-0034 §3）：stage 生命周期与覆盖度视图 ─────────────────────

/**
 * 注记 stage 生命周期（与软删 status 正交）：draft（做题中，挂题纸）→
 * submitted（随题纸定格提交，待检验）→ confirmed（owner 确认 / agent 检验通过）。
 * 存量历史注记默认 confirmed（迁移 ADD COLUMN DEFAULT 回填）。
 */
export const ANNOTATION_STAGES = ["draft", "submitted", "confirmed"] as const;
export type AnnotationStage = (typeof ANNOTATION_STAGES)[number];

/** 定格升格谓词：仅 draft 可升 submitted（批次二唯一实现流转）。 */
export function canPromoteAnnotationStage(stage: string): boolean {
  return stage === "draft";
}

/** 确认谓词：仅 submitted 可确认（owner 确认 / agent 检验通过；批次三接执行面）。 */
export function canConfirmAnnotationStage(stage: string): boolean {
  return stage === "submitted";
}

/** 覆盖度视图输入：只需 option_tags（行结构最小切片，避免 domain 依赖行类型）。 */
export interface AnnotationCoverageInput {
  optionTags: Partial<Record<AnnotationOptionKey, string[]>>;
}

export interface AnnotationCoverageEntry {
  key: AnnotationOptionKey;
  covered: boolean;
}

/**
 * 覆盖度视图「A✓ B✓ C— D—」（设计卡 §4.4）：按选项键呈现被注记覆盖情况，
 * 只呈现、不催——不分析一眼错的选项是合法终态。非空标签数组才算覆盖
 * （空数组 = 清空过的打标，不算）。
 */
export function annotationCoverage(
  annotations: ReadonlyArray<AnnotationCoverageInput>,
  optionKeys: readonly AnnotationOptionKey[] = OPTION_KEYS,
): AnnotationCoverageEntry[] {
  const coveredKeys = new Set<string>();
  for (const annotation of annotations) {
    for (const [key, tags] of Object.entries(annotation.optionTags ?? {})) {
      if (Array.isArray(tags) && tags.length > 0) coveredKeys.add(key);
    }
  }
  return optionKeys.map((key) => ({ key, covered: coveredKeys.has(key) }));
}
