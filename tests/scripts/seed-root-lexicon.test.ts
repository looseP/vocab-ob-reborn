import { describe, expect, it } from "vitest";
import { ROOT_LEXICON_SEED, validateRootLexiconSeed } from "../../scripts/seed-root-lexicon";

describe("root_lexicon 种子数据（0052 / P1-C）", () => {
  it("正式种子数据通过全部自检", () => {
    expect(validateRootLexiconSeed(ROOT_LEXICON_SEED)).toEqual([]);
  });

  it("首批规模与 token 形态符合约定（小写拉丁、与 extractRootTokens 同口径）", () => {
    expect(ROOT_LEXICON_SEED.length).toBeGreaterThanOrEqual(30);
    for (const entry of ROOT_LEXICON_SEED) {
      expect(entry.token).toMatch(/^[a-z]{2,}$/);
      expect(entry.meaningZh.trim().length).toBeGreaterThan(0);
      for (const variant of entry.variants) {
        expect(variant).toMatch(/^[a-z]{2,}$/);
        expect(variant).not.toBe(entry.token);
      }
    }
  });

  it("拦截非法 token / 自引用变体 / 重复 token / 空核心义", () => {
    expect(validateRootLexiconSeed([{ token: "A1", meaningZh: "x", variants: [] }])).toContainEqual(
      expect.stringContaining("token 非法"),
    );
    expect(
      validateRootLexiconSeed([{ token: "port", meaningZh: "携带", variants: ["port"] }]),
    ).toContainEqual(expect.stringContaining("变体不得是自身"));
    expect(
      validateRootLexiconSeed([
        { token: "port", meaningZh: "携带", variants: [] },
        { token: "port", meaningZh: "搬运", variants: [] },
      ]),
    ).toContainEqual(expect.stringContaining("token 重复"));
    expect(
      validateRootLexiconSeed([{ token: "port", meaningZh: "   ", variants: [] }]),
    ).toContainEqual(expect.stringContaining("核心义为空"));
  });

  it("变体不得包含大写或非字母（与词库提取口径一致）", () => {
    expect(
      validateRootLexiconSeed([{ token: "port", meaningZh: "携带", variants: ["Port"] }]),
    ).toContainEqual(expect.stringContaining("变体非法"));
  });
});
