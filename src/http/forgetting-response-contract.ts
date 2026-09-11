/**
 * One-click forgetting response contracts (ADR-0020).
 *
 * 三段均为确定性结果（preview / apply / restore），行 schema 取 service 导出的
 * 结果类型；全部 .strict()。
 */
import { z } from "zod";
import type {
  ForgettingApplyResult,
  ForgettingPreview,
  ForgettingRestoreResult,
} from "../services/forgetting.service";

export const forgettingPreviewResponseSchema: z.ZodType<ForgettingPreview> = z.object({
  anchors: z.array(z.string()),
  suspendCount: z.number().int().nonnegative(),
}).strict();

export const forgettingApplyResponseSchema: z.ZodType<ForgettingApplyResult> = z.object({
  batchId: z.string(),
  suspendedCount: z.number().int().nonnegative(),
  pausedCount: z.number().int().nonnegative(),
  anchors: z.array(z.string()),
}).strict();

export const forgettingRestoreResponseSchema: z.ZodType<ForgettingRestoreResult> = z.object({
  restoredCount: z.number().int().nonnegative(),
  unpausedCount: z.number().int().nonnegative(),
}).strict();
