/**
 * Upgrade work order response contracts (ADR-0018).
 *
 * 行 schema 严格对齐 domain 的 UpgradeWorkOrderRow；写路径返回 mark / complete
 * 的复合结果（service 导出类型）。全部 .strict()：新增字段必须同步契约。
 */
import { z } from "zod";
import type { UpgradeWorkOrderRow } from "../domain";
import type {
  CompleteUpgradeResult,
  MarkUpgradeResult,
  UpgradeSuggestionSnapshot,
} from "../services/upgrade-work-order.service";
import type { UpgradeSuggestionLevel } from "../domain/upgrade-suggestion";
import { jsonValueSchema } from "./l3-response-contract";

export const upgradeSuggestionSnapshotResponseSchema: z.ZodType<UpgradeSuggestionSnapshot> = z.object({
  level: z.enum(["strong", "normal", "needs_settling"]),
  currentBookL1: z.object({
    recentRatings: z.array(z.string()),
    state: z.string(),
  }).strict(),
  otherBooksL2: z.array(z.object({
    state: z.string(),
    retrievability: z.number().nullable(),
    l2ProductionStatus: z.string().nullable(),
  }).strict()),
  capturedAt: z.string(),
}).strict();

const upgradeWorkOrderRowObjectSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  word_id: z.string(),
  wordbook_id: z.string(),
  direction: z.enum(["通用", "考研", "雅思"]),
  status: z.enum(["标记中", "升级中", "已完成", "已取消"]),
  suggestion_snapshot: jsonValueSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
}).strict();

export const upgradeWorkOrderRowResponseSchema: z.ZodType<UpgradeWorkOrderRow> =
  upgradeWorkOrderRowObjectSchema;

/**
 * 待升级清单 item 的 HTTP 形状（ADR-0018 §1）：行字段 + `word` 词面 +
 * `suggestion` 档位。**只扩 list 响应**——mark/start/cancel/complete 继续
 * 返回纯行（行契约不动，避免下游 fixture 连锁改动）。
 * `word.slug / word.text` 如实为 nullable（LEFT JOIN words；FK cascade 下
 * 理论不可达，但不假装必然命中）。
 */
export interface UpgradeWorkOrderListItemResponse extends UpgradeWorkOrderRow {
  word: { slug: string | null; text: string | null };
  suggestion: UpgradeSuggestionLevel;
}

export const upgradeWorkOrderListItemResponseSchema: z.ZodType<UpgradeWorkOrderListItemResponse> =
  upgradeWorkOrderRowObjectSchema.extend({
    word: z.object({
      slug: z.string().nullable(),
      text: z.string().nullable(),
    }).strict(),
    suggestion: z.enum(["strong", "normal", "needs_settling"]),
  }).strict();

export const upgradeWorkOrderMarkResponseSchema: z.ZodType<MarkUpgradeResult> = z.object({
  workOrder: upgradeWorkOrderRowResponseSchema,
  suggestion: z.enum(["strong", "normal", "needs_settling"]),
  suggestionSnapshot: upgradeSuggestionSnapshotResponseSchema,
}).strict();

export const upgradeWorkOrderListResponseSchema = z.object({
  items: z.array(upgradeWorkOrderListItemResponseSchema),
}).strict();

export const upgradeWorkOrderCompleteResponseSchema: z.ZodType<CompleteUpgradeResult> = z.object({
  workOrder: upgradeWorkOrderRowResponseSchema,
  alreadyPromoted: z.boolean(),
  l2DueAt: z.string().nullable(),
  seeded: z.boolean(),
}).strict();
