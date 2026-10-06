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
  HuluPageWordItem,
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

/**
 * 义项 schema。形状与 domain 的 `CoreSense`（`src/domain/hulu-sprint.ts`）同源，
 * 前端 `SenseList` 也复用同一类型 —— 同一个 jsonb 形状只描述一次。
 * `priority` 可空（旧数据），`tags` 恒为数组（入库保证；防御性给缺省）。
 */
const coreSenseSchema = z.object({
  sense: z.string(),
  en: z.string().nullable(),
  priority: z.number().nullable(),
  tags: z.array(z.string()),
}).strict();

/**
 * 页载荷的一件词卡（R4；修订轮 R10 扩字段）。
 *
 * 字段清单即**卡面五层的唯一取数方式**：一切数据随页载荷批量带下 ⇒ 单卡路径
 * 零请求（禁 `useWordDetail`、禁嵌 `ReviewCardView`）。
 * `examples` 元素形状由导入器决定（历史数据形状不一），故为 `unknown[]`：
 * 前端逐项窄化、缺字段安静降级，契约层不假装知道每个元素的形状。
 */
export const huluPageWordItemResponseSchema: z.ZodType<HuluPageWordItem> = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  ipa: z.string().nullable(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  short_definition: z.string().nullable(),
  /** 结构化义项（priority 序即重要程度）；空数组 → 前端走 definition_md 降级。 */
  core_definitions: z.array(coreSenseSchema),
  definition_md: z.string(),
  examples: z.array(z.unknown()),
  prototype_text: z.string().nullable(),
  mnemonic_text: z.string().nullable(),
  mnemonic_type: z.string().nullable(),
  semantic_chain: z.string().nullable(),
}).strict();

export const huluPageResponseSchema: z.ZodType<HuluPagePayload> = z.object({
  pageIndex: z.number().int(),
  pages: z.number().int(),
  total: z.number().int(),
  alive: z.number().int(),
  items: z.array(huluPageWordItemResponseSchema),
}).strict();
