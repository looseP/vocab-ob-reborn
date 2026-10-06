/**
 * Hulu sprint response contracts (ADR-0041).
 *
 * 行 schema 取 domain 导出的行类型（单一真源：`src/domain/hulu-sprint.ts`），
 * 全部 `.strict()`。契约里**没有**任何 FSRS 字段 —— 葫芦的两张表不带 FSRS 列。
 *
 * `getHuluPlan` 返回 { plan, rounds }：rounds 是缩时曲线的唯一数据源（P2 消费），
 * 本期先按域类型整体出参（P1 起按需裁剪）。
 */
import { z } from "zod";
import type { HuluPlanRow, HuluPlanWithRounds, HuluRoundRow } from "../domain/hulu-sprint";

export const huluPlanRowResponseSchema: z.ZodType<HuluPlanRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  wordbook_id: z.string(),
  direction: z.string().nullable(),
  exam_date: z.string(),
  target_rounds: z.number().int(),
  page_size: z.number().int(),
  gate_ratio: z.number(),
  word_ids: z.array(z.string()),
  status: z.enum(["active", "completed", "abandoned"]),
  suspend_review: z.boolean(),
  suspend_snapshot: z.record(z.string(), z.string()).nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  created_at: z.string(),
}).strict();

export const huluRoundRowResponseSchema: z.ZodType<HuluRoundRow> = z.object({
  id: z.string(),
  plan_id: z.string(),
  user_id: z.string(),
  round_no: z.number().int(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  elapsed_seconds: z.number().int().nullable(),
  pages_passed: z.number().int(),
  words_passed: z.number().int(),
  words_total: z.number().int(),
}).strict();

export const huluPlanWithRoundsResponseSchema: z.ZodType<HuluPlanWithRounds> = z.object({
  plan: huluPlanRowResponseSchema,
  rounds: z.array(huluRoundRowResponseSchema),
}).strict();
