/**
 * `real_usage`（真实语料佐证）契约解析测试 —— **署名义务的渲染前提**。
 *
 * 这些句子是 Tatoeba 真实语料，其中 79 条标 CC BY 2.0 FR：许可证 §4.2 要求
 * 再分发时给出原作者姓名与许可 URI。所以解析层最关键的性质不是"能读出正常数据"，
 * 而是**降级方向必须是"少显示"而不是"假装已署名"**：
 *
 * - 缺 author：句子与出处照常显示，author 为 null → 前端显式标"作者待补"
 *   （**不能**把整条丢掉 —— 那会从"署名不全"退化成"完全不署名"）
 * - 缺 text：丢该条（没有句子的佐证无意义）
 * - real_usage 类型错误 / verified 缺失：返回空数组，前端整块不渲染
 * - 许可与 URL 缺失：只丢对应字段，不影响其它字段
 *
 * 与 `word-exam.test.ts` 同源纪律：`words.examples` 是 jsonb，形状不受类型系统保护。
 */
import { describe, expect, it } from "vitest";
import { parseRealUsage, parseRealUsageFromExample } from "@/domain/word-exam";

/** 真实形状样本（取自库里 meteorological 一条，字段未改动）。 */
const REAL_CC_BY = {
  url: "https://tatoeba.org/en/sentences/show/12673299",
  note: "真实语料佐证（自用学习，署名 Tatoeba CC BY 2.0 FR）；主句为教学构造句，exam 三层基于主句",
  text: "The meteorological conditions have worsened.",
  source: "Tatoeba 真实语料（CC BY 2.0 FR）",
  license: "CC BY 2.0 FR",
  source_type: "tatoeba",
  author: "anzart",
  has_official_zh: false,
};

/** 真实形状样本（取自库里 rid 一条；CC0 是公有领域奉献，无署名义务）。 */
const REAL_CC0 = {
  url: "https://tatoeba.org/en/sentences/show/10143796",
  note: "真实语料佐证（自用学习，署名 Tatoeba CC BY 2.0 FR）；主句为教学构造句，exam 三层基于主句",
  text: "Get rid of it.",
  source: "Tatoeba 真实语料（CC0 1.0）",
  license: "CC0 1.0",
  source_type: "tatoeba",
  author: "ddnktr",
  has_official_zh: false,
};

describe("parseRealUsage（真实语料佐证解析）", () => {
  it("CC BY 2.0 FR 一条：作者/许可/链接全部解析出来", () => {
    expect(parseRealUsage([REAL_CC_BY])).toEqual([
      {
        text: "The meteorological conditions have worsened.",
        author: "anzart",
        license: "CC BY 2.0 FR",
        url: "https://tatoeba.org/en/sentences/show/12673299",
        sourceType: "tatoeba",
        source: "Tatoeba 真实语料（CC BY 2.0 FR）",
        hasOfficialZh: false,
      },
    ]);
  });

  it("CC0 1.0 一条：同样解析出出处（公有领域无署名义务，但仍给出处）", () => {
    const [entry] = parseRealUsage([REAL_CC0]);
    expect(entry?.license).toBe("CC0 1.0");
    expect(entry?.author).toBe("ddnktr");
    expect(entry?.text).toBe("Get rid of it.");
  });

  it("author 缺失 → 该条仍在，author 为 null（不丢整条）", () => {
    const { author: _omitted, ...withoutAuthor } = REAL_CC_BY;
    const parsed = parseRealUsage([withoutAuthor]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.author).toBeNull();
    expect(parsed[0]?.text).toBe("The meteorological conditions have worsened.");
    // 许可与链接必须还在 —— 署名不全不代表出处可以不写。
    expect(parsed[0]?.license).toBe("CC BY 2.0 FR");
    expect(parsed[0]?.url).toBe("https://tatoeba.org/en/sentences/show/12673299");
  });

  it("author 为空串/空白串 → 归 null（不渲染空署名）", () => {
    expect(parseRealUsage([{ ...REAL_CC_BY, author: "" }])[0]?.author).toBeNull();
    expect(parseRealUsage([{ ...REAL_CC_BY, author: "   " }])[0]?.author).toBeNull();
  });

  it.each([
    ["real_usage 类型错误（对象）", {}],
    ["real_usage 类型错误（字符串）", "nope"],
    ["real_usage 为 null", null],
    ["real_usage 为 undefined", undefined],
    ["real_usage 为数字", 42],
  ])("%s → 空数组，不抛错（前端据此整块不渲染）", (_label, raw) => {
    expect(parseRealUsage(raw)).toEqual([]);
  });

  it("数组里的非对象元素被跳过，其余条目照常解析", () => {
    const parsed = parseRealUsage(["nope", 42, null, REAL_CC_BY]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.author).toBe("anzart");
  });

  it("缺 text → 丢该条（没有句子的佐证无意义）", () => {
    const { text: _omitted, ...withoutText } = REAL_CC_BY;
    expect(parseRealUsage([withoutText])).toEqual([]);
    expect(parseRealUsage([{ ...REAL_CC_BY, text: "  " }])).toEqual([]);
  });

  it("缺 license / url / source / source_type → 各归 null，互不牵连", () => {
    const parsed = parseRealUsage([
      { text: "A sentence.", author: "someone" },
    ]);
    expect(parsed[0]).toEqual({
      text: "A sentence.",
      author: "someone",
      license: null,
      url: null,
      sourceType: null,
      source: null,
      hasOfficialZh: false,
    });
  });

  it("has_official_zh 非布尔 → false（不做真值转换）", () => {
    expect(parseRealUsage([{ ...REAL_CC_BY, has_official_zh: "true" }])[0]?.hasOfficialZh).toBe(false);
    expect(parseRealUsage([{ ...REAL_CC_BY, has_official_zh: 1 }])[0]?.hasOfficialZh).toBe(false);
    expect(parseRealUsage([{ ...REAL_CC_BY, has_official_zh: true }])[0]?.hasOfficialZh).toBe(true);
  });

  it("多条佐证按序全部解析", () => {
    const parsed = parseRealUsage([REAL_CC_BY, REAL_CC0]);
    expect(parsed.map((p) => p.license)).toEqual(["CC BY 2.0 FR", "CC0 1.0"]);
  });
});

describe("parseRealUsageFromExample（从 examples[i] 取佐证）", () => {
  it("正常形状：从 verified.real_usage 取到", () => {
    expect(parseRealUsageFromExample({ verified: { real_usage: [REAL_CC_BY] } })).toHaveLength(1);
  });

  it.each([
    ["example 非对象", "nope"],
    ["example 为 null", null],
    ["无 verified", { text: "t" }],
    ["verified 非对象", { verified: "nope" }],
    ["verified 为 null", { verified: null }],
    ["real_usage 缺失", { verified: {} }],
    ["real_usage 类型错误", { verified: { real_usage: "nope" } }],
  ])("%s → 空数组，不抛错", (_label, example) => {
    expect(parseRealUsageFromExample(example)).toEqual([]);
  });
});
