import { describe, expect, it } from "vitest";
import {
  extractSentences,
  isValidInflectionAlias,
  resolveWord,
} from "../../scripts/mine-l3-contexts-2025";

describe("L3 2025 语境抽取逻辑测试 (mine-l3-contexts-2025)", () => {
  describe("extractSentences 分句与锚点偏移精确性", () => {
    it("正确分割多句且字符偏移与原文 slice 完全一致", () => {
      const text =
        "Navigating beyond the pavements of our urban spaces. Desire paths are the unofficial footprints. Urban planners interpret them.";
      const sentences = extractSentences(text);

      expect(sentences).toHaveLength(3);
      for (const s of sentences) {
        expect(text.slice(s.start, s.end)).toBe(s.text);
      }
      expect(sentences[0].text).toBe(
        "Navigating beyond the pavements of our urban spaces."
      );
      expect(sentences[1].text).toBe(
        "Desire paths are the unofficial footprints."
      );
      expect(sentences[2].text).toBe("Urban planners interpret them.");
    });

    it("正确保护 U.S. 等多点缩写，不提前截断句子", () => {
      const text =
        "U.S. customers historically tipped people they assumed were earning income. In the early 2010s, systems changed.";
      const sentences = extractSentences(text);

      expect(sentences).toHaveLength(2);
      expect(sentences[0].text.startsWith("U.S. customers")).toBe(true);
      expect(text.slice(sentences[0].start, sentences[0].end)).toBe(sentences[0].text);
    });

    it("正确过滤过短噪音片段", () => {
      const text = "Yes! Okay! This is a sufficiently long sentence that represents authentic context.";
      const sentences = extractSentences(text);

      expect(sentences).toHaveLength(1);
      expect(sentences[0].text).toBe(
        "This is a sufficiently long sentence that represents authentic context."
      );
    });
  });

  describe("isValidInflectionAlias 别名质量守卫", () => {
    it("放行正规屈折形式", () => {
      expect(isValidInflectionAlias("hospitals", "hospital", "hospital")).toBe(true);
      expect(isValidInflectionAlias("abandoned", "abandon", "abandon")).toBe(true);
      expect(isValidInflectionAlias("reducing", "reduce", "reduce")).toBe(true);
    });

    it("拒绝复合词过度拆解", () => {
      expect(isValidInflectionAlias("one", "one-shot", "one-shot")).toBe(false);
      expect(isValidInflectionAlias("shot", "one-shot", "one-shot")).toBe(false);
    });

    it("拒绝词根倒挂与短词泛化", () => {
      expect(isValidInflectionAlias("person", "personnel", "personnel")).toBe(false);
      expect(isValidInflectionAlias("person", "interpersonal", "interpersonal")).toBe(false);
    });
  });

  describe("resolveWord 词形解析与过滤", () => {
    const exactMap = new Map([
      ["innovative", { id: "1", slug: "innovative", lemma: "innovative", short_definition: "创新的" }],
      ["solution", { id: "2", slug: "solution", lemma: "solution", short_definition: "解决方案" }],
      ["proliferate", { id: "3", slug: "proliferate", lemma: "proliferate", short_definition: "激增" }],
    ]);
    const aliasMap = new Map([
      ["innovatively", { id: "1", slug: "innovative", lemma: "innovative", short_definition: "创新的" }],
      ["solutions", { id: "2", slug: "solution", lemma: "solution", short_definition: "解决方案" }],
    ]);

    it("精确命中基词", () => {
      const hit = resolveWord("innovative", exactMap, aliasMap);
      expect(hit?.slug).toBe("innovative");
    });

    it("别名命中与复数/屈折回退", () => {
      const hitAlias = resolveWord("solutions", exactMap, aliasMap);
      expect(hitAlias?.slug).toBe("solution");

      const hitStem = resolveWord("proliferating", exactMap, aliasMap);
      expect(hitStem?.slug).toBe("proliferate");
    });

    it("超高频虚词拦截（不污染词卡面板）", () => {
      expect(resolveWord("and", exactMap, aliasMap)).toBeNull();
      expect(resolveWord("that", exactMap, aliasMap)).toBeNull();
      expect(resolveWord("as", exactMap, aliasMap)).toBeNull();
      expect(resolveWord("with", exactMap, aliasMap)).toBeNull();
    });
  });
});
