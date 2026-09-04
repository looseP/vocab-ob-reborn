import { describe, it, expect } from "vitest";
import { computeL1Hash, computeL2Hash, computeFullHash } from "@/db/content-hash";

const SAMPLE_WORD = {
  definition_md: "**adj.** ①==大量存在==",
  core_definitions: [{ partOfSpeech: "adj.", senses: [{ def: "大量存在" }] }],
  prototype_text: "水从容器中溢出",
  metadata: {
    morphology: { parts: [{ kind: "root", text: "und", gloss: "波浪" }], raw: "", narrative: "词源叙事" },
    mnemonic: { etymology: "叙事化词源", breakdown: "词拆分" },
    semantic_chain: { oneWord: "溢", centerExtension: "延伸", chain: ["溢出", "大量"] },
  },
  collocations: [{ phrase: "abundant evidence", gloss: "充分证据" }],
  corpus_items: [{ text: "abundant rainfall", translation: "充沛降雨" }],
  synonym_items: [{ word: "plentiful", semanticDiff: "语感差异" }],
  antonym_items: [{ word: "scarce", note: "反义" }],
};

describe("computeL1Hash", () => {
  it("returns 64-char hex string", () => {
    const hash = computeL1Hash(SAMPLE_WORD as any);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same input same hash)", () => {
    expect(computeL1Hash(SAMPLE_WORD as any)).toBe(computeL1Hash(SAMPLE_WORD as any));
  });

  it("changes when L1 content changes", () => {
    const modified = { ...SAMPLE_WORD, definition_md: "**adj.** ①==稀少==" } as any;
    expect(computeL1Hash(modified)).not.toBe(computeL1Hash(SAMPLE_WORD as any));
  });

  it("does NOT change when L2 content changes", () => {
    const modified = { ...SAMPLE_WORD, collocations: [{ phrase: "different", gloss: "x" }] } as any;
    expect(computeL1Hash(modified)).toBe(computeL1Hash(SAMPLE_WORD as any));
  });
});

describe("computeL2Hash", () => {
  it("returns 64-char hex string", () => {
    expect(computeL2Hash(SAMPLE_WORD as any)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT change when L1 content changes", () => {
    const modified = { ...SAMPLE_WORD, definition_md: "different" } as any;
    expect(computeL2Hash(modified)).toBe(computeL2Hash(SAMPLE_WORD as any));
  });

  it("changes when L2 content changes", () => {
    const modified = { ...SAMPLE_WORD, collocations: [] } as any;
    expect(computeL2Hash(modified)).not.toBe(computeL2Hash(SAMPLE_WORD as any));
  });
});

describe("computeFullHash", () => {
  it("returns 64-char hex string", () => {
    expect(computeFullHash(SAMPLE_WORD as any)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when either L1 or L2 changes", () => {
    const l1Modified = { ...SAMPLE_WORD, definition_md: "different" } as any;
    const l2Modified = { ...SAMPLE_WORD, collocations: [] } as any;
    expect(computeFullHash(l1Modified)).not.toBe(computeFullHash(SAMPLE_WORD as any));
    expect(computeFullHash(l2Modified)).not.toBe(computeFullHash(SAMPLE_WORD as any));
  });
});
