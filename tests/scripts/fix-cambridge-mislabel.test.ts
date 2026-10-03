/**
 * `scripts/fix-cambridge-mislabel.ts` 的纯逻辑回归锁。
 *
 * 不连库：只测 `planCambridgeFix` / `constructedSource` / `appendNote` 三个纯函数。
 * 之所以值得锁 —— 这个脚本要**改写生产词库的来源标注**，最怕的不是"没改到"，
 * 而是"改错了"：
 *   1. 把已经人工改过的条目又覆盖一遍（覆盖人工判断）
 *   2. 库中命中 Cambridge 的 slug 比清单多（漏改 —— 虚假署名残留）
 *   3. note 追加时把原值覆盖掉（丢产线自检说明）
 *   4. 重复执行时无法识别"已修正"，每次重跑都报改动
 *   5. source 前缀与库内 216 条同类自撰句的既有表述不一致（两套口径）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSTRUCTED_SOURCE_PREFIX,
  EXPECTED_SLUGS,
  NOTE_APPENDIX,
  appendNote,
  constructedSource,
  planCambridgeFix,
  type ExistingRow,
} from "../../scripts/fix-cambridge-mislabel";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUDIT_MANIFEST = path.join(REPO_ROOT, "data", "cambridge-mislabel-audit-2026-10-03.md");

/** 造一条"命中 Cambridge 态"的库行。 */
function cambridgeRow(slug: string, lemma = slug, note: string | null = null): ExistingRow {
  return {
    slug,
    lemma,
    source: `Cambridge Dictionary · ${lemma}`,
    url: `https://dictionary.cambridge.org/dictionary/english/${slug}`,
    note,
  };
}

/** 造一条"已修正"的库行。 */
function fixedRow(slug: string, lemma = slug, note: string | null = null): ExistingRow {
  return { slug, lemma, source: constructedSource(lemma), url: null, note };
}

/** 清单全量行（除指定 slug 外都是 Cambridge 态）。 */
function allRows(overrides: Record<string, ExistingRow> = {}): ExistingRow[] {
  return EXPECTED_SLUGS.map((slug) => overrides[slug] ?? cambridgeRow(slug));
}

describe("constructedSource / appendNote（口径唯一真源）", () => {
  it("source 前缀与库内 216 条同类自撰句一致（「构造参考 · 」）", () => {
    expect(CONSTRUCTED_SOURCE_PREFIX).toBe("构造参考 · ");
    expect(constructedSource("accuse")).toBe("构造参考 · accuse");
  });

  it("note 原值为空 → 直接设为追加语", () => {
    expect(appendNote(null)).toBe(NOTE_APPENDIX);
    expect(appendNote("")).toBe(NOTE_APPENDIX);
    expect(appendNote("   ")).toBe(NOTE_APPENDIX);
  });

  it("note 原值非空 → 用「；」连接，不覆盖原值", () => {
    expect(appendNote("真实语料佐证（试点）")).toBe(`真实语料佐证（试点）；${NOTE_APPENDIX}`);
    // 原值必须完整保留
    expect(appendNote("原文")).toContain("原文");
  });

  it("追加语明确写「自撰」「非词典原文」", () => {
    expect(NOTE_APPENDIX).toContain("自撰");
    expect(NOTE_APPENDIX).toContain("非词典原文");
  });
});

describe("planCambridgeFix（库现状 → 执行计划）", () => {
  it("22 条全 Cambridge 态 → 全部进 fixes", () => {
    const plan = planCambridgeFix(allRows(), [...EXPECTED_SLUGS]);
    expect(plan.fixes).toHaveLength(22);
    expect(plan.alreadyFixed).toHaveLength(0);
    expect(plan.problems).toEqual([]);
    expect(plan.unexpected).toEqual([]);
  });

  it("22 条全已修正 → fixes 为空、alreadyFixed 22（幂等判据）", () => {
    const rows = EXPECTED_SLUGS.map((s) => fixedRow(s));
    const plan = planCambridgeFix(rows, []);
    expect(plan.fixes).toHaveLength(0);
    expect(plan.alreadyFixed).toHaveLength(22);
    expect(plan.problems).toEqual([]);
  });

  it("混合态：已修正的跳过、Cambridge 态的改", () => {
    const plan = planCambridgeFix(
      allRows({ accuse: fixedRow("accuse") }),
      EXPECTED_SLUGS.filter((s) => s !== "accuse"),
    );
    expect(plan.fixes.map((f) => f.slug)).not.toContain("accuse");
    expect(plan.alreadyFixed.map((f) => f.slug)).toEqual(["accuse"]);
    expect(plan.fixes).toHaveLength(21);
  });

  it("source 既非 Cambridge 也非已修正态 → problems（不覆盖人工修改）", () => {
    const plan = planCambridgeFix(
      allRows({ accuse: { ...cambridgeRow("accuse"), source: "人工改过的来源" } }),
      EXPECTED_SLUGS.filter((s) => s !== "accuse"),
    );
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain("accuse");
    expect(plan.problems[0]).toContain("人工修改");
  });

  it("slug 在库中不存在 → problems", () => {
    const rows = allRows().filter((r) => r.slug !== "accuse");
    const plan = planCambridgeFix(rows, EXPECTED_SLUGS.filter((s) => s !== "accuse"));
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain("accuse");
    expect(plan.problems[0]).toContain("不存在");
  });

  it("库中命中 Cambridge 但不在清单 → unexpected（防漏改）", () => {
    const plan = planCambridgeFix(allRows(), [...EXPECTED_SLUGS, "some-new-word"]);
    expect(plan.unexpected).toEqual(["some-new-word"]);
  });

  it("计划里带上改前 url（供 dry-run 打印与人工复核）", () => {
    const plan = planCambridgeFix(allRows(), [...EXPECTED_SLUGS]);
    const accuse = plan.fixes.find((f) => f.slug === "accuse");
    expect(accuse?.currentUrl).toBe(
      "https://dictionary.cambridge.org/dictionary/english/accuse",
    );
    expect(accuse?.nextSource).toBe("构造参考 · accuse");
    expect(accuse?.nextNote).toBe(NOTE_APPENDIX);
  });

  it("note 原值在计划里被保留（改后是「原值；追加语」）", () => {
    const plan = planCambridgeFix(
      allRows({ accuse: cambridgeRow("accuse", "accuse", "原备注") }),
      EXPECTED_SLUGS,
    );
    const accuse = plan.fixes.find((f) => f.slug === "accuse");
    expect(accuse?.nextNote).toBe(`原备注；${NOTE_APPENDIX}`);
  });
});

describe("清单与审计文档的一致性", () => {
  it("EXPECTED_SLUGS 恰好 22 条且无重复", () => {
    expect(EXPECTED_SLUGS).toHaveLength(22);
    expect(new Set(EXPECTED_SLUGS).size).toBe(22);
  });

  it("审计文档 data/cambridge-mislabel-audit-2026-10-03.md 列出了全部 22 个 slug", () => {
    const doc = readFileSync(AUDIT_MANIFEST, "utf8");
    for (const slug of EXPECTED_SLUGS) {
      expect(doc, `审计文档缺少 ${slug}`).toContain(slug);
    }
  });

  it("审计文档含抓取证据（Cambridge 实际例句对照）与抓取日期", () => {
    const doc = readFileSync(AUDIT_MANIFEST, "utf8");
    expect(doc).toContain("2026-10-03");
    // 抽样抓取的六个词
    for (const slug of ["accuse", "biophilia", "characterise", "accessibility", "adequate", "ambiguous"]) {
      expect(doc).toContain(slug);
    }
    // Cambridge 实际例句的原文片段（对照证据）
    expect(doc).toContain("He's been accused of robbery/murder.");
    expect(doc).toContain("Bright colours and bold strokes characterize his early paintings.");
  });

  it("审计文档写明 source_type 不在本次修正范围", () => {
    const doc = readFileSync(AUDIT_MANIFEST, "utf8");
    expect(doc).toContain("source_type");
    expect(doc).toContain("不动");
  });
});
