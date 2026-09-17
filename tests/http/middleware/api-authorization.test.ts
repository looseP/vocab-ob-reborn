import { describe, expect, it } from "vitest";
import {
  FAIL_CLOSED_MIN_ROLE,
  compilePathTemplate,
  resolveMinRole,
} from "@/http/middleware/api-authorization";
import { apiOperations } from "@/http/operations";

describe("resolveMinRole", () => {
  it("is case-insensitive on the method", () => {
    expect(resolveMinRole("get", "/api/words")).toBe("agent");
    expect(resolveMinRole("GET", "/api/words")).toBe("agent");
  });

  it("prefers the static route over the parameter route with the same shape", () => {
    // /api/words/suggest 必须胜过 /api/words/:slug（两者 minRole 恰好同为 agent，
    // 但匹配器必须按静态段优先，否则换一个 role 不同的对就会漏判）。
    expect(compilePathTemplate("/api/words/suggest").test("/api/words/suggest")).toBe(true);
    expect(compilePathTemplate("/api/words/:slug").test("/api/words/suggest")).toBe(true);
    expect(resolveMinRole("get", "/api/words/suggest")).toBe("agent");
  });

  it("resolves concrete paths for every /api/* operation to its registry minRole", () => {
    for (const operation of apiOperations) {
      if (!operation.path.startsWith("/api/")) continue;
      if (operation.path === "/api/auth/session") continue; // /api/auth 是豁免组
      const concrete = operation.path.replace(/:[A-Za-z0-9_]+/g, "sample");
      expect(resolveMinRole(operation.method, concrete), operation.operationId).toBe(operation.minRole);
    }
  });

  it("fails closed to owner for an unknown /api/* route (A4)", () => {
    expect(FAIL_CLOSED_MIN_ROLE).toBe("owner");
    expect(resolveMinRole("get", "/api/does-not-exist")).toBe("owner");
    expect(resolveMinRole("post", "/api/words/hello/unknown")).toBe("owner");
  });

  it("does not treat non-/api paths as governed by the role table", () => {
    // healthz/metrics 有自己的挂载点；本查找表不覆盖它们，故落到 fail-closed 默认。
    expect(resolveMinRole("get", "/healthz")).toBe("owner");
    expect(resolveMinRole("get", "/metrics")).toBe("owner");
  });

  it("does not let regex metacharacters in a path template act as wildcards", () => {
    const pattern = compilePathTemplate("/api/a.b/:id");
    expect(pattern.test("/api/a.b/x")).toBe(true);
    expect(pattern.test("/api/axb/x")).toBe(false);
    expect(pattern.test("/api/a.b")).toBe(false);
  });
});
