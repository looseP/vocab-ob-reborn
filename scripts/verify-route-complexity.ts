import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type RouteComplexity = { file: string; maxLines: number; maxRoutes: number };
export type GitResult = { status: number | null; stdout: string; stderr: string };
export type GitRunner = (args: string[], root: string) => GitResult;

export const ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS: RouteComplexity[] = [
  { file: "src/http/routes/l2.ts", maxLines: 300, maxRoutes: 5 },
  { file: "src/http/routes/l3.ts", maxLines: 500, maxRoutes: 30 },
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

export function readBaseRouteSource(root: string, ref: string, file: string, git: GitRunner = runGit): string | null {
  const commit = git(["cat-file", "-e", `${ref}^{commit}`], root);
  if (commit.status !== 0) throw new Error(`Invalid route complexity base ref ${ref}: ${commit.stderr.trim()}`);

  const tree = git(["ls-tree", "--name-only", ref, "--", file], root);
  if (tree.status !== 0) throw new Error(`Unable to inspect ${file} in ${ref}: ${tree.stderr.trim()}`);
  if (tree.stdout.trim() === "") return null;

  const result = git(["show", `${ref}:${file}`], root);
  if (result.status !== 0) throw new Error(`Unable to read ${file} from ${ref}: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function verifyRouteComplexity(
  root = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  git: GitRunner = runGit,
) {
  const failures: string[] = [];
  const ref = resolveBaseRef(environment);
  for (const bootstrap of ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS) {
    const source = await readFile(`${root}/${bootstrap.file}`, "utf8");
    const actual = measureRouteComplexity(source);
    const baseSource = readBaseRouteSource(root, ref, bootstrap.file, git);
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
