/**
 * agent 评卷执行面 domain 契约（批次三①，ADR-0035）——纯常量 + zod 契约 +
 * 纯函数，零 IO、零出向。
 *
 * 两轨判定真源（ADR-0035 §1）：题级 verdict → l3_grading_results（本文件的
 * GRADING_VERDICTS）；注记级 verdict → 注记 review 列（复用批次二
 * ANNOTATION_REVIEW_VERDICTS，两套词表同形而语义不同——correct/partial/wrong
 * 判「题的作答」，sound/questionable/wrong 判「注记主张」，两轨不混）。
 *
 * 终态不回滚谓词（ADR-0035 §3.3）：sound→confirmed 自动；questionable/wrong
 * 保持 submitted；已 confirmed 不降级（重评只更新 review）。
 */
import { z } from "zod";
import { ANNOTATION_REVIEW_VERDICTS, type AnnotationReviewVerdict } from "./l3-sheets";

/** 题级判定词表（D15）：partial 服务翻译/作文等主观题（部分得分）。 */
export const GRADING_VERDICTS = ["correct", "partial", "wrong"] as const;
export type GradingVerdict = (typeof GRADING_VERDICTS)[number];

/**
 * verdict → 中文短标签（**单一真源**）。
 *
 * 徽标（`L3ExamPaper`）、笔记引用摘录（`studyNoteReferenceOps`）、离线导出共用它 ——
 * 同一个词在三处各写一遍中文，迟早漂移成「对 / 正确 / ✓」三种说法。
 * 徽标前缀「评卷：」由调用方加（那里需要区分判定与作答的对错）。
 */
export const GRADING_VERDICT_LABELS: Record<GradingVerdict, string> = {
  correct: "对",
  partial: "半对",
  wrong: "错",
};

/** 复用批次二注记 review 词表（0034 review 列契约，单一真源）。 */
export { ANNOTATION_REVIEW_VERDICTS };
export type { AnnotationReviewVerdict };

/** 单次评卷提交 results 条数上限（对齐注记/attempts 批量口径 1–200；空数组 400）。 */
export const GRADING_SUBMIT_RESULT_LIMIT = 200;

/** 题级分析上限（对齐评析区 20k 收口）。 */
export const GRADING_ANALYSIS_MAX = 20_000;

/** 单题可携带的注记检验条数上限（防御性——同题注记实际量级远低于此）。 */
export const GRADING_ANNOTATION_REVIEW_LIMIT = 100;

/**
 * 注记检验条目输入（HTTP camelCase）：annotationId + review 段。落库经
 * `toStoredAnnotationReview` 映射为 0034 review 列形状（snake_case）——
 * correctedTags 约束对齐批次二 tagSchema（单标签 ≤30 字、单段 ≤8 条）。
 */
export const gradingAnnotationReviewInputSchema = z.object({
  annotationId: z.string().uuid(),
  verdict: z.enum(ANNOTATION_REVIEW_VERDICTS),
  correctedTags: z.array(z.string().trim().min(1).max(30)).max(8).optional(),
  comment: z.string().trim().max(2000).optional(),
}).strict();

export type GradingAnnotationReviewInput = z.infer<typeof gradingAnnotationReviewInputSchema>;

/** 题级结果条目：verdict 必填；analysisMd 可空（纯判对错的裸 verdict 合法）。 */
export const gradingResultInputSchema = z.object({
  questionId: z.string().uuid(),
  verdict: z.enum(GRADING_VERDICTS),
  analysisMd: z.string().trim().max(GRADING_ANALYSIS_MAX).optional(),
  annotationReviews: z.array(gradingAnnotationReviewInputSchema).max(GRADING_ANNOTATION_REVIEW_LIMIT).optional(),
}).strict();

export type GradingResultInput = z.infer<typeof gradingResultInputSchema>;

/**
 * 评卷提交输入（D17）：results 1–200 条；批内 questionId 与 annotationId 各自
 * 唯一（重复即拒 fail-closed——同一题/同一条注记在一次提交中只能有一条判定）。
 */
export const gradingSubmitInputSchema = z.object({
  results: z.array(gradingResultInputSchema).min(1).max(GRADING_SUBMIT_RESULT_LIMIT),
}).strict().superRefine((v, ctx) => {
  const questionIds = new Set<string>();
  for (const result of v.results) {
    if (questionIds.has(result.questionId)) {
      ctx.addIssue({ code: "custom", message: "results 存在重复 questionId" });
      return;
    }
    questionIds.add(result.questionId);
  }
  const annotationIds = new Set<string>();
  for (const result of v.results) {
    for (const review of result.annotationReviews ?? []) {
      if (annotationIds.has(review.annotationId)) {
        ctx.addIssue({ code: "custom", message: "annotationReviews 存在重复 annotationId" });
        return;
      }
      annotationIds.add(review.annotationId);
    }
  }
});

export type GradingSubmitInput = z.infer<typeof gradingSubmitInputSchema>;

/**
 * 越集校验纯函数（ADR-0035 §3 越集 422 的判据源）：返回 submitted 中不属于
 * scope 集合的 id 清单（空数组 = 全部在集）。questionId 对「题纸作用域题目集」、
 * annotationId 对「该题纸可评注记集合」分别调用。
 */
export function findOutOfScopeIds(
  scope: readonly string[],
  submitted: readonly string[],
): string[] {
  const allowed = new Set(scope);
  return submitted.filter((id) => !allowed.has(id));
}

/**
 * 可评题集合（ADR-0038 决策 4）——**评卷作用域收窄为「该题纸内已物化 active
 * attempt 的题」**。
 *
 * 为什么收窄：`verdict`（correct/partial/wrong）判的是**用户的作答**。用户没作答
 * 就没有可判的对象 —— 允许对未答题提交 verdict，agent 只能编一个。而编出来的
 * `wrong` 会进错题库（「我没做过的错题」），且该题 attempt=0 ⇒
 * `PATCH /api/l3/questions/:id` 的 409 护栏放行 ⇒ 题面可改 ⇒ 判定变成对另一道题
 * 的判定。
 *
 * 收窄的连带好处：「已评 ⇒ 有 attempt ⇒ 题面已冻结」自动成立（不再需要给 PATCH
 * 额外加一条评卷护栏来堵同一个洞）。
 *
 * ⚠️ 只认 `status === "active"` 的 attempt：软删的作答不算（`l3-grading.service`
 * 的上下文组装同口径，两处必须一致，否则 agent 看得见却提交不了）。
 *
 * @param scopedIds 题纸作用域题目集（`resolveSheetScopedQuestions` 的顺序）
 * @param attempts 该题纸的作答行（可含软删；本函数按 status 过滤）
 */
export function gradableQuestionIds(
  scopedIds: readonly string[],
  attempts: readonly { question_id: string; status: string }[],
): string[] {
  const answered = new Set(
    attempts.filter((attempt) => attempt.status === "active").map((attempt) => attempt.question_id),
  );
  // 保持作用域顺序：verdict 结果与上下文顺序一致，agent 不会对不上号
  return scopedIds.filter((id) => answered.has(id));
}

/** 作用域内**不可评**的题 id（未作答）——提交时用于 422 并点名。 */
export function ungradableQuestionIds(
  scopedIds: readonly string[],
  attempts: readonly { question_id: string; status: string }[],
): string[] {
  const gradable = new Set(gradableQuestionIds(scopedIds, attempts));
  return scopedIds.filter((id) => !gradable.has(id));
}

/**
 * 注记 review 后的目标 stage（终态不回滚，ADR-0035 §3.3）：仅「submitted + sound」
 * 升 confirmed；questionable/wrong 维持原 stage；已 confirmed 永不降级（重评只
 * 更新 review）。调用面已保证 current ∈ {submitted, confirmed}（draft 越集 422）。
 */
export function nextAnnotationStage(
  current: string,
  verdict: AnnotationReviewVerdict,
): string {
  if (verdict === "sound" && current === "submitted") return "confirmed";
  return current;
}

/** review 列落库形状（snake_case，对齐 0034 契约与 0035 列形状）。 */
export interface StoredAnnotationReview {
  verdict: AnnotationReviewVerdict;
  corrected_tags?: string[];
  comment?: string;
}

/** HTTP 输入（camelCase）→ review 列落库形状：未提交键不落（无 default 填充）。 */
export function toStoredAnnotationReview(input: GradingAnnotationReviewInput): StoredAnnotationReview {
  return {
    verdict: input.verdict,
    ...(input.correctedTags ? { corrected_tags: input.correctedTags } : {}),
    ...(input.comment ? { comment: input.comment } : {}),
  };
}


/**
 * 🔴 标准答案可信度（answerTrust）—— 不可信的答案不得用于判卷。
 *
 * ## 为什么需要
 *
 * 试卷的 `l3_papers.metadata.answerTrust.status` 标注该卷 `answer` 字段的可信度。
 * 2025 考研英语二那份标的是 `unverified-constructed`：45 道客观题的答案是**人工
 * 构造**的（分布检验见该卷 README「答案是构造的」一节 —— 完形 20 题恰好
 * A5/B5/C5/D5，整体 A11/B11/C11/D10/F1/G1，ordinal 0-5 呈循环）。
 *
 * 拿它当标准答案判分，会得出**与真实水平无关甚至相反**的分数：真实答案 B 的题
 * 标着 C，做对的被判错、做错的被判对。所以 `unverified` 必须 fail-closed。
 *
 * ## 为什么放在 domain 纯函数层
 *
 * 「这道题能不能评」是业务规则，不是 IO。放这里可直接单测，且service 与
 * repository 两侧复用同一判定，避免两处实现漂移。
 */

/** 可信度取值。与 l3_papers.metadata.answerTrust.status 对齐。 */
export const ANSWER_TRUST_STATUSES = [
  /** 已按官方答案钥匙核验，可用于判卷。 */
  "verified",
  /** 人工构造，**不得**用于判卷。 */
  "unverified-constructed",
] as const;

export type AnswerTrustStatus = (typeof ANSWER_TRUST_STATUSES)[number];

/** 只有 `verified` 才可用于判卷；其余（含未知值、缺失）一律 fail-closed。 */
export function isAnswerTrusted(status: unknown): boolean {
  return status === "verified";
}

/** 不可评的原因。`no-attempt` 是 ADR-0038 决策 4 已有的那个；新增的是可信度。 */
export type GradableReason = "no-attempt" | "answer-unverified";

/** 纯 JSON 读出 metadata（repository 已反序列化，但这里要容忍未知形状）。 */
function readTrustStatus(metadata: unknown): unknown {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const trust = (metadata as { answerTrust?: unknown }).answerTrust;
  if (typeof trust !== "object" || trust === null) return undefined;
  return (trust as { status?: unknown }).status;
}

/**
 * 某道题是否可评，以及不可评的原因。
 *
 * @param answerTrustBySource 该题所属 source_id → 可信度 status。
 *        **缺键** = 无标注 = 视为可信（绝大多数正常题目的情形，不能因缺元数据就拒评）；
 *        **有键但值为 undefined** = 标注了 answerTrust 却没写 status = 不可信。
 * @param sourceId 该题的 source_id（null = 无来源题目，按可信处理）
 * @param hasAttempt 该题在当前题纸上是否有 active attempt
 */
export function gradeability(input: {
  answerTrustBySource: ReadonlyMap<string, unknown>;
  sourceId: string | null;
  hasAttempt: boolean;
}): { gradable: boolean; reason: GradableReason | null } {
  if (input.sourceId) {
    // 用 has() 而不是 `status !== undefined` —— 后者把「键存在但值为 undefined」
    // 与「键不存在」混同，于是「标注了却没写 status」这种最该被拦的形状会被放行。
    // SQL 侧 `metadata->'answerTrust'->>'status'` 在 status 缺失时正好返回 null，
    // 映射成 undefined 的键，所以这个形状在真实数据里会出现。
    if (input.answerTrustBySource.has(input.sourceId)) {
      const status = input.answerTrustBySource.get(input.sourceId);
      if (!isAnswerTrusted(status)) {
        // 可信度优先于有无作答：答案本身不可信时，评了也是错的。
        return { gradable: false, reason: "answer-unverified" };
      }
    }
  }
  if (!input.hasAttempt) return { gradable: false, reason: "no-attempt" };
  return { gradable: true, reason: null };
}

/** 不可评原因 → 422 的 code，便于客户端区分「没作答」与「答案不可信」。 */
export function ungradableCode(reason: GradableReason | null): string {
  return reason === "answer-unverified" ? "ANSWER_UNVERIFIED" : "NO_ACTIVE_ATTEMPT";
}
