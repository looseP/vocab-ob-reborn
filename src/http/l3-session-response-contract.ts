/**
 * L3 session response contracts (ADR-0019 §2).
 *
 * plan 只存实体 id 引用（JSON），渲染描述由 service 现拉现组 —— 契约里
 * 没有 HTML 产物，也没有任何 FSRS 字段。行 schema 对齐 domain 的 L3SessionRow
 * 与 L3SessionRenderDescription。
 */
import { z } from "zod";
import type {
  L3SessionContextSummary,
  L3SessionRenderDescription,
  L3SessionRow,
} from "../domain";
import { jsonValueSchema } from "./l3-response-contract";

export const l3SessionRowResponseSchema: z.ZodType<L3SessionRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  type: z.enum(["l2_upgrade", "l3_practice", "cram_pack", "knowledge"]),
  title: z.string().nullable(),
  plan: jsonValueSchema,
  version: z.number().int(),
  status: z.enum(["active", "completed", "abandoned"]),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  created_at: z.string(),
}).strict();

export const l3SessionContextSummaryResponseSchema: z.ZodType<L3SessionContextSummary> = z.object({
  id: z.string(),
  text: z.string(),
  context_type: z.enum(["sentence", "paragraph", "excerpt", "dialogue", "note"]),
  source_id: z.string(),
  source_title: z.string(),
}).strict();

export const l3SessionRenderDescriptionResponseSchema: z.ZodType<L3SessionRenderDescription> = z.object({
  session: l3SessionRowResponseSchema,
  items: z.array(z.object({
    day: z.number().int(),
    contexts: z.array(l3SessionContextSummaryResponseSchema),
  }).strict()),
}).strict();
