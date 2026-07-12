import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CoreLayer = "domain" | "service" | "repository";
type MetricName = "lines" | "statements" | "functions" | "branches";

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
const BASELINE_THRESHOLDS: Record<CoreLayer, { lines: number; statements: number; branches: number }> = {
  domain: { lines: 85, statements: 85, branches: 79 },
  service: { lines: 87, statements: 85, branches: 75 },
  repository: { lines: 67, statements: 64, branches: 58 },
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
    if (!file) continue;
    const changed = new Set(lines);
    const statementsByLine = new Map<number, number[]>();
    for (const [id, location] of Object.entries(file.statementMap)) {
      if (!changed.has(location.start.line)) continue;
      const hits = statementsByLine.get(location.start.line) ?? [];
      hits.push(file.s[id] ?? 0);
      statementsByLine.set(location.start.line, hits);
    }
    for (const hits of statementsByLine.values()) {
      executableLines += 1;
      if (hits.some((hit) => hit > 0)) coveredLines += 1;
    }
  }
  const percentage = executableLines === 0 ? null : Number(((coveredLines / executableLines) * 100).toFixed(2));
  return { baseRef, executableLines, coveredLines, pct: percentage, ok: percentage == null || percentage >= 85 };
}

export function parseChangedSourceLines(diff: string): Record<string, number[]> {
  const changed: Record<string, number[]> = {};
  let currentFile: string | null = null;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).replaceAll("\\", "/");
      if (!/^src\/(domain|errors|services|repositories)\/.*\.ts$/.test(currentFile)) currentFile = null;
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
      if (source && !source.startsWith("//") && !source.startsWith("/*") && !source.startsWith("*") && !source.startsWith("import type ") && !source.startsWith("export type ") && !source.startsWith("type ") && !source.startsWith("interface ") && source !== "}" && source !== "{") {
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

export function buildLayeredSummary(
  coverage: Record<string, IstanbulFileCoverage>,
  evidence: TestEvidence[] = [],
  diffCoverage: DiffCoverage = { baseRef: "test", executableLines: 0, coveredLines: 0, pct: null, ok: true },
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
    (Object.keys(layers) as CoreLayer[]).map((layer) => [layer, evaluateLayerGate(layers[layer], BASELINE_THRESHOLDS[layer])]),
  ) as Record<CoreLayer, LayerGate>;
  const targetGates = Object.fromEntries(
    (Object.keys(layers) as CoreLayer[]).map((layer) => [layer, evaluateLayerGate(layers[layer], TARGET_THRESHOLDS)]),
  ) as Record<CoreLayer, LayerGate>;

  return {
    generatedAt: new Date().toISOString(),
    targetThresholds: TARGET_THRESHOLDS,
    baselineThresholds: BASELINE_THRESHOLDS,
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
    { category: "db-integration", files: allTests.filter((file) => file.includes(".integration.test.ts") || file === "tests/review-concurrency.test.ts"), count: 0, evidenceKind: "test-reference", enforcedBy: "npm run verify:db", executionScope: "database-job" },
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
  );
  mkdirSync(coverageDir, { recursive: true });
  writeFileSync(path.join(coverageDir, "layered-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(path.join(coverageDir, "layered-summary.md"), toMarkdown(summary), "utf8");
  console.log(toMarkdown(summary));
  if (!summary.baselineOk) {
    const detail = Object.entries(summary.baselineGates)
      .filter(([, gate]) => !gate.ok)
      .map(([layer, gate]) => `${layer}: ${gate.failures.join(", ")}`)
      .join("; ");
    throw new Error(`Layered coverage baseline regressed: ${detail}`);
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
