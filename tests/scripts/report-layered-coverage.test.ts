import { describe, expect, it } from "vitest";
import {
  assertBaselineNonRegression,
  buildLayeredSummary,
  calculateDiffCoverage,
  classifySourceFile,
  evaluateLayerGate,
  findUnknownSourceDirectories,
  parseChangedSourceLines,
  type IstanbulFileCoverage,
} from "../../scripts/report-layered-coverage";

function fileCoverage(path: string, counts: number[]): IstanbulFileCoverage {
  return {
    path,
    statementMap: Object.fromEntries(
      counts.map((_, index) => [String(index), { start: { line: index + 1, column: 0 }, end: { line: index + 1, column: 1 } }]),
    ),
    s: Object.fromEntries(counts.map((count, index) => [String(index), count])),
    fnMap: {
      "0": { name: "example", decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, line: 1 },
    },
    f: { "0": counts.some((count) => count > 0) ? 1 : 0 },
    branchMap: {
      "0": { line: 1, type: "if", locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }] },
    },
    b: { "0": [counts[0] ?? 0, counts[1] ?? 0] },
  };
}

describe("classifySourceFile", () => {
  it.each([
    ["src/domain/review.ts", "domain"],
    ["src/errors/index.ts", "domain"],
    ["src/services/review.ts", "service"],
    ["src/repositories/review.ts", "repository"],
  ])("maps %s to %s", (file, layer) => {
    expect(classifySourceFile(file)).toBe(layer);
  });

  it("normalizes absolute Windows and Linux paths using the final src segment", () => {
    expect(classifySourceFile("D:\\src\\project\\src\\services\\review.ts")).toBe("service");
    expect(classifySourceFile("/home/src/project/src/repositories/review.ts")).toBe("repository");
  });

  it("rejects files outside the governed core layers", () => {
    expect(() => classifySourceFile("src/http/review.ts")).toThrow(/unclassified/i);
  });
});

describe("source architecture contract", () => {
  it("fails closed for an unclassified top-level source directory", () => {
    expect(findUnknownSourceDirectories(["domain", "services", "use-cases"])).toEqual(["use-cases"]);
  });
});

describe("buildLayeredSummary", () => {
  it("aggregates weighted counters instead of averaging percentages", () => {
    const summary = buildLayeredSummary({
      "src/domain/a.ts": fileCoverage("src/domain/a.ts", [1, 0]),
      "src/domain/b.ts": fileCoverage("src/domain/b.ts", [1, 1, 1, 1, 1, 1, 1, 1]),
      "src/services/a.ts": fileCoverage("src/services/a.ts", [1, 1]),
      "src/repositories/a.ts": fileCoverage("src/repositories/a.ts", [1, 1]),
    });

    expect(summary.layers.domain.statements).toMatchObject({ covered: 9, total: 10, pct: 90 });
    expect(summary.layers.domain.lines).toMatchObject({ covered: 9, total: 10, pct: 90 });
  });

  it("fails empty layers instead of treating no data as 100%", () => {
    const summary = buildLayeredSummary({
      "src/domain/a.ts": fileCoverage("src/domain/a.ts", [1, 1]),
    });
    expect(summary.baselineGates.service.ok).toBe(false);
    expect(summary.targetGates.service.ok).toBe(false);
    expect(summary.layers.service.lines.pct).toBe(0);
  });

  it("keeps each core layer independently visible", () => {
    const summary = buildLayeredSummary({
      "src/domain/a.ts": fileCoverage("src/domain/a.ts", [1, 1]),
      "src/services/a.ts": fileCoverage("src/services/a.ts", [1, 0]),
      "src/repositories/a.ts": fileCoverage("src/repositories/a.ts", [0, 0]),
    });

    expect(summary.layers.domain.statements.pct).toBe(100);
    expect(summary.layers.service.statements.pct).toBe(50);
    expect(summary.layers.repository.statements.pct).toBe(0);
  });
});

describe("diff coverage", () => {
  it("parses executable added core lines and ignores comments and test-only files", () => {
    const changed = parseChangedSourceLines([
      "diff --git a/src/services/a.ts b/src/services/a.ts",
      "+++ b/src/services/a.ts",
      "@@ -1,0 +2,4 @@",
      "+// comment",
      "+const value = 1;",
      "+}",
      "+return value;",
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      "@@ -1,0 +1,1 @@",
      "+expect(true).toBe(true);",
    ].join("\n"));
    expect(changed).toEqual({ "src/services/a.ts": [3, 5] });
  });

  it("skips export interface and interface member declarations as non-executable", () => {
    const changed = parseChangedSourceLines([
      "diff --git a/src/domain/index.ts b/src/domain/index.ts",
      "+++ b/src/domain/index.ts",
      "@@ -55,0 +56,6 @@",
      "+export interface WordDetail extends WordSummary {",
      "+  aliases: string[];",
      "+  definition_md: string;",
      "+  body_md: string;",
      "+  examples: Json;",
      "+}",
      "diff --git a/src/domain/word.entity.ts b/src/domain/word.entity.ts",
      "+++ b/src/domain/word.entity.ts",
      "@@ -19,0 +20,3 @@",
      "+  toDetail(): WordDetail {",
      "+    return { id: this.row.id };",
      "+  }",
    ].join("\n"));
    expect(changed).toEqual({ "src/domain/word.entity.ts": [20, 21] });
  });

  it("requires at least 85 percent of changed executable lines to be covered", () => {
    const statementOnly = fileCoverage("src/services/a.ts", [1, 0]);
    statementOnly.fnMap = {};
    statementOnly.f = {};
    statementOnly.branchMap = {};
    statementOnly.b = {};
    const coverage = { "src/services/a.ts": statementOnly };
    expect(calculateDiffCoverage({ "src/services/a.ts": [1] }, coverage, "base").ok).toBe(true);
    expect(calculateDiffCoverage({ "src/services/a.ts": [1, 2] }, coverage, "base")).toMatchObject({ pct: 50, ok: false });
    expect(calculateDiffCoverage({ "src/services/a.ts": [1, 2, 99] }, coverage, "base")).toMatchObject({
      executableLines: 2,
      coveredLines: 1,
      pct: 50,
      ok: false,
    });
    expect(calculateDiffCoverage({ "src/services/missing.ts": [1] }, coverage, "base")).toMatchObject({
      executableLines: 1,
      coveredLines: 0,
      pct: 0,
      ok: false,
    });

    const nested = fileCoverage("src/services/nested.ts", [1, 1, 0]);
    nested.fnMap["0"].loc.end.line = 3;
    nested.f["0"] = 1;
    expect(calculateDiffCoverage({ "src/services/nested.ts": [3] }, { nested }, "base")).toMatchObject({
      executableLines: 1,
      coveredLines: 0,
      pct: 0,
      ok: false,
    });
    expect(calculateDiffCoverage({}, coverage, "base")).toMatchObject({ pct: null, ok: true });
  });

  it("excludes instrumented-file lines that have no executable coverage range", () => {
    const covered = fileCoverage("src/services/a.ts", [1]);
    covered.b["0"] = [1, 1];
    const coverage = { "src/services/a.ts": covered };

    expect(calculateDiffCoverage(
      { "src/services/a.ts": [1, 99] },
      coverage,
      "base",
    )).toMatchObject({
      executableLines: 1,
      coveredLines: 1,
      pct: 100,
      ok: true,
    });
  });

  it("fails a changed line when any overlapping executable range is untested", () => {
    const partial = fileCoverage("src/services/a.ts", [1]);
    partial.b["0"] = [1, 0];
    partial.f["0"] = 0;

    expect(calculateDiffCoverage(
      { "src/services/a.ts": [1] },
      { "src/services/a.ts": partial },
      "base",
    )).toMatchObject({
      executableLines: 1,
      coveredLines: 0,
      pct: 0,
      ok: false,
    });
  });

  it("covers a changed line only when its statement, function, and every branch arm are hit", () => {
    const complete = fileCoverage("src/services/a.ts", [1]);
    complete.b["0"] = [1, 1];
    complete.f["0"] = 1;

    expect(calculateDiffCoverage(
      { "src/services/a.ts": [1] },
      { "src/services/a.ts": complete },
      "base",
    )).toMatchObject({
      executableLines: 1,
      coveredLines: 1,
      pct: 100,
      ok: true,
    });
  });
});

describe("baseline ratchet", () => {
  const base = {
    domain: { lines: 85, statements: 85, branches: 79 },
    service: { lines: 87, statements: 85, branches: 75 },
    repository: { lines: 90, statements: 86, branches: 75 },
  };

  it("accepts equal or higher thresholds and rejects any decrease", () => {
    expect(() => assertBaselineNonRegression(base, base)).not.toThrow();
    expect(() => assertBaselineNonRegression({
      ...base,
      repository: { ...base.repository, lines: 91 },
    }, base)).not.toThrow();
    expect(() => assertBaselineNonRegression({
      ...base,
      service: { ...base.service, branches: 74 },
    }, base)).toThrow(/service\.branches 74 < 75/);
  });
});

describe("evaluateLayerGate", () => {
  it("requires every layer to meet lines/statements 85 and branches 75", () => {
    const passing = { lines: { covered: 9, total: 10, pct: 90 }, statements: { covered: 9, total: 10, pct: 90 }, functions: { covered: 1, total: 1, pct: 100 }, branches: { covered: 3, total: 4, pct: 75 } };
    expect(evaluateLayerGate(passing).ok).toBe(true);
    expect(evaluateLayerGate({ ...passing, branches: { covered: 2, total: 4, pct: 50 } }).ok).toBe(false);
  });
});
