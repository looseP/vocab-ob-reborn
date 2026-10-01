/**
 * 分层 content_hash 计算 —— 双轨 FSRS 的隔离基础。
 *
 * L1 hash = hash(释义 + 词根 + 记忆锚点 + 语义链路) —— L1 漂移检测
 * L2 hash = hash(搭配 + 语料 + 同义 + 反义) —— L2 漂移检测
 * Full hash = hash(L1 + L2) —— 全量，兼容导入去重
 */
import { createHash } from "node:crypto";

/**
 * 字段类型带 `| null` 而不是仅 `undefined`：words 表里这些列都可空，
 * 而 SQL 取出来的行就是可空列 —— 之前这里不写 null，调用方只能 `as never`
 * 绕过，于是「类型与真实数据不符」这件事被掩盖了很久（PR #182 补测试时暴露）。
 *
 * 三个 compute 函数内部统一用 `?? ""` / `?? []` / `?? null` 归一化，
 * 所以接受 null 不改变任何 hash 输出；确定性由 tests/db/content-hash.test.ts 守着。
 */
export interface WordForHashing {
  definition_md?: string | null;
  core_definitions?: unknown;
  prototype_text?: string | null;
  metadata?: {
    morphology?: unknown;
    mnemonic?: unknown;
    semantic_chain?: unknown;
  } | null;
  collocations?: unknown;
  corpus_items?: unknown;
  synonym_items?: unknown;
  antonym_items?: unknown;
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** L1 hash = hash(L1 字段：释义+词根+记忆锚点+语义链路) */
export function computeL1Hash(word: WordForHashing): string {
  const l1Data = JSON.stringify({
    definition_md: word.definition_md ?? "",
    core_definitions: word.core_definitions ?? [],
    prototype_text: word.prototype_text ?? "",
    morphology: word.metadata?.morphology ?? null,
    mnemonic: word.metadata?.mnemonic ?? null,
    semantic_chain: word.metadata?.semantic_chain ?? null,
  });
  return sha256(l1Data);
}

/** L2 hash = hash(L2 字段：搭配+语料+同义+反义) */
export function computeL2Hash(word: WordForHashing): string {
  const l2Data = JSON.stringify({
    collocations: word.collocations ?? [],
    corpus_items: word.corpus_items ?? [],
    synonym_items: word.synonym_items ?? [],
    antonym_items: word.antonym_items ?? [],
  });
  return sha256(l2Data);
}

/** 全量 hash = hash(L1 + L2)，兼容导入去重 */
export function computeFullHash(word: WordForHashing): string {
  return sha256(computeL1Hash(word) + computeL2Hash(word));
}
