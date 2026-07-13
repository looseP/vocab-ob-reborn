import { describe, expect, it } from "vitest";
import {
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

  it("parses the exact listWords paginated response", () => {
    const response = { items: [summary], total: 1, limit: 20, offset: 0, hasMore: false };
    expect(wordListResponseSchema.parse(response)).toEqual(response);
    expect(() => wordListResponseSchema.parse({ ...response, total: -1 })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, limit: 0 })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, offset: -1 })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, hasMore: "yes" })).toThrow();
    expect(() => wordListResponseSchema.parse({ ...response, items: [{ ...summary, id: 123 }] })).toThrow();
  });
});
