import { describe, expect, it } from "vitest";
import {
  measureRouteComplexity,
  readBaseRouteSource,
  resolveBaseRef,
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
    const git: GitRunner = (args) => {
      if (args[0] === "cat-file" && args[2].endsWith("^{commit}")) return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-tree") return { status: 0, stdout: `${args.at(-1)}\n`, stderr: "" };
      if (args[0] === "show") return { status: 0, stdout: "app.get('/only', handler);\n", stderr: "" };
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const failures = await verifyRouteComplexity(root, { ROUTE_COMPLEXITY_BASE_REF: "base" }, git);
    expect(failures).toEqual(expect.arrayContaining([expect.stringContaining("routes > 1 (base)")]));
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
    await expect(verifyRouteComplexity(root)).resolves.toEqual([]);
  });
});
