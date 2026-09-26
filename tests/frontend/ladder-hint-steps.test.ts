/**
 * hintSteps 共享模块单元测试（LW-2 提取重构 + 新词编码卡复用）：
 * - 降级链：无例句 → H1′ 语义链顶替；全缺失 → 空数组；
 * - isSpoiler 剧透过滤：原型文本含释义 ≥2 连续汉字串 → H2 步被跳过；
 * - 助记锚核心行提取。
 */

import { describe, expect, it } from "vitest";
import { buildHintSteps, extractMnemonicCore, isSpoiler } from "@/frontend/reviewFlow/hintSteps";
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
