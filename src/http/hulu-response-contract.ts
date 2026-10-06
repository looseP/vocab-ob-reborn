/**
 * Hulu sprint response contracts (ADR-0041).
 *
 * 行 schema 取 domain 导出的类型（单一真源：`src/domain/hulu-sprint.ts`），
 * 全部 `.strict()`。契约里**没有**任何 FSRS 字段 —— 葫芦的两张表不带 FSRS 列。
 *
 * `getHuluPlan` 返回 { plan, rounds }：rounds 是缩时曲线的唯一数据源（P2 消费）。
 * **plan 出参是摘要**（P1 裁剪）：不出参全量 `word_ids` / `suspend_snapshot`，
 * 只给 `word_count` / `suspended_count` —— 前端不再需要全量 id（页载荷走
 * `GET .../pages/:no`、曲线走 rounds），把 20000 个 uuid 塞进每次计划读是纯负担。
 */
import { z } from "zod";
import type {
  HuluPagePayload,
  HuluPlanSummary,
  HuluPlanWithRounds,
  HuluRoundRow,
} from "../domain/hulu-sprint";

export const huluPlanRowResponseSchema: z.ZodType<HuluPlanSummary> = z.object({
  id: z.string(),
  user_id: z.string(),
  wordbook_id: z.string(),
  direction: z.string().nullable(),
  exam_date: z.string(),
  target_rounds: z.number().int(),
  page_size: z.number().int(),
  gate_ratio: z.number(),
  /** 定格词数（= cardinality(word_ids)）；页数由 word_count + page_size 推出。 */
  word_count: z.number().int(),
  status: z.enum(["active", "completed", "abandoned"]),
  suspend_review: z.boolean(),
  /** 挂起快照条目数（未 apply 或已恢复时为 0）。 */
  suspended_count: z.number().int(),
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

/** 页载荷（R4）：只读卡面渲染所需的最小字段集。 */
export const huluPageWordItemResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  ipa: z.string().nullable(),
  pos: z.string().nullable(),
  short_definition: z.string().nullable(),
  mnemonic_text: z.string().nullable(),
}).strict();

export const huluPageResponseSchema: z.ZodType<HuluPagePayload> = z.object({
  pageIndex: z.number().int(),
  pages: z.number().int(),
  total: z.number().int(),
  alive: z.number().int(),
  items: z.array(huluPageWordItemResponseSchema),
}).strict();
