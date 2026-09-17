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
}).strict();
