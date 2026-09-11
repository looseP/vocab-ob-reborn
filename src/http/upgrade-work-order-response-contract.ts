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

export const upgradeWorkOrderRowResponseSchema: z.ZodType<UpgradeWorkOrderRow> = z.object({
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

export const upgradeWorkOrderMarkResponseSchema: z.ZodType<MarkUpgradeResult> = z.object({
  workOrder: upgradeWorkOrderRowResponseSchema,
  suggestion: z.enum(["strong", "normal", "needs_settling"]),
  suggestionSnapshot: upgradeSuggestionSnapshotResponseSchema,
}).strict();

export const upgradeWorkOrderListResponseSchema = z.object({
  items: z.array(upgradeWorkOrderRowResponseSchema),
}).strict();

export const upgradeWorkOrderCompleteResponseSchema: z.ZodType<CompleteUpgradeResult> = z.object({
  workOrder: upgradeWorkOrderRowResponseSchema,
  alreadyPromoted: z.boolean(),
  l2DueAt: z.string().nullable(),
  seeded: z.boolean(),
}).strict();
