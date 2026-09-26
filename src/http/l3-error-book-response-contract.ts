/**
 * 错题库统一投影 HTTP 响应契约（2026-09-26）。
 *
 * 与 `l3-practice-response-contract.ts`（句级错题）的区别：那是**一条腿**的窄视图，
 * 本契约是**两腿合并**后的错题库口径。`kind` 字段是消费方分区的依据
 * （CONTEXT.md「错题条目」：按 kind 分区，不建第二个错题表）。
 *
 * 纪律：契约里**不出现任何 FSRS 字段**（ADR-0004 §6 红线）；纯派生，只读。
 */

import { z } from "zod";
import { L3_QUESTION_TYPES } from "@/domain/l3-question-types";
import { L3_SUB_SPACES } from "@/services/l3-practice.service";

/** 错题条目所属腿。 */
export const l3ErrorBookKindSchema = z.enum(["sentence", "question"]);

export const l3UnifiedErrorBookItemSchema = z.object({
  kind: l3ErrorBookKindSchema,
  /** 错记录自身 id（句级 = attempt id；题级 = grading_results id）。 */
  id: z.string().uuid(),
  /** 被练实体 id（句级 = context_id；题级 = question_id）——回流出口的锚点。 */
  target_id: z.string().uuid(),
  /** 一行摘要：句级 = 语境原文；题级 = 题干前 120 字。 */
  target_label: z.string(),
  /** 句级 = null；题级 = question_type。 */
  target_secondary: z.string().nullable(),
  source_id: z.string().uuid().nullable(),
  source_title: z.string().nullable(),
  question_type: z.enum(L3_QUESTION_TYPES).nullable(),
  space: z.enum(L3_SUB_SPACES).nullable(),
  direction: z.string().nullable(),
  /** 句级 = 所属会话；题级 = 判分所在题纸（回看深链的锚点）。 */
  sheet_id: z.string().uuid().nullable(),
  practice_type: z.string().nullable(),
  wrong_count: z.number().int().min(1),
  /** 句级 outcome / 题级 verdict —— 两套词表不同义，不得互相映射。 */
  latest_outcome: z.string(),
  latest_at: z.string(),
}).strict();

export const l3UnifiedErrorBookResponseSchema = z.object({
  items: z.array(l3UnifiedErrorBookItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();
