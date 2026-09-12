/**
 * L3 practice attempt / error book response contracts (ADR-0019 §1/§3).
 *
 * 红线：契约里**不出现任何 FSRS 字段**（stability/due/retrievability…）——
 * "L3 有记录、无调度"。行 schema 严格对齐 domain 的 L3PracticeAttemptRow。
 *
 * 错题库（T11 加固）：条目在 attempt 行之上叠加三个**服务端聚合**字段
 * （wrongCount / latestOutcome / latestAt，语境级全量口径），并给出
 * cursor 分页的 nextCursor（offset 字段保留，两者共存时 cursor 为准）。
 */
import { z } from "zod";
import type {
  L3PracticeAttemptPage,
  L3PracticeAttemptRow,
  L3PracticeErrorBookItem,
  L3PracticeErrorBookPage,
} from "../domain";
import { jsonValueSchema } from "./l3-response-contract";

const l3PracticeAttemptRowFields = {
  id: z.string(),
  user_id: z.string(),
  context_id: z.string(),
  occurrence_id: z.string().nullable(),
  session_id: z.string().nullable(),
  practice_type: z.enum(["essay_dictation", "context_quiz"]),
  outcome: z.enum(["correct", "wrong", "skip"]),
  payload: jsonValueSchema,
  created_at: z.string(),
} as const;

export const l3PracticeAttemptRowResponseSchema: z.ZodType<L3PracticeAttemptRow> =
  z.object(l3PracticeAttemptRowFields).strict();

export const l3PracticeAttemptPageResponseSchema: z.ZodType<L3PracticeAttemptPage> = z.object({
  items: z.array(l3PracticeAttemptRowResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();

// ── 错题库响应（T11 加固：服务端聚合 + cursor 纯新增）──────────────────────

/**
 * 错题库条目 = attempt 行 + 三个聚合字段。wrongCount 为该语境全量
 * outcome='wrong' 计数（≥1，条目自身即一条 wrong）；latestOutcome / latestAt
 * 取自该语境最近一次作答（不限 outcome），跨任何分页窗口均正确。
 */
export const l3PracticeErrorBookItemResponseSchema: z.ZodType<L3PracticeErrorBookItem> = z.object({
  ...l3PracticeAttemptRowFields,
  wrongCount: z.number().int().min(1),
  latestOutcome: z.enum(["correct", "wrong", "skip"]),
  latestAt: z.string(),
}).strict();

/**
 * 错题库分页：offset 字段保留（兼容窗口），nextCursor 为 cursor 分页的下一页
 * 游标（offset 模式下亦给出，可直接续用）；null = 已到末页。
 */
export const l3PracticeErrorBookPageResponseSchema: z.ZodType<L3PracticeErrorBookPage> = z.object({
  items: z.array(l3PracticeErrorBookItemResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();
