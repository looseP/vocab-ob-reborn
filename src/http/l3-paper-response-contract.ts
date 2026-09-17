/**
 * L3 题目/试卷 HTTP 响应契约（ADR-0030）。
 *
 * 行字段沿用仓库 snake_case 惯例；paper.payload 内 section 用 camelCase
 * （domain L3PaperSection 的存储形状）。所有响应经操作注册表中间件按本契约校验。
 */
import { z } from "zod";
import { L3_QUESTION_TYPES } from "../domain/l3-question-types";

const questionTypeSchema = z.enum(L3_QUESTION_TYPES);

const spaceSchema = z.enum(["语法", "阅读", "作文", "翻译", "通用"]);

export const l3QuestionOptionResponseSchema = z.object({
  key: z.string(),
  text: z.string(),
}).strict();

export const l3EvidenceAnchorResponseSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  label: z.string(),
}).strict();

export const l3QuestionAnswerResponseSchema = z.object({
  choice: z.string().optional(),
  choices: z.array(z.string()).optional(),
  text: z.string().optional(),
  sample: z.string().optional(),
  points: z.array(z.string()).optional(),
}).strict();

export const l3QuestionResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  source_id: z.string().uuid().nullable(),
  file_key: z.string().nullable(),
  space: spaceSchema,
  question_type: questionTypeSchema,
  ordinal: z.number().int().nonnegative(),
  stem: z.string(),
  options: z.array(l3QuestionOptionResponseSchema),
  answer: l3QuestionAnswerResponseSchema,
  explanation: z.string().nullable(),
  evidence: z.array(l3EvidenceAnchorResponseSchema),
  status: z.enum(["pending", "active", "rejected"]),
  created_by: z.string(),
  input_hash: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3QuestionCreateResponseSchema = z.object({
  question: l3QuestionResponseSchema,
}).strict();

export const l3QuestionDeleteResponseSchema = z.object({
  deleted: z.literal(true),
}).strict();

// ── payload 与卷面组装 ───────────────────────────────────────────────────
export const l3PaperSectionPayloadSchema = z.object({
  key: z.string(),
  title: z.string(),
  questionType: questionTypeSchema,
  sourceId: z.string().uuid().nullable(),
  fileKey: z.string().nullable(),
  questionIds: z.array(z.string().uuid()),
}).strict();

export const l3PaperPayloadResponseSchema = z.object({
  version: z.literal(1),
  sections: z.array(l3PaperSectionPayloadSchema),
}).strict();

export const l3PaperRowResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string(),
  direction: z.enum(["通用", "考研", "雅思"]).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  payload: l3PaperPayloadResponseSchema,
  payload_version: z.number().int().positive(),
  status: z.enum(["draft", "active", "archived"]),
  created_by: z.string(),
  input_hash: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3AssembledSectionResponseSchema = z.object({
  key: z.string(),
  title: z.string(),
  questionType: questionTypeSchema,
  sourceId: z.string().uuid().nullable(),
  fileKey: z.string().nullable(),
  questionIds: z.array(z.string().uuid()),
  missing: z.boolean(),
  missing_reason: z.enum(["source", "questions"]).optional(),
  source_title: z.string().nullable(),
  source_content: z.string().nullable(),
  questions: z.array(l3QuestionResponseSchema),
}).strict();

export const l3PaperDetailResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string(),
  direction: z.enum(["通用", "考研", "雅思"]).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  payload: l3PaperPayloadResponseSchema,
  payload_version: z.number().int().positive(),
  status: z.enum(["draft", "active", "archived"]),
  created_by: z.string(),
  input_hash: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  sections: z.array(l3AssembledSectionResponseSchema),
}).strict();

export const l3PaperCreateResponseSchema = z.object({
  paper: l3PaperRowResponseSchema,
  questions: z.array(l3QuestionResponseSchema),
  questionCount: z.number().int().nonnegative(),
}).strict();

// ── 列表 ────────────────────────────────────────────────────────────────
export const l3PaperListItemResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  direction: z.enum(["通用", "考研", "雅思"]).nullable(),
  status: z.enum(["draft", "active", "archived"]),
  section_count: z.number().int().nonnegative(),
  question_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3PaperListResponseSchema = z.object({
  items: z.array(l3PaperListItemResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();

export const l3PracticeFileListItemResponseSchema = z.object({
  question_type: questionTypeSchema,
  source_id: z.string().uuid().nullable(),
  file_key: z.string().nullable(),
  title: z.string(),
  direction: z.enum(["通用", "考研", "雅思"]).nullable(),
  question_count: z.number().int().nonnegative(),
  latest_created_at: z.string(),
}).strict();

export const l3PracticeFileListResponseSchema = z.object({
  items: z.array(l3PracticeFileListItemResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();

export const l3PracticeFileDetailResponseSchema = z.object({
  question_type: questionTypeSchema,
  source: z.object({ id: z.string().uuid(), title: z.string() }).strict().nullable(),
  /** 原文正文：做题表面（file venue 题纸）文栏渲染所需；仅 source 型文件返回，fileKey 型为 null。 */
  source_content: z.string().nullable(),
  file_key: z.string().nullable(),
  questions: z.array(l3QuestionResponseSchema),
}).strict();
