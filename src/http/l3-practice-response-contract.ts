/**
 * L3 practice attempt / error book response contracts (ADR-0019 §1/§3).
 *
 * 红线：契约里**不出现任何 FSRS 字段**（stability/due/retrievability…）——
 * "L3 有记录、无调度"。行 schema 严格对齐 domain 的 L3PracticeAttemptRow。
 */
import { z } from "zod";
import type { L3PracticeAttemptPage, L3PracticeAttemptRow } from "../domain";
import { jsonValueSchema } from "./l3-response-contract";

export const l3PracticeAttemptRowResponseSchema: z.ZodType<L3PracticeAttemptRow> = z.object({
  id: z.string(),
  user_id: z.string(),
  context_id: z.string(),
  occurrence_id: z.string().nullable(),
  session_id: z.string().nullable(),
  practice_type: z.enum(["essay_dictation", "context_quiz"]),
  outcome: z.enum(["correct", "wrong", "skip"]),
  payload: jsonValueSchema,
  created_at: z.string(),
}).strict();

export const l3PracticeAttemptPageResponseSchema: z.ZodType<L3PracticeAttemptPage> = z.object({
  items: z.array(l3PracticeAttemptRowResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();
