import { z } from "zod";
import { l2FieldSchema } from "@/schemas/service";
import { jsonValueSchema } from "./l3-response-contract";

const l2RouteFieldSchema = z.enum([
  "collocation",
  "corpus",
  "example",
  "synonym",
  "antonym",
]);

export const l2DraftResponseSchema = z.object({
  draft: jsonValueSchema,
  sourceMode: z.enum([
    "internal_llm",
    "dictionary",
    "dictionary_llm_refined",
  ]).optional(),
}).strict();

export const l2ExternalPromptResponseSchema = z.object({
  field: l2RouteFieldSchema,
  storageField: l2FieldSchema,
  styleProfileId: z.string().min(1),
  promptVersion: z.string().regex(/^l2-(collocation|example|synonym|antonym)-external-v1$/),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/),
  prompt: z.string().min(1),
  expectedJsonSchema: jsonValueSchema,
}).strict();

export const l2ConfirmResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

/** Phase D：LLM 接入状态快照（设置页"AI 扩展"卡消费）。 */
export const l2LlmStatusResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  budget: z.object({
    dailyLimitTokens: z.number().int().positive(),
    usedTodayTokens: z.number().int().nonnegative(),
    resetsAt: z.string(),
  }).nullable(),
}).strict();
