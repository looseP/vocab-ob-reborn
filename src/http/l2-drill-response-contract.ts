import { z } from "zod";

const reviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

const l2StateSchema = z.enum(["new", "learning", "review", "relearning"]);

const l2QueueWordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  short_definition: z.string().nullable(),
  ipa: z.string().nullable(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
}).strict();

// 剥离后的任务负载（绝不含 answerIndex —— 答案不得出 API，spec D8）。
// P3-8：sourceTitle / contextId 仅在产出步使用 L3 语境片段时填充。
// M2 修复（防御纵深）：.passthrough() 会透传未知字段——若后端某天意外把
// answerIndex 塞进响应，zod 校验必须显式拒绝，红线的保证不能只靠领域层
// stripAnswer 单一来源。注意 .superRefine 必须放在 .passthrough() 之后，
// 否则未知字段会被剥离导致检查失效。
export const l2TaskPayloadSchema = z
  .object({
    taskId: z.string(),
    taskType: z.enum(["cloze_mcq", "synonym_discrimination", "production"]),
    prompt: z.string(),
    stepIndex: z.number().int().nonnegative(),
    options: z.array(z.string()).optional(),
    hintTranslation: z.string().nullable().optional(),
    referenceExample: z.string().nullable().optional(),
    sourceTitle: z.string().nullable().optional(),
    contextId: z.string().uuid().nullable().optional(),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    // spec D8 红线：答案索引绝不允许出现在任何 API 响应中
    if ("answerIndex" in payload) {
      ctx.addIssue({
        code: "custom",
        message: "answerIndex must never appear in API responses (spec D8)",
        path: ["answerIndex"],
      });
    }
  });

export const l2DrillQueueResponseSchema = z.object({
  items: z.array(z.object({
    progressId: z.string(),
    stepId: z.string(),
    word: l2QueueWordSchema,
    l2DueAt: z.string().nullable(),
    l2ReviewCount: z.number().int().nonnegative(),
    singleStep: z.boolean(),
    task: l2TaskPayloadSchema,
  }).strict()),
  session: z.object({
    id: z.string(),
    mode: z.string(),
  }).strict(),
  stats: z.object({
    total: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const l2TaskAnswerResponseSchema = z.object({
  ok: z.literal(true),
  idempotent: z.literal(true).optional(),
  skipped: z.literal(true).optional(),
  outcome: z.enum(["correct", "incorrect"]).optional(),
  mappedRating: reviewRatingSchema.optional(),
  l2ReviewLogId: z.string().uuid().optional(),
  l2NextDueAt: z.string().nullable().optional(),
  nextStep: z.union([
    z.object({ type: z.literal("done") }).strict(),
    z.object({
      type: z.literal("production"),
      step: z.object({
        stepId: z.string(),
        task: l2TaskPayloadSchema,
      }).strict(),
    }).strict(),
  ]),
}).strict();

export const l2SelfAssessResponseSchema = z.object({
  ok: z.literal(true),
  productionStatus: z.enum(["passed", "weak"]),
}).strict();

export const l2UndoResponseSchema = z.object({
  ok: z.literal(true),
  // M7 修复：撤销幂等命中时返回 idempotent: true
  idempotent: z.literal(true).optional(),
}).strict();

export { l2StateSchema, reviewRatingSchema };
