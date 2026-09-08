import { z } from "zod";
import type { PaginatedResult, WordDetail, WordDetailL2Content, WordSummary } from "../domain";
import type { ParsedCoreDefinition } from "@/domain/ingest/types";
import { jsonValueSchema } from "./l3-response-contract";
import {
  l2CollocationItemSchema,
  l2CorpusItemSchema,
  l2SynonymItemSchema,
} from "@/schemas/service";

export const wordSummaryResponseSchema: z.ZodType<WordSummary> = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  ipa: z.string().nullable(),
  short_definition: z.string().nullable(),
  metadata: jsonValueSchema,
}).strict();

/**
 * L2 enrichment 展示项。缓存条目可能是 v1 形态（带 provenance/evidence 溯源），
 * passthrough() 保留这些字段用于前端溯源徽标；沿用 service 层字段合同做结构校验。
 * cast 桥接：zod passthrough 的 unknown 索引签名与 Json 静态类型之间的差异由
 * 运行时 item schema 校验兜底。
 */
const wordDetailL2ContentSchema = z.object({
  collocations: z.array(l2CollocationItemSchema.passthrough()),
  corpus_items: z.array(l2CorpusItemSchema.passthrough()),
  synonym_items: z.array(l2SynonymItemSchema.passthrough()),
  antonym_items: z.array(l2SynonymItemSchema.passthrough()),
}).strict() as z.ZodType<WordDetailL2Content>;

/** 核心释义义项（Bound sense 圈记条下拉数据源；parse 阶段已保证 sense 非空）。 */
const coreDefinitionSchema: z.ZodType<ParsedCoreDefinition> = z.object({
  sense: z.string(),
  en: z.string().nullable(),
  priority: z.number().nullable(),
  tags: z.array(z.string()),
}).strict();

export const wordDetailResponseSchema: z.ZodType<WordDetail> = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
  ipa: z.string().nullable(),
  aliases: z.array(z.string()),
  short_definition: z.string().nullable(),
  definition_md: z.string(),
  body_md: z.string(),
  examples: jsonValueSchema,
  prototype_text: z.string().nullable(),
  core_definitions: z.array(coreDefinitionSchema),
  metadata: jsonValueSchema,
  l2_content: wordDetailL2ContentSchema,
  l2_promoted: z.boolean(),
}).strict();

export const wordListResponseSchema: z.ZodType<PaginatedResult<WordSummary>> = z.object({
  items: z.array(wordSummaryResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict();

// L1-2：输入联想响应——仅 items（无需分页元数据）。
export const wordSuggestResponseSchema = z.object({
  items: z.array(wordSummaryResponseSchema),
}).strict();

export const wordBatchCreateResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
}).strict();
