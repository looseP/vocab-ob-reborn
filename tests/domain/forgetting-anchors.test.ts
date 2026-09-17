import { describe, expect, it } from "vitest";
import {
  computeAnchorCandidates,
  extractMorphologyRootTokens,
} from "@/domain/forgetting-anchors";
import type { AnchorProgressRow, AnchorWordMeta } from "@/domain/forgetting-anchors";

const NO_META = new Map<string, AnchorWordMeta>();

function row(
  wordId: string,
  overrides: Partial<Omit<AnchorProgressRow, "wordId">> = {},
): AnchorProgressRow {
  return {
    wordId,
    stability: null,
    retrievability: null,
    state: "review",
    recentRatings: [],
    lapseCount: 0,
    ...overrides,
  };
}

/** 抬高 20% 上限用：可保留（review）但不命中任何规则的填充行。 */
function filler(count: number): AnchorProgressRow[] {
  return Array.from({ length: count }, (_, index) =>
    row(`filler-${index}`, { recentRatings: ["hard"] }),
  );
}

function metaMap(entries: Record<string, AnchorWordMeta>): Map<string, AnchorWordMeta> {
  return new Map(Object.entries(entries));
}

describe("computeAnchorCandidates", () => {
  it("空输入 → 空候选", () => {
    expect(computeAnchorCandidates({ progressRows: [], wordsMeta: NO_META })).toEqual([]);
  });

  describe("R1 稳定锚（stability ≥ 21 天）", () => {
    it("stability 达阈值入选，差一点不入选", () => {
      const rows = [
        row("stable", { stability: 21 }),
        row("borderline", { stability: 20.9 }),
        ...filler(8),
      ];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "stable",
      ]);
    });

    it("learning / relearning 也可保留（只排除 suspended / new）", () => {
      const rows = [
        row("learning-stable", { stability: 30, state: "learning" }),
        row("relearning-stable", { stability: 30, state: "relearning" }),
        ...filler(8),
      ];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "learning-stable",
        "relearning-stable",
      ]);
    });

    it("suspended / new 一律排除（即使 stability 很高）", () => {
      const rows = [
        row("suspended-stable", { stability: 300, state: "suspended" }),
        row("new-stable", { stability: 300, state: "new" }),
        ...filler(10),
      ];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([]);
    });
  });

  describe("R2 鲜活锚（retrievability ≥ 0.9）", () => {
    it("retrievability 达阈值入选，差一点不入选", () => {
      const rows = [
        row("fresh", { retrievability: 0.9 }),
        row("stale", { retrievability: 0.89 }),
        ...filler(8),
      ];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "fresh",
      ]);
    });
  });

  describe("R3 助记锚（mnemonic / semanticChain + 近期全 good/easy）", () => {
    it("有助记且有近期好评入选；近期掉过 again / 无评分 / 无助记不入选", () => {
      const rows = [
        row("mnemonic-good", { recentRatings: ["good", "easy"] }),
        row("chain-good", { recentRatings: ["easy"] }),
        row("mnemonic-again", { recentRatings: ["good", "again"] }),
        row("hook-no-rating", {}),
        row("blank-hook", { recentRatings: ["good"] }),
        row("no-meta", { recentRatings: ["good"] }),
        ...filler(14),
      ];
      const wordsMeta = metaMap({
        "mnemonic-good": { mnemonic: "把 port 想成港口" },
        "chain-good": { semanticChain: "port → portable → transport" },
        "mnemonic-again": { mnemonic: "有助记但近期没稳住" },
        "hook-no-rating": { mnemonic: "有助记但零评分" },
        "blank-hook": { mnemonic: "   " },
      });
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta })).toEqual([
        "mnemonic-good",
        "chain-good",
      ]);
    });
  });

  describe("R4 词根族锚（弱关联版，非传递）", () => {
    it("与已入选锚点共享词根 token 的无直接命中行一并保留", () => {
      const rows = [
        row("port-anchor", { stability: 25 }),
        row("port-family"),
        row("dict-word"),
        ...filler(8),
      ];
      const wordsMeta = metaMap({
        "port-anchor": { morphology: "port" },
        "port-family": { morphology: "port+able" },
        "dict-word": { morphology: "dict" },
      });
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta })).toEqual([
        "port-anchor",
        "port-family",
      ]);
    });

    it("只认与 R1–R3 直接共享词根的行，不顺着链扩整个家族", () => {
      const rows = [
        row("port-anchor", { stability: 25 }),
        row("port-able"),
        row("able-only"),
        ...filler(12),
      ];
      const wordsMeta = metaMap({
        "port-anchor": { morphology: "port" },
        "port-able": { morphology: "port+able" },
        "able-only": { morphology: "able" },
      });
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta })).toEqual([
        "port-anchor",
        "port-able",
      ]);
    });

    it("morphology = EMPTY / 缺失时不产生词根族扩展", () => {
      const rows = [row("anchor", { stability: 25 }), row("empty-root"), ...filler(8)];
      const wordsMeta = metaMap({
        anchor: { morphology: "EMPTY" },
        "empty-root": { morphology: "EMPTY" },
      });
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta })).toEqual(["anchor"]);
    });
  });

  describe("排序与截断", () => {
    it("规则得分优先：稳定 > 鲜活 > 助记", () => {
      const rows = [
        row("hook-only", { recentRatings: ["good"] }),
        row("fresh-only", { retrievability: 0.95 }),
        row("stable-only", { stability: 21 }),
        ...filler(12),
      ];
      const wordsMeta = metaMap({ "hook-only": { mnemonic: "助记" } });
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta })).toEqual([
        "stable-only",
        "fresh-only",
        "hook-only",
      ]);
    });

    it("同分时 lapseCount 少的优先", () => {
      const rows = [
        row("lapse-high", { stability: 30, lapseCount: 4 }),
        row("lapse-low", { stability: 30, lapseCount: 1 }),
        ...filler(8),
      ];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "lapse-low",
        "lapse-high",
      ]);
    });

    it("同分同 lapse 时保持输入顺序", () => {
      const rows = Array.from({ length: 10 }, (_, index) => row(`stable-${index}`, { stability: 30 }));
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "stable-0",
        "stable-1",
      ]);
    });

    it("重复 wordId 只保留首次命中", () => {
      const rows = [row("dup", { stability: 30 }), row("dup", { stability: 30 }), row("other", { stability: 30 }), ...filler(7)];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "dup",
        "other",
      ]);
    });

    it("大书按固定 N 封顶", () => {
      const rows = Array.from({ length: 100 }, (_, index) => row(`stable-${index}`, { stability: 30 }));
      expect(
        computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META, maxAnchors: 3 }),
      ).toEqual(["stable-0", "stable-1", "stable-2"]);
    });

    it("maxAnchors 可配到 1，也可为 0（输出空）", () => {
      const rows = Array.from({ length: 10 }, (_, index) => row(`stable-${index}`, { stability: 30 }));
      expect(
        computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META, maxAnchors: 1 }),
      ).toEqual(["stable-0"]);
      expect(
        computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META, maxAnchors: 0 }),
      ).toEqual([]);
    });

    it("20% 分母只数可保留行（suspended 不抬高上限）", () => {
      const rows = [
        ...Array.from({ length: 4 }, (_, index) => row(`stable-${index}`, { stability: 30 })),
        ...Array.from({ length: 20 }, (_, index) =>
          row(`suspended-${index}`, { stability: 30, state: "suspended" }),
        ),
      ];
      expect(computeAnchorCandidates({ progressRows: rows, wordsMeta: NO_META })).toEqual([
        "stable-0",
      ]);
    });
  });

  it("同输入恒同输出（纯函数、无时间依赖）", () => {
    const rows = [row("stable", { stability: 30 }), row("fresh", { retrievability: 0.95 }), ...filler(8)];
    const input = { progressRows: rows, wordsMeta: NO_META };
    expect(computeAnchorCandidates(input)).toEqual(computeAnchorCandidates(input));
  });
});

describe("extractMorphologyRootTokens", () => {
  it("undefined / 空串 / EMPTY → 无 token", () => {
    expect(extractMorphologyRootTokens(undefined)).toEqual([]);
    expect(extractMorphologyRootTokens("")).toEqual([]);
    expect(extractMorphologyRootTokens("EMPTY")).toEqual([]);
  });

  it("按 + 拆复合词根并小写化", () => {
    expect(extractMorphologyRootTokens("Pre + dict")).toEqual(["pre", "dict"]);
  });

  it("取括号前的首个拉丁字母串", () => {
    expect(extractMorphologyRootTokens("chart (from Latin charta)")).toEqual(["chart"]);
  });

  it("过滤单字符 / 非拉丁 / 带连字符的噪声 token", () => {
    expect(extractMorphologyRootTokens("a + 中文 + 2")).toEqual([]);
    expect(extractMorphologyRootTokens("al-Khwarizmi")).toEqual([]);
  });

  it("重复 token 去重", () => {
    expect(extractMorphologyRootTokens("port+port")).toEqual(["port"]);
  });
});
