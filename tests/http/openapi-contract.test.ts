import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractApiSourceRoutes, extractStaticRoutes } from "../../scripts/api-source-routes";
import { serializeOpenApiDocument } from "../../src/http/openapi";
import { apiOperations } from "../../src/http/operations";

function routeKey(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

describe("API contract", () => {
  it("keeps source routes and the operation registry in exact sync", async () => {
    const source = (await extractApiSourceRoutes()).map(routeKey).sort();
    const registry = apiOperations.map(routeKey).sort();
    expect(new Set(source).size).toBe(source.length);
    expect(new Set(registry).size).toBe(registry.length);
    expect(source).toEqual(registry);
  });

  it("rejects dynamic or computed Hono route registrations", () => {
    expect(() => extractStaticRoutes("app.get(path, handler)", "dynamic.ts")).toThrow(/static string literal/);
    expect(() => extractStaticRoutes('app["get"]("/hidden", handler)', "computed.ts")).toThrow(/computed/);
    expect(() => extractStaticRoutes('const router = app; router.get("/hidden", handler)', "alias.ts")).toThrow(/aliasing app/);
    expect(() => extractStaticRoutes('const { get } = app; get("/hidden", handler)', "destructure.ts")).toThrow(/aliasing app/);
    expect(() => extractStaticRoutes('register(app)', "passing.ts")).toThrow(/passing app/);
    expect(() => extractStaticRoutes('app.on("GET", "/hidden", handler)', "on.ts")).toThrow(/unsupported app.on/);
    expect(() => extractStaticRoutes('app.all("/hidden", handler)', "all.ts")).toThrow(/unsupported app.all/);
    expect(() => extractStaticRoutes("app.route(prefix, child())", "mount.ts")).toThrow(/static string literal prefix/);
  });

  it("keeps operation ids unique", () => {
    const operationIds = apiOperations.map((operation) => operation.operationId);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("describes defaulted query parameters as optional request inputs", () => {
    const document = JSON.parse(serializeOpenApiDocument()) as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; required: boolean }> }>>;
    };
    const parameters = document.paths["/api/words"].get.parameters ?? [];
    expect(parameters.find((parameter) => parameter.name === "limit")?.required).toBe(false);
    expect(parameters.find((parameter) => parameter.name === "offset")?.required).toBe(false);
  });

  it("matches the deterministic OpenAPI 3.1 snapshot", async () => {
    const snapshot = await readFile(path.resolve("docs/api/openapi.json"), "utf8");
    expect(serializeOpenApiDocument()).toBe(snapshot);
  });
});
