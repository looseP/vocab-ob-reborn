/**
 * 题纸与作答历史 HTTP 响应契约（批次二，0034）。
 *
 * 行字段沿用仓库 snake_case 惯例；所有响应经 operations 注册表中间件按本契约
 * 校验。draft 题纸含 answers（在写会话恢复）；settled 题纸 answers 已清空
 * （定格物化后），逐题明细走 attempts（deleted 行内容已在 service 层遮蔽）。
 */

import { z } from "zod";
import { L3_QUESTION_TYPES } from "@/domain/l3-question-types";
import { SEAL_MODES, SHEET_SCOPES, SHEET_STATUSES } from "@/domain/l3-sheets";
import { jsonValueSchema } from "./l3-response-contract";

export const l3SubmissionResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  scope: z.enum(SHEET_SCOPES),
  scope_key: z.string(),
  source_id: z.string().uuid().nullable(),
  question_type: z.enum(L3_QUESTION_TYPES).nullable(),
  paper_id: z.string().uuid().nullable(),
  status: z.enum(SHEET_STATUSES),
  /** 仅 draft 期非空；定格物化后恒 `{}`（attempts 是唯一作答真源）。 */
  answers: z.record(z.string(), jsonValueSchema),
  seal_mode: z.enum(SEAL_MODES).nullable(),
  summary: z.string().nullable(),
  sealed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3QuestionAttemptResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  question_id: z.string().uuid(),
  sheet_id: z.string().uuid().nullable(),
  venue: z.enum(SHEET_SCOPES),
  /** deleted 行内容已遮蔽为 null（占位语义，不泄漏内容）。 */
  answer: jsonValueSchema.nullable(),
  self_assessment: jsonValueSchema.nullable(),
  status: z.enum(["active", "deleted"]),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
}).strict();

/** 开纸（200 复用 / 201 新建）与 PATCH 的响应：单行题纸。 */
export const l3SheetItemResponseSchema = z.object({
  sheet: l3SubmissionResponseSchema,
}).strict();

/** 题纸详情：draft 时 attempts 空数组；settled 时按作用域题序派生。 */
export const l3SheetDetailResponseSchema = z.object({
  sheet: l3SubmissionResponseSchema,
  attempts: z.array(l3QuestionAttemptResponseSchema),
}).strict();

/** 定格响应：未答计数（软确认数据源）+ 物化/升格计数（toast 文案数据源）。 */
export const l3SheetSealResponseSchema = z.object({
  sheet: l3SubmissionResponseSchema,
  unansweredCount: z.number().int().nonnegative(),
  /** v2 §10：待复查题数（软确认提示数据源；不物化、不阻断）。 */
  recheckCount: z.number().int().nonnegative(),
  materializedCount: z.number().int().nonnegative(),
  promotedAnnotationCount: z.number().int().nonnegative(),
}).strict();

export const l3AttemptListResponseSchema = z.object({
  items: z.array(l3QuestionAttemptResponseSchema),
}).strict();
