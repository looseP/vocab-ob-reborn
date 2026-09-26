/**
 * 评卷执行面 HTTP 响应契约（批次三①，0036，ADR-0035）。
 *
 * 🔴 grading-context 响应含标准答案（answerIndex）——D8 唯一显式例外（ADR-0035 §2）：
 *   **仅 sealed + agent 面**；前端**永不**消费此端点，禁止接入做题模式前端。
 *   grading results 读面（解析模式）不含 answerIndex，与 agent 面严格分离。
 * 行字段沿用仓库 snake_case 惯例；所有响应经 operations 注册表中间件按本契约校验。
 */
import { z } from "zod";
import { GRADING_VERDICTS } from "@/domain/l3-grading";
import { L3_QUESTION_TYPES } from "@/domain/l3-question-types";
import { l3QuestionAnnotationResponseSchema } from "./l3-annotation-response-contract";
import { l3QuestionAnswerResponseSchema, l3QuestionOptionResponseSchema } from "./l3-paper-response-contract";
import { l3SubmissionResponseSchema } from "./l3-sheet-response-contract";
import { jsonValueSchema } from "./l3-response-contract";

const questionTypeSchema = z.enum(L3_QUESTION_TYPES);
const spaceSchema = z.enum(["语法", "阅读", "作文", "翻译", "通用"]);

/** l3_grading_results 行（verdict 真源；latest-wins 无历史版本）。 */
export const l3GradingResultResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  sheet_id: z.string().uuid(),
  question_id: z.string().uuid(),
  verdict: z.enum(GRADING_VERDICTS),
  analysis_md: z.string().nullable(),
  /** 服务端认定的评卷者（bearer agentId / owner）。 */
  graded_by: z.string(),
  graded_at: z.string(),
}).strict();

/** 评卷上下文单题视图（answerIndex = D8 唯一例外）。 */
const l3GradingContextQuestionSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  question_type: questionTypeSchema,
  space: spaceSchema,
  stem: z.string(),
  options: z.array(l3QuestionOptionResponseSchema),
  /** 🔴 含标准答案：仅 sealed + agent 面（前端永不消费本响应）。 */
  answerIndex: l3QuestionAnswerResponseSchema,
  explanation: z.string().nullable(),
  source_id: z.string().uuid().nullable(),
  /**
   * 可评标记（ADR-0038 决策 4）：false = 该题在这张题纸上没有 active attempt，
   * 提交 verdict 会被 422 拒。显式给出是让 agent 不必靠一次被拒的提交才发现。
   */
  gradable: z.boolean(),
  attempt: z.object({
    answer: jsonValueSchema,
    self_assessment: jsonValueSchema.nullable(),
    created_at: z.string(),
  }).strict().nullable(),
  /** 该题纸 submitted 注记（提交即授权收口）。 */
  annotations: z.array(l3QuestionAnnotationResponseSchema),
}).strict();

const l3GradingContextSourceSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  content_text: z.string().nullable(),
}).strict();

/** GET /l3/sheets/:id/grading-context（agent 面；🔴 含答案，禁止接入做题模式前端）。 */
export const l3GradingContextResponseSchema = z.object({
  sheet: l3SubmissionResponseSchema,
  questions: z.array(l3GradingContextQuestionSchema),
  sources: z.array(l3GradingContextSourceSchema),
}).strict();

/** POST /l3/sheets/:id/grading：落库计数回执。 */
export const l3GradingSubmitResponseSchema = z.object({
  sheet: l3SubmissionResponseSchema,
  resultCount: z.number().int().nonnegative(),
  annotationReviewCount: z.number().int().nonnegative(),
  /** 本次由 sound 自动升 confirmed 的注记数。 */
  confirmedCount: z.number().int().nonnegative(),
}).strict();

/** GET /l3/sheets/:id/grading（owner 解析模式读面；不含 answerIndex）。 */
export const l3GradingResultsResponseSchema = z.object({
  sheet: l3SubmissionResponseSchema,
  results: z.array(l3GradingResultResponseSchema),
  /**
   * 可评题数（ADR-0038 决策 8）= 已物化 active attempt 的题数。「已评 n/m」的 m
   * 必须是它：未作答的题不参与评卷，用题单总数当分母会显示一个补不齐的缺口。
   */
  gradableCount: z.number().int().nonnegative(),
}).strict();

/**
 * GET /l3/sheets/pending-grading（ADR-0038 决策 2；agent 可读发现面）。
 *
 * **只给身份与计数**：不含题干/选项/答案/解析/作答/注记。取料走 grading-context
 * （那里带答案，是 D8 的显式例外面）；本面只回答「agent 该评哪张」。
 */
export const l3PendingGradingItemResponseSchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  sealed_at: z.string(),
  graded_count: z.number().int().nonnegative(),
  gradable_count: z.number().int().nonnegative(),
  question_count: z.number().int().nonnegative(),
  venue_title: z.string().nullable(),
}).strict();

export const l3PendingGradingListResponseSchema = z.object({
  items: z.array(l3PendingGradingItemResponseSchema),
}).strict();
