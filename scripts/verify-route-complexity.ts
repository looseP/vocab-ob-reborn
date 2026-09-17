import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type RouteComplexity = { file: string; maxLines: number; maxRoutes: number };
export type GitResult = { status: number | null; stdout: string; stderr: string };
export type GitRunner = (args: string[], root: string) => GitResult;

export const ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS: RouteComplexity[] = [
  { file: "src/http/routes/l2.ts", maxLines: 300, maxRoutes: 5 },
  // L3 路由 2026-09-08 自单文件 l3.ts（499/500 触顶）拆分为资源域子文件；
  // 各子文件 bootstrap 限额按拆分实测规模留有增长余量（基线无该文件时生效）。
  { file: "src/http/routes/l3/index.ts", maxLines: 60, maxRoutes: 0 },
  { file: "src/http/routes/l3/sources.ts", maxLines: 160, maxRoutes: 8 },
  // 2026-09-16 V0：能力域标签全量替换（PUT /sources/:id/spaces 自受棘轮冻结的
  // sources.ts 迁出；独立薄路由，server.ts 直挂，同 capabilities/summary 先例）。
  { file: "src/http/routes/l3/spaces.ts", maxLines: 45, maxRoutes: 1 },
  { file: "src/http/routes/l3/contexts.ts", maxLines: 220, maxRoutes: 10 },
  { file: "src/http/routes/l3/reads.ts", maxLines: 110, maxRoutes: 4 },
  { file: "src/http/routes/l3/imports.ts", maxLines: 130, maxRoutes: 3 },
  // 2026-09-16 ADR-0030：题目/试卷域路由（建卷/录题/文件列表/卷详情/删题护栏）。
  // bootstrap 限额按建文件时实测规模留一档余量；文件新增前以 bootstrap 分支取证。
  { file: "src/http/routes/l3/papers.ts", maxLines: 110, maxRoutes: 7 },
  // 2026-09-16 批次一：做题注记 CRUD + 规律标签字典整取/整存（6 端点薄路由，
  // server.ts 直挂；bootstrap 限额留一档余量）。
  { file: "src/http/routes/l3/annotations.ts", maxLines: 160, maxRoutes: 8 },
  // 2026-09-17 批次二：题纸（开纸/读/merge/定格）与作答历史（批量/软删）薄路由
  // （server.ts 直挂；bootstrap 限额按实测规模留余量）。
  { file: "src/http/routes/l3/sheets.ts", maxLines: 120, maxRoutes: 8 },
  // 2026-09-17 批次二收官：题纸冻结导出独立薄路由（sheets.ts 受棘轮约束不许增长，
  // 新端点沿 capabilities/summary 先例拆分；bootstrap 限额按实测留一档余量，
  // 校验方式同先例：ROUTE_COMPLEXITY_BASE_REF=<本文件新增前的 ref> 走 bootstrap 分支）。
  { file: "src/http/routes/l3/sheets-export.ts", maxLines: 30, maxRoutes: 1 },
  // 2026-09-17 增补批：注记撤回独立薄路由（annotations.ts 受棘轮约束不许增长，
  // 新端点沿 capabilities/sheets-export 先例拆分；bootstrap 限额按实测留一档余量）。
  { file: "src/http/routes/l3/annotations-withdraw.ts", maxLines: 30, maxRoutes: 1 },
  // 2026-09-17 增补批：评析区独立薄路由（新文件 bootstrap 限额按实测留一档余量）。
  { file: "src/http/routes/l3/assessments.ts", maxLines: 40, maxRoutes: 2 },
  // 2026-09-17 批次三①：评卷执行面独立薄路由（sheets.ts 受棘轮约束不许增长，
  // 新端点沿 sheets-export/assessments 先例拆分；bootstrap 限额按实测留一档余量）。
  { file: "src/http/routes/l3/grading.ts", maxLines: 60, maxRoutes: 4 },
  { file: "src/http/routes/l3/proposals.ts", maxLines: 160, maxRoutes: 8 },
  { file: "src/http/routes/l3/recommendations.ts", maxLines: 120, maxRoutes: 6 },
  { file: "src/http/routes/l3/shared.ts", maxLines: 40, maxRoutes: 0 },
  // 2026-09-09 棘轮扩容：把剩余三个最大路由文件按实测现状钉进棘轮
  // （bootstrap 限额 = 实测值，只许经基线比较上行，不许静默膨胀）。
  { file: "src/http/routes/review.ts", maxLines: 259, maxRoutes: 14 },
  { file: "src/http/routes/l2-candidates.ts", maxLines: 226, maxRoutes: 10 },
  { file: "src/http/routes/words.ts", maxLines: 197, maxRoutes: 11 },
  // 2026-09-12 T10：l2 路由族共享解析器（parseDraftOptions / parseDirection /
  // parseUuid）拆出 l2.ts 与 l2-candidates.ts，保持两个路由文件不超过基线；
  // 本文件纯解析、零路由注册。
  // 上限 = 冻结时的**实际总行数**，取数口径必须与 measureRouteComplexity 相同：
  // 含空行（split(/\r?\n/) 去尾换行）→ 62。非空行数是 58，曾因用编辑器口径设成 58，
  // 在 base 早于本文件新增时（bootstrap 分支）判为 62 > 58 而红。
  // 校验方式：ROUTE_COMPLEXITY_BASE_REF=<本文件新增前的 ref> 时走 bootstrap 分支，
  // 才能真正验到这个上限。
  { file: "src/http/routes/l2-shared.ts", maxLines: 62, maxRoutes: 0 },
  // 2026-09-12 T13c：capabilities 能力发现薄路由（l3/index.ts 受棘轮冻结，无法
  // 挂进 l3Routes，沿 l3/lists.ts + l2-* 的 server.ts 直挂先例）。上限 = 冻结时
  // 的**实际总行数**，取数口径与 measureRouteComplexity 相同：含空行
  // （split(/\r?\n/) 去尾换行）→ 43。校验方式：ROUTE_COMPLEXITY_BASE_REF=<本
  // 文件新增前的 ref> 时走 bootstrap 分支，才能真正验到这个上限。
  { file: "src/http/routes/l3/capabilities.ts", maxLines: 43, maxRoutes: 1 },
  // 2026-09-12 B1：空间汇总薄路由（素材宇宙的全量计数 + 生长趋势；l3/index.ts 受
  // 棘轮冻结，沿 l3/lists.ts + capabilities.ts 的 server.ts 直挂先例）。上限 = 冻结
  // 时的**实际总行数**，取数口径与 measureRouteComplexity 相同：含空行
  // （split(/\r?\n/) 去尾换行）→ 29。校验方式：ROUTE_COMPLEXITY_BASE_REF=<本
  // 文件新增前的 ref> 时走 bootstrap 分支，才能真正验到这个上限。
  { file: "src/http/routes/l3/summary.ts", maxLines: 29, maxRoutes: 1 },
];

export function measureRouteComplexity(source: string) {
  return {
    lines: source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0),
    routes: [...source.matchAll(/\bapp\.(?:get|post|put|patch|delete)\s*\(/g)].length,
  };
}

const runGit: GitRunner = (args, root) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export function resolveBaseRef(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.ROUTE_COMPLEXITY_BASE_REF ?? environment.API_CONTRACT_BASE_REF ?? "HEAD^";
}

/**
 * Read the base-ref sources for a batch of route files.
 *
 * Git subprocesses are batched: one `cat-file -e` and one recursive
 * `ls-tree` for the whole batch, then one `show` per file that exists in the
 * base tree. The previous per-file implementation spawned 3 subprocesses × N
 * files inside the ratchet loop, which pushed CI past the 30s step timeout on
 * loaded runners. Missing files yield `null` so callers can fall back to
 * bootstrap limits.
 */
export function readBaseRouteSources(
  root: string,
  ref: string,
  files: readonly string[],
  git: GitRunner = runGit,
): (string | null)[] {
  const commit = git(["cat-file", "-e", `${ref}^{commit}`], root);
  if (commit.status !== 0) throw new Error(`Invalid route complexity base ref ${ref}: ${commit.stderr.trim()}`);

  const tree = git(["ls-tree", "-r", "--name-only", ref], root);
  if (tree.status !== 0) throw new Error(`Unable to inspect route files in ${ref}: ${tree.stderr.trim()}`);
  const present = new Set(tree.stdout.split(/\r?\n/).filter((line) => line.length > 0));

  return files.map((file) => {
    if (!present.has(file)) return null;
    const result = git(["show", `${ref}:${file}`], root);
    if (result.status !== 0) throw new Error(`Unable to read ${file} from ${ref}: ${result.stderr.trim()}`);
    return result.stdout;
  });
}

/** Single-file convenience wrapper around readBaseRouteSources. */
export function readBaseRouteSource(root: string, ref: string, file: string, git: GitRunner = runGit): string | null {
  return readBaseRouteSources(root, ref, [file], git)[0];
}

export async function verifyRouteComplexity(
  root = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  git: GitRunner = runGit,
) {
  const failures: string[] = [];
  const ref = resolveBaseRef(environment);
  const baseSources = readBaseRouteSources(
    root,
    ref,
    ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS.map((bootstrap) => bootstrap.file),
    git,
  );
  for (const [index, bootstrap] of ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS.entries()) {
    const source = await readFile(`${root}/${bootstrap.file}`, "utf8");
    const actual = measureRouteComplexity(source);
    const baseSource = baseSources[index];
    const limit = baseSource ? measureRouteComplexity(baseSource) : { lines: bootstrap.maxLines, routes: bootstrap.maxRoutes };
    if (actual.lines > limit.lines) failures.push(`${bootstrap.file}: ${actual.lines} lines > ${limit.lines} (${baseSource ? ref : "bootstrap"})`);
    if (actual.routes > limit.routes) failures.push(`${bootstrap.file}: ${actual.routes} routes > ${limit.routes} (${baseSource ? ref : "bootstrap"})`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = await verifyRouteComplexity();
    if (failures.length > 0) {
      console.error(`Route complexity ratchet failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log("Route complexity ratchet passed.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
