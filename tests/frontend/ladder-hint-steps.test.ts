/**
 * hintSteps 共享模块单元测试（LW-2 提取重构 + 新词编码卡复用）：
 * - 降级链：无例句 → H1″ 语义链顶替；全缺失 → 空数组；
 * - H1′ 真题语境（FR-12 接线1）：顺序、遮盖锚定位、定位不到即整级不生成；
 * - isSpoiler 剧透过滤：原型文本含释义 ≥2 连续汉字串 → H2 步被跳过；
 * - 助记锚核心行提取。
 */

import { describe, expect, it } from "vitest";
import { buildHintSteps, extractMnemonicCore, isSpoiler, locateMaskTerm } from "@/frontend/reviewFlow/hintSteps";
import type { ReviewCard } from "@/frontend/hooks/useReview";

function makeWord(overrides: Partial<ReviewCard["word"]> = {}): ReviewCard["word"] {
  return {
    id: "w1",
    slug: "slug",
    title: "Abound",
    lemma: "abound",
    short_definition: "大量存在",
    ipa: null,
    pos: null,
    cefr: null,
    ...overrides,
  };
}

describe("buildHintSteps（降级链）", () => {
  it("有例句 → H1；无例句有语义链 → H1′ 顶替", () => {
    const withExample = buildHintSteps(makeWord({ examples: [{ text: "Fish abound in the lake.", translation: "湖里鱼很多" }] }));
    expect(withExample[0]?.kind).toBe("example");

    const withChain = buildHintSteps(makeWord({ examples: [], semantic_chain: "abound->abundant->丰富" }));
    expect(withChain[0]?.kind).toBe("chain");
  });

  it("全缺失 → 空数组（编码卡显示「暂无提示素材」）", () => {
    expect(buildHintSteps(makeWord())).toEqual([]);
  });

  it("isSpoiler：原型文本含释义中文串 → H2 步被跳过（编码卡与卡面同口径）", () => {
    const steps = buildHintSteps(makeWord({
      examples: [{ text: "Wild animals abound here." }],
      prototype_text: "数量**大量存在**的画面",
    }));
    expect(steps.some((s) => s.kind === "prototype")).toBe(false);
  });

  it("H3 助记锚：非锚段核心行入选", () => {
    const steps = buildHintSteps(makeWord({
      mnemonic_text: "a(一)+bound(边界)——多到冲破边界\n**词源锚**：ab- + und",
    }));
    const mnemonic = steps.find((s) => s.kind === "mnemonic");
    expect(mnemonic?.kind).toBe("mnemonic");
    expect((mnemonic as { text: string }).text).toContain("冲破边界");
  });
});

describe("H1′ 真题语境（FR-12 接线1，2026-10-04）", () => {
  const CONTEXT = {
    context_id: "c1",
    source_title: "2025 英语二 · Part B",
    text: "〖45〗 When pitching a new idea, use the language of abundance.",
  };

  it("有语境且 surface 可定位 → 插在 H1 与 H2 之间，遮盖锚用 surface", () => {
    const steps = buildHintSteps(
      makeWord({ examples: [{ text: "Fish abound in the lake." }], prototype_text: "数量多的画面" }),
      [{ ...CONTEXT, surface: "abundance" }],
    );
    expect(steps.map((s) => s.kind)).toEqual(["example", "l3_context", "prototype"]);
    const rung = steps[1];
    expect(rung.kind).toBe("l3_context");
    expect((rung as { items: Array<{ maskTerm: string }> }).items[0].maskTerm).toBe("abundance");
  });

  it("surface 缺失 → 回退 lemma 整词定位", () => {
    const steps = buildHintSteps(
      makeWord({ examples: [], lemma: "abundance" }),
      [{ ...CONTEXT, surface: null }],
    );
    expect(steps[0]?.kind).toBe("l3_context");
    expect((steps[0] as { items: Array<{ maskTerm: string }> }).items[0].maskTerm).toBe("abundance");
  });

  it("surface 与 lemma 都定位不到 → 整级不生成（fail-closed，绝不露未遮盖的句子）", () => {
    const steps = buildHintSteps(
      makeWord({ examples: [], lemma: "incentive", prototype_text: "一份激励的画面" }),
      [{ ...CONTEXT, surface: null }],
    );
    // 无例句 → 本就无 H1；语境级也不该出现，直接落到 H2
    expect(steps.map((s) => s.kind)).toEqual(["prototype"]);
  });

  it("lemma 只认整词：`able` 不误遮 `available`", () => {
    const steps = buildHintSteps(
      makeWord({ examples: [], lemma: "able" }),
      [{ context_id: "c9", source_title: "x", text: "Tickets are available now.", surface: null }],
    );
    expect(steps).toEqual([]);
  });

  it("不传语境 / 空数组 → 阶梯与既有一致（零影响）", () => {
    const word = makeWord({ examples: [{ text: "Fish abound in the lake." }] });
    expect(buildHintSteps(word)).toEqual(buildHintSteps(word, []));
    expect(buildHintSteps(word, null)).toEqual(buildHintSteps(word, undefined));
  });

  it("多条语境全量保留（服务端 limit 2），空文本条目跳过", () => {
    const steps = buildHintSteps(makeWord({ examples: [] }), [
      { ...CONTEXT, context_id: "c1", surface: "abundance" },
      { context_id: "c2", source_title: "hand", text: "   ", surface: "abundance" },
      { context_id: "c3", source_title: "another", text: "More abundance here.", surface: "abundance" },
    ]);
    const rung = steps.find((s) => s.kind === "l3_context") as { items: Array<{ contextId: string }> };
    expect(rung.items.map((i) => i.contextId)).toEqual(["c1", "c3"]);
  });
});

describe("locateMaskTerm（遮盖锚定位）", () => {
  it("surface 走子串（大小写不敏感）——它由 occurrence 抽取，构造上必在句中", () => {
    expect(locateMaskTerm("use the language of Abundance.", "abundance", "abundant")).toBe("abundance");
  });

  it("surface 定位不到就回退 lemma 整词", () => {
    expect(locateMaskTerm("Wild animals abound here.", "abundance", "abound")).toBe("abound");
  });

  it("两者都定位不到 → null", () => {
    expect(locateMaskTerm("Nothing matches here.", "abundance", "abound")).toBeNull();
    expect(locateMaskTerm("Nothing matches here.", null, null)).toBeNull();
    expect(locateMaskTerm("Nothing matches here.", "  ", "  ")).toBeNull();
  });

  it("lemma 的非整词命中不算（`able` ∈ `available`）", () => {
    expect(locateMaskTerm("Tickets are available now.", null, "able")).toBeNull();
  });
});

describe("isSpoiler / extractMnemonicCore（纯函数口径）", () => {
  it("isSpoiler 命中与非命中", () => {
    expect(isSpoiler("数量大量存在的画面", "大量存在")).toBe(true);
    expect(isSpoiler("a picture of plenty", "大量存在")).toBe(false);
    expect(isSpoiler("anything", null)).toBe(false);
  });

  it("extractMnemonicCore：核心行入选、纯锚段返回 null", () => {
    expect(extractMnemonicCore("- text: 核心\n**词源锚**：xx")).toBe("核心");
    expect(extractMnemonicCore("**词源锚**：xx\n**画面锚**：yy")).toBeNull();
    expect(extractMnemonicCore(null)).toBeNull();
  });
});
