/**
 * L3 空间汇总响应契约（B1 素材宇宙）。
 *
 * counts 复用 L3ReadStats（与 graph / source-space 的 stats 同语义：四类实体
 * 全量计数）；growth.byDay 为窗口内**每日新增**（显示时区 Asia/Shanghai 切日，
 * 升序、稀疏——仅含产生过新增的日期，展示端按 windowDays 补零后自行累加）。
 *
 * 纯只读：不写任何 active L3 行、不触 FSRS（ADR-0004 §6 / ADR-0005 红线）。
 */
import { z } from "zod";
import type { L3SpaceSummary, L3SpaceSummaryDay } from "../domain";

const nonNegativeInt = z.number().int().nonnegative();

export const l3SpaceSummaryDayResponseSchema: z.ZodType<L3SpaceSummaryDay> = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceCount: nonNegativeInt,
  contextCount: nonNegativeInt,
  occurrenceCount: nonNegativeInt,
  linkCount: nonNegativeInt,
}).strict();

export const l3SpaceSummaryResponseSchema: z.ZodType<L3SpaceSummary> = z.object({
  counts: z.object({
    sourceCount: nonNegativeInt,
    contextCount: nonNegativeInt,
    occurrenceCount: nonNegativeInt,
    linkCount: nonNegativeInt,
  }).strict(),
  growth: z.object({
    windowDays: z.number().int().positive(),
    byDay: z.array(l3SpaceSummaryDayResponseSchema),
  }).strict(),
}).strict();
