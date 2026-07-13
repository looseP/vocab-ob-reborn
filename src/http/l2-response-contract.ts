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
