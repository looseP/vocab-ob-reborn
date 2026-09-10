import { describe, expect, it, vi } from "vitest";
import {
  measureRouteComplexity,
  readBaseRouteSource,
  readBaseRouteSources,
  resolveBaseRef,
  ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS,
  verifyRouteComplexity,
  type GitRunner,
} from "../../scripts/verify-route-complexity";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");

describe("route complexity ratchet", () => {
  it("counts LOC and Hono route registrations", () => {
    expect(measureRouteComplexity('app.get("/a", handler);\napp.post("/b", handler);\n')).toEqual({ lines: 2, routes: 2 });
  });

  it("prefers the dedicated base ref and falls back to the contract base ref", () => {
    expect(resolveBaseRef({ ROUTE_COMPLEXITY_BASE_REF: "origin/main", API_CONTRACT_BASE_REF: "HEAD^" })).toBe("origin/main");
    expect(resolveBaseRef({ API_CONTRACT_BASE_REF: "merge-base" })).toBe("merge-base");
  });

  it("compares current files against sources read from the base ref", async () => {
    const allBaseFiles = `${ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS.map((bootstrap) => bootstrap.file).join("\n")}\n`;
    const git: GitRunner = (args) => {
      if (args[0] === "cat-file" && args[2].endsWith("^{commit}")) return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-tree") return { status: 0, stdout: allBaseFiles, stderr: "" };
      if (args[0] === "show") return { status: 0, stdout: "app.get('/only', handler);\n", stderr: "" };
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const failures = await verifyRouteComplexity(root, { ROUTE_COMPLEXITY_BASE_REF: "base" }, git);
    expect(failures).toEqual(expect.arrayContaining([expect.stringContaining("routes > 1 (base)")]));
  });

  it("batches git inspection instead of spawning per file inside the loop", async () => {
    // 30s-timeout guard: one cat-file + one ls-tree for the whole batch, then
    // exactly one show per bootstrap file — never 3 subprocesses × N files.
    const allBaseFiles = `${ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS.map((bootstrap) => bootstrap.file).join("\n")}\n`;
    const git = vi.fn((args: string[]) => {
      if (args[0] === "cat-file") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-tree") return { status: 0, stdout: allBaseFiles, stderr: "" };
      if (args[0] === "show") return { status: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    }) as unknown as GitRunner;
    await verifyRouteComplexity(root, { ROUTE_COMPLEXITY_BASE_REF: "base" }, git);
    // Each mock.calls entry is the invocation arg list [args, root].
    const calls = (git as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string[], string]>;
    expect(calls.filter(([args]) => args[0] === "cat-file")).toHaveLength(1);
    expect(calls.filter(([args]) => args[0] === "ls-tree")).toHaveLength(1);
    expect(calls.filter(([args]) => args[0] === "show")).toHaveLength(
      ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS.length,
    );
  });

  it("yields null for files absent from the base tree (batched read)", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "cat-file") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-tree") return { status: 0, stdout: "src/http/routes/review.ts\n", stderr: "" };
      if (args[0] === "show") return { status: 0, stdout: "app.get('/x', h);\n", stderr: "" };
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const sources = readBaseRouteSources(root, "base", [
      "src/http/routes/review.ts",
      "src/http/routes/words.ts",
    ], git);
    expect(sources[0]).toBe("app.get('/x', h);\n");
    expect(sources[1]).toBeNull();
  });

  it("uses bootstrap limits only when the base commit has no route file", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "cat-file" && args[2].endsWith("^{commit}")) return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-tree") return { status: 0, stdout: "", stderr: "" };
      return { status: 128, stdout: "", stderr: "unexpected" };
    };
    expect(readBaseRouteSource(root, "base", "missing.ts", git)).toBeNull();
  });

  it("fails closed for an invalid base ref", () => {
    const git: GitRunner = () => ({ status: 128, stdout: "", stderr: "bad revision" });
    expect(() => readBaseRouteSource(root, "bad-ref", "route.ts", git)).toThrow("Invalid route complexity base ref");
  });

  it("fails closed when git cannot inspect a path", () => {
    const git: GitRunner = (args) => args[0] === "cat-file"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 128, stdout: "", stderr: "repository failure" };
    expect(() => readBaseRouteSource(root, "base", "route.ts", git)).toThrow("Unable to inspect");
  });

  it("keeps L2/L3 at or below the real git base", async () => {
    // Pin the dedicated base ref so the ratchet stays on its per-commit default
    // (HEAD^) even when the gate session exports API_CONTRACT_BASE_REF=main for
    // the OpenAPI contract checks — branch-approved route growth (L3 MVP) must
    // not be judged against the stale main snapshot.
    await expect(verifyRouteComplexity(root, { ROUTE_COMPLEXITY_BASE_REF: "HEAD^" })).resolves.toEqual([]);
  });
});
