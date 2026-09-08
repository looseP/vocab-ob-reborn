import { describe, expect, it } from "vitest";
import {
  wordDeleteResponseSchema,
  wordDetailResponseSchema,
  wordListResponseSchema,
  wordSummaryResponseSchema,
} from "../../src/http/words-response-contract";

const summary = {
  id: "word-1",
  slug: "abound",
  title: "abound",
  lemma: "abound",
  pos: "verb",
  cefr: "B2",
  ipa: null,
  short_definition: "to exist in large numbers",
  metadata: { word_freq: "C1", semantic_field: "quantity" },
};

describe("Words response contracts", () => {
  it("parses the exact WordSummary row", () => {
    expect(wordSummaryResponseSchema.parse(summary)).toEqual(summary);
    expect(() => wordSummaryResponseSchema.parse({ ...summary, pos: 123 })).toThrow();
    expect(() => wordSummaryResponseSchema.parse({ ...summary, extra: true })).toThrow();
    const { id: _id, ...missing } = summary;
    expect(() => wordSummaryResponseSchema.parse(missing)).toThrow();
  });

  it("parses the exact WordDetail response without internal lifecycle fields", () => {
    const detail = {
      ...summary,
      aliases: ["abounds", "abounded"],
      definition_md: "To exist in large numbers.",
      body_md: "# abound",
      prototype_text: null,
      core_definitions: [{ sense: "大量存在", en: null, priority: 1, tags: [] }],
      examples: [{ text: "Fish abound in the lake." }],
      l2_content: {
        collocations: [
          {
            phrase: "abound in/with",
            gloss: "充满",
            tone: "neutral" as const,
            example: "The region abounds in coal.",
            exampleTranslation: "该地区盛产煤炭。",
            provenance: { source: "dictionary", dictionaryName: "Datamuse" },
          },
        ],
        corpus_items: [],
        synonym_items: [],
        antonym_items: [],
      },
      l2_promoted: true,
    };

    const parsed = wordDetailResponseSchema.parse(detail);
    expect(parsed).toEqual(detail);
    // v1 溯源字段（provenance/evidence）必须 passthrough 保留
    expect((parsed.l2_content.collocations[0] as { provenance?: unknown }).provenance).toEqual({
      source: "dictionary",
      dictionaryName: "Datamuse",
    });
    expect(() => wordDetailResponseSchema.parse({ ...detail, aliases: [123] })).toThrow();
    expect(() => wordDetailResponseSchema.parse({ ...detail, row: detail })).toThrow();
    expect(() => wordDetailResponseSchema.parse({ ...detail, content_hash: "secret" })).toThrow();
    const { examples: _examples, ...missing } = detail;
    expect(() => wordDetailResponseSchema.parse(missing)).toThrow();
  });

  it("requires l2_content on WordDetail and validates item shapes", () => {
    const base = {
      ...summary,
      aliases: [],
      definition_md: "x",
      body_md: "y",
      prototype_text: null,
      examples: [],
      l2_content: { collocations: [], corpus_items: [], synonym_items: [], antonym_items: [] },
      l2_promoted: false,
    };
    // 缺少 l2_content → 400 语义（契约拒绝）
    expect(() => wordDetailResponseSchema.parse({ ...base, l2_content: undefined })).toThrow();
    // 缺少 l2_promoted → 契约拒绝
    expect(() => wordDetailResponseSchema.parse({ ...base, l2_promoted: undefined })).toThrow();
    // 搭配条目缺必填字段（phrase）→ 拒绝
    expect(() =>
      wordDetailResponseSchema.parse({
        ...base,
        l2_content: { collocations: [{ gloss: "缺 phrase" }], corpus_items: [], synonym_items: [], antonym_items: [] },
      }),
    ).toThrow();
    // 辨析条目 tone 非法 → 拒绝
    expect(() =>
      wordDetailResponseSchema.parse({
        ...base,
        l2_content: {
          collocations: [],
          corpus_items: [],
          synonym_items: [{ word: "teem", semanticDiff: "d", tone: "loud", usage: "u", delta: "δ", object: "o" }],
          antonym_items: [],
        },
      }),
    ).toThrow();
  });

  it("parses the exact listWords paginated response", () => {
    const response = { items: [summary], total: 1, limit: 20, offset: 0, hasMore: false };
    expect(wordListResponseSchema.parse(response)).toEqual(response);
    expect(() => wordListResponseSchema.parse({ ...response, total: -1 })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, limit: 0 })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, offset: -1 })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, hasMore: "yes" })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, items: [{ ...summary, id: 123 }] })).toThrow();
  });

  // 0023 stub 生命周期：删除结果与 L3 删除同形，entityType 联合含 "word"
  it("parses the wordDelete response reusing the L3 delete shape", () => {
    const response = { deleted: { entityType: "word", id: "word-1" }, activeReadInvalidation: true };
    expect(wordDeleteResponseSchema.parse(response)).toEqual(response);
    expect(() => wordDeleteResponseSchema.parse({ ...response, deleted: { entityType: "galaxy", id: "x" } })).toThrow();
    expect(() => wordDeleteResponseSchema.parse({ ...response, activeReadInvalidation: false })).toThrow();
    expect(() => wordDeleteResponseSchema.parse({ deleted: { entityType: "word" }, activeReadInvalidation: true })).toThrow();
  });
});

