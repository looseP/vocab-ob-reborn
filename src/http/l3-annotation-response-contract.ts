/**
 * 做题注记（原文分析条目）与规律标签字典 HTTP 响应契约（批次一，0033）。
 *
 * 行字段沿用仓库 snake_case 惯例；所有响应经 operations 注册表中间件按本契约校验。
 * 注记只对外暴露 active 行（status 字段保留枚举契约以便同形复用）。
 */
import { z } from "zod";

const annotationOptionTagsResponseSchema = z.object({
  A: z.array(z.string()).optional(),
  B: z.array(z.string()).optional(),
  C: z.array(z.string()).optional(),
  D: z.array(z.string()).optional(),
}).strict();

export const l3QuestionAnnotationResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  question_id: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  anchor_start: z.number().int().nonnegative().nullable(),
  anchor_end: z.number().int().nonnegative().nullable(),
  excerpt: z.string().nullable(),
  note: z.string(),
  entry_tags: z.array(z.string()),
  option_tags: annotationOptionTagsResponseSchema,
  // 批次二（ADR-0034 §3）：stage 生命周期（与软删 status 正交）；sheet_id 草稿期挂
  // 题纸；review 为 agent 检验产物（批次三写，当前恒 null，形状暂不收口）。
  stage: z.enum(["draft", "submitted", "confirmed"]),
  sheet_id: z.string().uuid().nullable(),
  review: z.unknown().nullable(),
  status: z.enum(["active", "deleted"]),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const l3QuestionAnnotationItemResponseSchema = z.object({
  item: l3QuestionAnnotationResponseSchema,
}).strict();

export const l3QuestionAnnotationListResponseSchema = z.object({
  items: z.array(l3QuestionAnnotationResponseSchema),
}).strict();

export const l3AnnotationTagDictResponseSchema = z.object({
  entry: z.array(z.string()),
  option: z.array(z.string()),
}).strict();
