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

  it("requires explicit authentication and CSRF policies for every operation", () => {
    expect(apiOperations.every((operation) => operation.auth !== undefined)).toBe(true);
    expect(apiOperations.every((operation) => operation.csrf !== undefined)).toBe(true);
    expect(apiOperations.filter((operation) => operation.csrf === "sessionMutation").every((operation) => !["get"].includes(operation.method))).toBe(true);
  });

  it("generates explicit security schemes and operation requirements", () => {
    const document = JSON.parse(serializeOpenApiDocument()) as {
      components?: { securitySchemes?: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: Array<Record<string, string[]>>; "x-auth-policy"?: string; "x-csrf-policy"?: string }>>;
    };
    expect(document.components?.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
      csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
      metricsBearerAuth: { type: "http", scheme: "bearer" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "vocab_session" },
    });
    expect(document.paths["/healthz"].get.security).toEqual([]);
    expect(document.paths["/metrics"].get.security).toEqual([{ metricsBearerAuth: [] }]);
    expect(document.paths["/api/words"].get.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);
    expect(document.paths["/api/review/answer"].post.security).toEqual([
      { bearerAuth: [] },
      { sessionCookie: [], csrfToken: [] },
    ]);
    expect(document.paths["/api/auth/session"].delete.security).toEqual([
      {},
      { sessionCookie: [], csrfToken: [] },
    ]);
    expect(document.paths["/api/auth/session"].delete["x-auth-policy"]).toBe("optionalSession");
    expect(document.paths["/api/auth/session"].delete["x-csrf-policy"]).toBe("sessionMutation");
  });

  it("publishes authentication request and response header contracts", () => {
    const document = JSON.parse(serializeOpenApiDocument()) as {
      paths: Record<string, Record<string, {
        parameters?: Array<{ in: string; name: string; required: boolean }>;
        responses: Record<string, { headers?: Record<string, unknown> }>;
      }>>;
    };
    const login = document.paths["/api/auth/session"].post;
    expect(login.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "Origin", required: true }),
      expect.objectContaining({ in: "header", name: "X-Requested-With", required: true }),
    ]));
    expect(login.responses["201"].headers).toHaveProperty("Cache-Control");
    expect(login.responses["201"].headers).toHaveProperty("Set-Cookie");
    expect(login.responses["429"].headers).toHaveProperty("Retry-After");
    expect(document.paths["/api/words"].get.responses["401"].headers).toHaveProperty("WWW-Authenticate");
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
