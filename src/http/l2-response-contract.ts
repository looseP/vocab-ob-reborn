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

/** Phase F：主动晋升响应（alreadyPromoted=true 表示幂等命中既有 L2 行）。 */
export const l2PromoteResponseSchema = z.object({
  ok: z.literal(true),
  alreadyPromoted: z.boolean(),
  l2DueAt: z.string().nullable(),
}).strict();

/** Phase G：Agent 候选池。 */
export const l2CandidateSchema = z.object({
  id: z.string(),
  field: z.string(),
  itemCount: z.number().int().nonnegative(),
  items: z.array(jsonValueSchema),
  source: z.string(),
  createdAt: z.string(),
}).strict();

export const l2CandidatesResponseSchema = z.object({
  items: z.array(l2CandidateSchema),
}).strict();

export const l2CandidateAcceptResponseSchema = z.object({
  ok: z.literal(true),
  itemCount: z.number().int().nonnegative(),
  /** replace 模式下被停用的旧行数；append 为 0。 */
  replacedCount: z.number().int().nonnegative().optional(),
}).strict();

export const l2CandidateRejectResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

/** Phase G 管理面板：行级内容管理（active + retired）。 */
export const l2ContentRowSchema = z.object({
  id: z.string(),
  field: z.string(),
  itemCount: z.number().int().nonnegative(),
  items: z.array(jsonValueSchema),
  source: z.string(),
  sourceRef: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
}).strict();

export const l2ContentRowsResponseSchema = z.object({
  active: z.array(l2ContentRowSchema),
  retired: z.array(l2ContentRowSchema),
}).strict();

export const l2ContentRowMutateResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

/** Phase G：MCP propose 入口响应（写入 is_active=false 候选行）。 */
export const l2CandidateProposeResponseSchema = z.object({
  candidateId: z.string(),
  itemCount: z.number().int().nonnegative(),
}).strict();
