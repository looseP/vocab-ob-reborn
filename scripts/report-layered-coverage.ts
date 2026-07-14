import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CoreLayer = "domain" | "service" | "repository";
type MetricName = "lines" | "statements" | "functions" | "branches";
type CoverageThresholds = Record<CoreLayer, { lines: number; statements: number; branches: number }>;

interface Location {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, Location>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; decl: Location; loc: Location; line: number }>;
  f: Record<string, number>;
  branchMap: Record<string, { line: number; type: string; locations: Location[] }>;
  b: Record<string, number[]>;
}

interface Metric {
  covered: number;
  total: number;
  pct: number;
}

export type LayerMetrics = Record<MetricName, Metric>;

interface LayerGate {
  ok: boolean;
  failures: string[];
}

interface DiffCoverage {
  baseRef: string;
  executableLines: number;
  coveredLines: number;
  pct: number | null;
  ok: boolean;
}

interface TestEvidence {
  category: "http-contract" | "db-integration" | "script-workflow" | "e2e-journey";
  files: string[];
  count: number;
  evidenceKind: "test-reference";
  enforcedBy: string;
  executionScope: "unit-job" | "database-job" | "e2e-job";
}

export interface LayeredCoverageSummary {
  generatedAt: string;
  targetThresholds: { lines: number; statements: number; branches: number };
  baselineThresholds: Record<CoreLayer, { lines: number; statements: number; branches: number }>;
  layers: Record<CoreLayer, LayerMetrics>;
  baselineGates: Record<CoreLayer, LayerGate>;
  targetGates: Record<CoreLayer, LayerGate>;
  evidence: TestEvidence[];
  diffCoverage: DiffCoverage;
  baselineOk: boolean;
  targetOk: boolean;
}

const TARGET_THRESHOLDS = { lines: 85, statements: 85, branches: 75 } as const;
const BOOTSTRAP_BASELINE: CoverageThresholds = {
  domain: { lines: 85, statements: 85, branches: 79 },
  service: { lines: 87, statements: 85, branches: 75 },
  repository: { lines: 90, statements: 86, branches: 75 },
};
const KNOWN_SOURCE_DIRECTORIES = new Set([
  "config", "db", "dictionary", "domain", "errors", "frontend", "fsrs", "http",
  "l3", "llm", "observability", "outbox", "repositories", "schemas", "services",
]);
const EMPTY_COUNTERS = (): Record<MetricName, { covered: number; total: number }> => ({
  lines: { covered: 0, total: 0 },
  statements: { covered: 0, total: 0 },
  functions: { covered: 0, total: 0 },
  branches: { covered: 0, total: 0 },
});

function normalizePath(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const srcIndex = normalized.lastIndexOf("/src/");
  return srcIndex >= 0 ? normalized.slice(srcIndex + 1) : normalized.replace(/^src\//, "src/");
}

export function classifySourceFile(file: string): CoreLayer {
  const normalized = normalizePath(file);
  if (/^src\/(domain|errors)\//.test(normalized)) return "domain";
  if (/^src\/services\//.test(normalized)) return "service";
  if (/^src\/repositories\//.test(normalized)) return "repository";
  throw new Error(`Unclassified governed source file: ${normalized}`);
}

function pct(covered: number, total: number): number {
  return total === 0 ? 0 : Number(((covered / total) * 100).toFixed(2));
}

function countersForFile(file: IstanbulFileCoverage): Record<MetricName, { covered: number; total: number }> {
  const statementHits = Object.values(file.s);
  const functionHits = Object.values(file.f);
  const branchHits = Object.values(file.b).flat();
  const lineHits = new Map<number, number>();
  for (const [id, location] of Object.entries(file.statementMap)) {
    const hit = file.s[id] ?? 0;
    lineHits.set(location.start.line, Math.max(lineHits.get(location.start.line) ?? 0, hit));
  }
  return {
    statements: { covered: statementHits.filter((hit) => hit > 0).length, total: statementHits.length },
    functions: { covered: functionHits.filter((hit) => hit > 0).length, total: functionHits.length },
    branches: { covered: branchHits.filter((hit) => hit > 0).length, total: branchHits.length },
    lines: { covered: [...lineHits.values()].filter((hit) => hit > 0).length, total: lineHits.size },
  };
}

export function evaluateLayerGate(
  metrics: LayerMetrics,
  thresholds: { lines: number; statements: number; branches: number } = TARGET_THRESHOLDS,
): LayerGate {
  const failures: string[] = [];
  for (const metric of ["lines", "statements", "branches"] as const) {
    if (metrics[metric].pct < thresholds[metric]) {
      failures.push(`${metric} ${metrics[metric].pct}% < ${thresholds[metric]}%`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function calculateDiffCoverage(
  changedLines: Record<string, number[]>,
  coverage: Record<string, IstanbulFileCoverage>,
  baseRef: string,
): DiffCoverage {
  const coverageByFile = new Map<string, IstanbulFileCoverage>();
  for (const [coveragePath, file] of Object.entries(coverage)) {
    coverageByFile.set(normalizePath(file.path || coveragePath), file);
  }
  let executableLines = 0;
  let coveredLines = 0;
  for (const [fileName, lines] of Object.entries(changedLines)) {
    const file = coverageByFile.get(normalizePath(fileName));
    const uniqueLines = new Set(lines);
    executableLines += uniqueLines.size;
    if (!file) continue;

    const statementRanges = Object.entries(file.statementMap).map(([id, location]) => ({ location, hit: file.s[id] ?? 0 }));
    const branchRanges = Object.entries(file.branchMap).flatMap(([id, branch]) =>
      branch.locations.map((location, index) => ({ location, hit: file.b[id]?.[index] ?? 0 })),
    );
    const functionRanges = Object.entries(file.fnMap).map(([id, fn]) => ({ location: fn.loc, hit: file.f[id] ?? 0 }));
    for (const line of uniqueLines) {
      const containsLine = ({ location }: { location: Location }): boolean =>
        location.start.line <= line && line <= location.end.line;
      const statements = statementRanges.filter(containsLine);
      const branches = branchRanges.filter(containsLine);
      const functions = functionRanges.filter(containsLine);
      const mostSpecific = statements.length > 0 ? statements : branches.length > 0 ? branches : functions;
      if (mostSpecific.some(({ hit }) => hit > 0)) coveredLines += 1;
    }
  }
  const percentage = executableLines === 0 ? null : Number(((coveredLines / executableLines) * 100).toFixed(2));
  return { baseRef, executableLines, coveredLines, pct: percentage, ok: percentage == null || percentage >= 85 };
}

export function parseChangedSourceLines(diff: string): Record<string, number[]> {
  const changed: Record<string, number[]> = {};
  let currentFile: string | null = null;
  let newLine = 0;
  let inInterfaceBlock = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).replaceAll("\\", "/");
      if (!/^src\/(domain|errors|services|repositories)\/.*\.ts$/.test(currentFile)) currentFile = null;
      inInterfaceBlock = false;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      const source = line.slice(1).trim();
      if (source.startsWith("interface ") || source.startsWith("export interface ")) {
        inInterfaceBlock = true;
      }
      if (inInterfaceBlock) {
        if (source === "}") inInterfaceBlock = false;
        newLine += 1;
        continue;
      }
      if (source && !source.startsWith("//") && !source.startsWith("/*") && !source.startsWith("*") && !source.startsWith("import type ") && !source.startsWith("export type ") && !source.startsWith("type ") && !source.startsWith("interface ") && !source.startsWith("export interface ") && source !== "}" && source !== "{") {
        (changed[currentFile] ??= []).push(newLine);
      }
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return changed;
}

function collectDiffCoverage(projectRoot: string, coverage: Record<string, IstanbulFileCoverage>): DiffCoverage {
  const baseRef = process.env.COVERAGE_BASE_REF ?? "origin/main";
  const result = spawnSync("git", ["diff", "--unified=0", `${baseRef}...HEAD`, "--", "src"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git diff failed for coverage base ${baseRef}: ${(result.stderr || result.stdout).trim()}`);
  return calculateDiffCoverage(parseChangedSourceLines(result.stdout), coverage, baseRef);
}

function parseBaseline(raw: string, source: string): CoverageThresholds {
  const parsed = JSON.parse(raw) as Partial<CoverageThresholds>;
  for (const layer of ["domain", "service", "repository"] as const) {
    for (const metric of ["lines", "statements", "branches"] as const) {
      const value = parsed[layer]?.[metric];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`Invalid coverage baseline ${source}: ${layer}.${metric}`);
      }
    }
  }
  return parsed as CoverageThresholds;
}

export function assertBaselineNonRegression(current: CoverageThresholds, base: CoverageThresholds): void {
  const regressions: string[] = [];
  for (const layer of ["domain", "service", "repository"] as const) {
    for (const metric of ["lines", "statements", "branches"] as const) {
      if (current[layer][metric] < base[layer][metric]) {
        regressions.push(`${layer}.${metric} ${current[layer][metric]} < ${base[layer][metric]}`);
      }
    }
  }
  if (regressions.length > 0) throw new Error(`Coverage baseline thresholds decreased: ${regressions.join(", ")}`);
}

function loadAndValidateBaseline(projectRoot: string): CoverageThresholds {
  const relativePath = "config/coverage-baseline.json";
  const current = parseBaseline(readFileSync(path.join(projectRoot, relativePath), "utf8"), relativePath);
  assertBaselineNonRegression(current, BOOTSTRAP_BASELINE);

  const baseRef = process.env.COVERAGE_BASE_REF;
  if (!baseRef) return current;
  const baseFile = spawnSync("git", ["show", `${baseRef}:${relativePath}`], { cwd: projectRoot, encoding: "utf8" });
  if (baseFile.status === 0) {
    assertBaselineNonRegression(current, parseBaseline(baseFile.stdout, `${baseRef}:${relativePath}`));
  } else if (!/exists on disk, but not in|does not exist in|Path .* does not exist/.test(baseFile.stderr)) {
    throw new Error(`Unable to read coverage baseline from ${baseRef}: ${baseFile.stderr.trim()}`);
  }
  return current;
}

export function buildLayeredSummary(
  coverage: Record<string, IstanbulFileCoverage>,
  evidence: TestEvidence[] = [],
  diffCoverage: DiffCoverage = { baseRef: "test", executableLines: 0, coveredLines: 0, pct: null, ok: true },
  baselineThresholds: CoverageThresholds = BOOTSTRAP_BASELINE,
): LayeredCoverageSummary {
  const counters: Record<CoreLayer, ReturnType<typeof EMPTY_COUNTERS>> = {
    domain: EMPTY_COUNTERS(),
    service: EMPTY_COUNTERS(),
    repository: EMPTY_COUNTERS(),
  };

  for (const [coveragePath, fileCoverage] of Object.entries(coverage)) {
    const layer = classifySourceFile(fileCoverage.path || coveragePath);
    const fileCounters = countersForFile(fileCoverage);
    for (const metric of Object.keys(fileCounters) as MetricName[]) {
      counters[layer][metric].covered += fileCounters[metric].covered;
      counters[layer][metric].total += fileCounters[metric].total;
    }
  }

  const layers = Object.fromEntries(
    (Object.keys(counters) as CoreLayer[]).map((layer) => [
      layer,
      Object.fromEntries(
        (Object.keys(counters[layer]) as MetricName[]).map((metric) => {
          const value = counters[layer][metric];
          return [metric, { ...value, pct: pct(value.covered, value.total) }];
        }),
      ) as LayerMetrics,
    ]),
  ) as Record<CoreLayer, LayerMetrics>;

  const baselineGates = Object.fromEntries(
    (Object.keys(layers) as CoreLayer[]).map((layer) => [layer, evaluateLayerGate(layers[layer], baselineThresholds[layer])]),
  ) as Record<CoreLayer, LayerGate>;
  const targetGates = Object.fromEntries(
    (Object.keys(layers) as CoreLayer[]).map((layer) => [layer, evaluateLayerGate(layers[layer], TARGET_THRESHOLDS)]),
  ) as Record<CoreLayer, LayerGate>;

  return {
    generatedAt: new Date().toISOString(),
    targetThresholds: TARGET_THRESHOLDS,
    baselineThresholds,
    layers,
    baselineGates,
    targetGates,
    evidence,
    diffCoverage,
    baselineOk: Object.values(baselineGates).every((gate) => gate.ok) && diffCoverage.ok,
    targetOk: Object.values(targetGates).every((gate) => gate.ok),
  };
}

function walkFiles(root: string, predicate: (relative: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const relative = path.relative(path.dirname(root), absolute).replaceAll("\\", "/");
        if (predicate(relative)) files.push(relative);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function findUnknownSourceDirectories(sourceDirectories: string[]): string[] {
  return sourceDirectories.filter((directory) => !KNOWN_SOURCE_DIRECTORIES.has(directory)).sort();
}

function assertKnownSourceArchitecture(projectRoot: string): void {
  const sourceRoot = path.join(projectRoot, "src");
  const directories = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const unknown = findUnknownSourceDirectories(directories);
  if (unknown.length > 0) {
    throw new Error(`Unknown src architecture directories: ${unknown.join(", ")}. Classify them before merging.`);
  }
}

function collectEvidence(projectRoot: string): TestEvidence[] {
  const testRoot = path.join(projectRoot, "tests");
  const e2eRoot = path.join(projectRoot, "e2e");
  const allTests = walkFiles(testRoot, (file) => file.endsWith(".test.ts"));
  const evidence: TestEvidence[] = [
    { category: "http-contract", files: allTests.filter((file) => file.startsWith("tests/http/")), count: 0, evidenceKind: "test-reference", enforcedBy: "npm run test:unit", executionScope: "unit-job" },
    { category: "db-integration", files: allTests.filter((file) => file.includes(".integration.test.ts")), count: 0, evidenceKind: "test-reference", enforcedBy: "npm run verify:db", executionScope: "database-job" },
    { category: "script-workflow", files: allTests.filter((file) => file.startsWith("tests/scripts/") || file.startsWith("tests/operations/")), count: 0, evidenceKind: "test-reference", enforcedBy: "npm run test:unit", executionScope: "unit-job" },
    { category: "e2e-journey", files: walkFiles(e2eRoot, (file) => file.endsWith(".spec.ts")), count: 0, evidenceKind: "test-reference", enforcedBy: "npm run test:e2e", executionScope: "e2e-job" },
  ];
  for (const item of evidence) item.count = item.files.length;
  return evidence;
}

function toMarkdown(summary: LayeredCoverageSummary): string {
  const rows = (Object.keys(summary.layers) as CoreLayer[]).map((layer) => {
    const m = summary.layers[layer];
    return `| ${layer} | ${m.lines.pct}% | ${m.statements.pct}% | ${m.branches.pct}% | ${m.functions.pct}% | ${summary.baselineGates[layer].ok ? "PASS" : "FAIL"} | ${summary.targetGates[layer].ok ? "PASS" : "GAP"} |`;
  });
  const evidenceRows = summary.evidence.map((item) => `| ${item.category} | ${item.count} | \`${item.enforcedBy}\` (${item.executionScope}) | ${item.files.join("<br>") || "—"} |`);
  return [
    "# Layered Coverage Summary",
    "",
    `Baseline ratchet gate: **${summary.baselineOk ? "PASS" : "FAIL"}**`,
    `Final target status: **${summary.targetOk ? "PASS" : "GAPS REMAIN"}**`,
    `Diff coverage (>=85%): **${summary.diffCoverage.pct == null ? "N/A — no executable core changes" : `${summary.diffCoverage.pct}% (${summary.diffCoverage.ok ? "PASS" : "FAIL"})`}**`,
    "",
    "Final target: lines/statements >= 85%, branches >= 75% per layer. The baseline ratchet is the enforced non-regression gate; it may only move upward.",
    "",
    "| Layer | Lines | Statements | Branches | Functions | Baseline | Final target |",
    "|---|---:|---:|---:|---:|---|---|",
    ...rows,
    "",
    "## Functional evidence matrix",
    "",
    "The matrix lists test references and the CI command/job that enforces them; file presence alone is not treated as a pass result.",
    "",
    "| Evidence category | Test files | Enforced by | References |",
    "|---|---:|---|---|",
    ...evidenceRows,
    "",
  ].join("\n");
}

function run(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const coverageDir = path.join(projectRoot, "coverage");
  assertKnownSourceArchitecture(projectRoot);
  const inputPath = path.join(coverageDir, "coverage-final.json");
  if (!existsSync(inputPath)) throw new Error(`Coverage input not found: ${inputPath}`);
  const coverage = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, IstanbulFileCoverage>;
  const summary = buildLayeredSummary(
    coverage,
    collectEvidence(projectRoot),
    collectDiffCoverage(projectRoot, coverage),
    loadAndValidateBaseline(projectRoot),
  );
  mkdirSync(coverageDir, { recursive: true });
  writeFileSync(path.join(coverageDir, "layered-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(path.join(coverageDir, "layered-summary.md"), toMarkdown(summary), "utf8");
  console.log(toMarkdown(summary));
  if (!summary.baselineOk) {
    const failures = Object.entries(summary.baselineGates)
      .filter(([, gate]) => !gate.ok)
      .map(([layer, gate]) => `${layer}: ${gate.failures.join(", ")}`);
    if (!summary.diffCoverage.ok) {
      failures.push(
        `diff: ${summary.diffCoverage.coveredLines}/${summary.diffCoverage.executableLines} changed executable lines covered (${summary.diffCoverage.pct ?? 0}% < 85%)`,
      );
    }
    throw new Error(`Layered coverage gate failed: ${failures.join("; ")}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    console.error(`[layered-coverage] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
