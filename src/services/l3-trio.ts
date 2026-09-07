// src/services/l3-trio.ts
/**
 * L3 三件套输入构造（纯函数，无 IO）。
 *
 * Grill 定案（2026-09-07, CONTEXT.md）：capture-first 无门控——任何词（含 stub）
 * 遇到真实语境即可记录。三件套约定：source/context/occurrence 必须同事务写入，
 * 否则无 occurrence 的 source 从任何词空间都不可达。
 *
 * 偏移不变量：occurrence 偏移相对于 context.text（非全文）；UTF-16 码元，
 * producer/consumer 均为 JS 单运行时（见计划文档坐标空间约定）。
 * MVP 目标词为 ASCII headword；非 BMP 目标词需改为 Array.from 码点定位。
 */

export type L3TrioInput = {
  userId: string;
  wordId: string;
  lemma: string;
  sentence: string;
  sourceTitle?: string;
  sourceUrl?: string;
  obsidianRef?: string;
};

export type L3TrioInputs = {
  source: {
    user_id: string;
    wordbook_id: string | null;
    source_type: string;
    title: string;
    author: string | null;
    url: string | null;
    language: string | null;
    metadata: Record<string, unknown>;
    content_text: string | null;
    content_hash: string | null;
  };
  context: {
    user_id: string;
    source_id: string;
    context_type: string;
    text: string;
    normalized_text: null;
    language: null;
    position: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
  occurrence: {
    user_id: string;
    context_id: string;
    word_id: string;
    surface: string;
    lemma: string | null;
    start_offset: number | null;
    end_offset: number | null;
    confidence: null;
    evidence: Record<string, unknown>;
  };
};

/** 2026-08-22 预埋规则：≤200 字符 = sentence，否则 paragraph。 */
export function CONTEXT_TYPE_BY_LENGTH(text: string): "sentence" | "paragraph" {
  return text.length <= 200 ? "sentence" : "paragraph";
}

export function buildL3TrioInputs(input: L3TrioInput): L3TrioInputs {
  const hasUrl = typeof input.sourceUrl === "string" && input.sourceUrl.trim().length > 0;
  const source = {
    user_id: input.userId,
    wordbook_id: null,
    source_type: hasUrl ? "web" : "manual",
    title: hasUrl ? input.sourceUrl!.trim() : input.sourceTitle?.trim() || "手动记录",
    author: null,
    url: hasUrl ? input.sourceUrl!.trim() : null,
    language: null,
    metadata: input.obsidianRef ? { obsidianRef: input.obsidianRef } : {},
    content_text: null,
    content_hash: null,
  };
  // source_id / context_id 占位：调用方在事务内拿到真实 id 后回填
  const context = {
    user_id: input.userId,
    source_id: "",
    context_type: CONTEXT_TYPE_BY_LENGTH(input.sentence),
    text: input.sentence,
    normalized_text: null,
    language: null,
    position: {},
    metadata: {},
  };
  const lowerText = input.sentence.toLowerCase();
  const idx = lowerText.indexOf(input.lemma.toLowerCase());
  const occurrence = {
    user_id: input.userId,
    context_id: "",
    word_id: input.wordId,
    surface: input.lemma,
    lemma: input.lemma,
    start_offset: idx >= 0 ? idx : null,
    end_offset: idx >= 0 ? idx + input.lemma.length : null,
    confidence: null,
    evidence: {},
  };
  return { source, context, occurrence };
}
