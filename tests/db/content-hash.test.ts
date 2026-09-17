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

// R1（ADR-0017 / 0027）：refresh_l2_cache 为缓存条目保留 direction 键。
// 这些用例把"方向编码 = L2 内容身份；L1 轨不受其影响"锁死。
describe("computeL2Hash · direction 编码（ADR-0017）", () => {
  const tagged = {
    ...SAMPLE_WORD,
    collocations: [{ phrase: "abundant evidence", gloss: "充分证据", direction: "通用" }],
  };

  it("treats the per-item direction key as L2 content identity", () => {
    // 同一字段断出现 direction 键（形状迁移）→ L2 hash 变化：这是缓存的真实
    // 字节变化，hash 必须跟随（0027 后每个 active 条目都会带该键）。
    expect(computeL2Hash(tagged as any)).not.toBe(computeL2Hash(SAMPLE_WORD as any));
  });

  it("is byte-stable for identical cache bytes (repeat refresh → same hash)", () => {
    // 同一形状重复计算稳定 = 重复 refresh/finalize 不会产生重复 recheck。
    expect(computeL2Hash(tagged as any)).toBe(computeL2Hash(tagged as any));
    const directionOnly = {
      ...SAMPLE_WORD,
      collocations: [{ phrase: "abundant evidence", gloss: "充分证据", direction: "考研" }],
    };
    // 变体不同（通用 vs 考研）身份不同 → hash 不同（方向是内容语义）。
    expect(computeL2Hash(directionOnly as any)).not.toBe(computeL2Hash(tagged as any));
  });

  it("does NOT leak item direction into the L1 hash (dual-track isolation)", () => {
    // ADR-0002 红线：L2 缓存形状变化（含 direction 键）不得触碰 L1 hash。
    expect(computeL1Hash(tagged as any)).toBe(computeL1Hash(SAMPLE_WORD as any));
    expect(computeFullHash(tagged as any)).not.toBe(computeFullHash(SAMPLE_WORD as any));
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
