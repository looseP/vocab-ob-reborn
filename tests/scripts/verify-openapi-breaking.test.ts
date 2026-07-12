import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareOpenApiDocuments,
  loadBaseSnapshot,
  runOpenApiBreakingGate,
  type GitResult,
  type GitRunner,
} from "../../scripts/verify-openapi-breaking";

function document(schema: Record<string, unknown> = { type: "object" }): Record<string, any> {
  return {
    openapi: "3.1.0",
    paths: {
      "/words": {
        post: {
          requestBody: { content: { "application/json": { schema } } },
          responses: {
            "200": { description: "ok", content: { "application/json": { schema } } },
            "400": { description: "bad request" },
          },
        },
      },
    },
  };
}

function messages(base: unknown, current: unknown) {
  return compareOpenApiDocuments(base, current).map((entry) => entry.message);
}

function gitResult(status: number | null, stdout = "", stderr = "", error?: Error): GitResult {
  return { status, stdout, stderr, error };
}

function sequenceGit(...results: GitResult[]): GitRunner {
  let index = 0;
  return () => results[index++] ?? gitResult(1, "", "unexpected git call");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("compareOpenApiDocuments", () => {
  it("接受不收窄合同的变更", () => {
    const base = document({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
    const current = structuredClone(base);
    current.paths["/words"].post.responses["201"] = { description: "created" };
    expect(compareOpenApiDocuments(base, current)).toEqual([]);
  });

  it("检测删除 path、method 和 response status", () => {
    const base = document();
    const withoutPath = structuredClone(base);
    withoutPath.paths = {} as typeof withoutPath.paths;
    expect(messages(base, withoutPath)).toContain("path 被删除");

    const withoutMethod = structuredClone(base);
    delete (withoutMethod.paths["/words"] as Partial<typeof base.paths["/words"]>).post;
    expect(messages(base, withoutMethod)).toContain("HTTP method 被删除");

    const withoutStatus = structuredClone(base);
    delete withoutStatus.paths["/words"].post.responses["400"];
    expect(messages(base, withoutStatus)).toContain("response status 被删除");
  });

  it("检测 request schema 新增 required field", () => {
    const base = document({ type: "object", properties: { term: { type: "string" } } });
    const current = document({ type: "object", properties: { term: { type: "string" } }, required: ["term"] });
    expect(messages(base, current)).toContain("新增 required request field");
  });

  it("检测新增 required parameter 和删除已有可选 parameter", () => {
    const base = document();
    const current = structuredClone(base);
    current.paths["/words"].post.parameters = [{ in: "query", name: "lang", required: true, schema: { type: "string" } }];
    expect(messages(base, current)).toContain("新增 required request parameter");

    const withOptional = document();
    withOptional.paths["/words"].post.parameters = [{ in: "query", name: "q", required: false, schema: { type: "string" } }];
    const removed = structuredClone(withOptional);
    removed.paths["/words"].post.parameters = [];
    expect(messages(withOptional, removed)).toContain("删除 request parameter");
  });

  it("检测 enum 收窄和 type 变化", () => {
    const base = document({ type: "string", enum: ["a", "b"] });
    const narrowed = document({ type: "string", enum: ["a"] });
    expect(messages(base, narrowed)).toContain("request enum 允许值被收窄");

    const changed = document({ type: "number" });
    expect(messages(base, changed)).toContain("schema type 发生变化");
  });

  it("检测请求约束收紧和响应约束放宽", () => {
    const requestBase = document({ type: "string", minLength: 1, maxLength: 20 });
    const requestCurrent = document({ type: "string", minLength: 2, maxLength: 10 });
    expect(messages(requestBase, requestCurrent)).toEqual(expect.arrayContaining(["request minLength 收紧", "request maxLength 收紧"]));

    const responseBase = document({ type: "string", minLength: 2, maxLength: 10 });
    const responseCurrent = structuredClone(responseBase);
    responseCurrent.paths["/words"].post.requestBody.content["application/json"].schema = responseBase.paths["/words"].post.requestBody.content["application/json"].schema;
    responseCurrent.paths["/words"].post.responses["200"].content["application/json"].schema = { type: "string", minLength: 1, maxLength: 20 };
    const responseMessages = compareOpenApiDocuments(responseBase, responseCurrent)
      .filter((entry) => entry.location.includes("responses.200"))
      .map((entry) => entry.message);
    expect(responseMessages).toEqual(expect.arrayContaining(["response minLength 放宽", "response maxLength 放宽"]));
  });

  it("将 pattern、format 和未建模数组约束变化视为 fail-closed", () => {
    expect(compareOpenApiDocuments(document({ type: "string", pattern: "^a" }), document({ type: "string", pattern: "^b" })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", message: expect.stringContaining("pattern") })]));
    expect(compareOpenApiDocuments(document({ type: "string", format: "email" }), document({ type: "string", format: "uuid" })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", message: expect.stringContaining("format") })]));
    expect(compareOpenApiDocuments(document({ type: "array", uniqueItems: false }), document({ type: "array", uniqueItems: true })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", message: expect.stringContaining("uniqueItems") })]));
  });

  it("检测响应 enum 扩大或约束删除", () => {
    const base = document({ type: "string", enum: ["a"] });
    const expanded = structuredClone(base);
    expanded.paths["/words"].post.requestBody.content["application/json"].schema = base.paths["/words"].post.requestBody.content["application/json"].schema;
    expanded.paths["/words"].post.responses["200"].content["application/json"].schema = { type: "string", enum: ["a", "b"] };
    expect(compareOpenApiDocuments(base, expanded).some((entry) => entry.message === "response enum 新增未声明值")).toBe(true);

    const unconstrained = structuredClone(base);
    unconstrained.paths["/words"].post.requestBody.content["application/json"].schema = base.paths["/words"].post.requestBody.content["application/json"].schema;
    unconstrained.paths["/words"].post.responses["200"].content["application/json"].schema = { type: "string" };
    expect(compareOpenApiDocuments(base, unconstrained).some((entry) => entry.message === "response enum 约束被删除")).toBe(true);
  });

  it("检测删除可选 request field", () => {
    const base = document({ type: "object", properties: { legacy: { type: "string" } }, additionalProperties: false });
    const current = document({ type: "object", properties: {}, additionalProperties: false });
    expect(messages(base, current)).toContain("删除 request field");
  });

  it("检测删除 required response field", () => {
    const base = document({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
    const current = document({ type: "object", properties: {} });
    expect(messages(base, current)).toContain("删除 required response field");
  });

  it("解析 components 中的本地 ref", () => {
    const base = document({ $ref: "#/components/schemas/Word" });
    const current = structuredClone(base);
    Object.assign(base, { components: { schemas: { Word: { type: "string", enum: ["a", "b"] } } } });
    Object.assign(current, { components: { schemas: { Word: { type: "string", enum: ["a"] } } } });
    expect(messages(base, current)).toContain("request enum 允许值被收窄");
  });

  it("对无法安全识别的受影响 schema fail-closed", () => {
    const base = document({ oneOf: [{ type: "string" }, { type: "number" }] });
    const current = document({ oneOf: [{ type: "string" }] });
    const issues = compareOpenApiDocuments(base, current);
    expect(issues.some((entry) => entry.kind === "unknown" && entry.message.includes("无法安全比较"))).toBe(true);
  });

  it("未变化的复杂 schema 不会误报", () => {
    const base = document({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(compareOpenApiDocuments(base, structuredClone(base))).toEqual([]);
  });

  it("检测删除 required response header", () => {
    const base = document();
    base.paths["/words"].post.responses["200"].headers = {
      "Cache-Control": { "x-required": true, schema: { type: "string" } },
    };
    const current = structuredClone(base);
    delete current.paths["/words"].post.responses["200"].headers["Cache-Control"];
    expect(messages(base, current)).toContain("required response header 被删除");
  });

  it("检测删除 security scheme 和放宽 operation security", () => {
    const base = document();
    Object.assign(base, {
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          sessionCookie: { type: "apiKey", in: "cookie", name: "vocab_session" },
        },
      },
    });
    base.paths["/words"].post.security = [{ bearerAuth: [] }, { sessionCookie: [] }];

    const withoutScheme = structuredClone(base);
    delete withoutScheme.components.securitySchemes.sessionCookie;
    expect(messages(base, withoutScheme)).toContain("security scheme 被删除");

    const publicOperation = structuredClone(base);
    publicOperation.paths["/words"].post.security = [];
    expect(messages(base, publicOperation)).toContain("operation security requirement 被删除或放宽");
  });
});

describe("loadBaseSnapshot", () => {
  it("base commit 存在且确实无快照时允许 bootstrap", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-git-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "OpenAPI Test"], { cwd: root });
    writeFileSync(path.join(root, "README"), "bootstrap");
    execFileSync("git", ["add", "README"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "base without snapshot"], { cwd: root });
    expect(loadBaseSnapshot("HEAD", "docs/api/openapi.json", root)).toBeNull();
  });

  it("读取存在的 base 快照", () => {
    const json = JSON.stringify(document());
    const git = sequenceGit(
      gitResult(0, "base-sha"),
      gitResult(0, "docs/api/openapi.json\n"),
      gitResult(0, json),
    );
    expect(loadBaseSnapshot("base", "docs/api/openapi.json", ".", git)).toBe(json);
  });

  it("坏 ref 必须 fail-closed", () => {
    const git = sequenceGit(gitResult(128, "", "unknown revision"));
    expect(() => loadBaseSnapshot("bad-ref", "docs/api/openapi.json", ".", git)).toThrow("unknown revision");
  });

  it("非 git 仓库必须 fail-closed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-not-git-"));
    expect(() => loadBaseSnapshot("base", "docs/api/openapi.json", root)).toThrow("not a git repository");
  });

  it("git 启动或权限错误必须 fail-closed", () => {
    const denied = Object.assign(new Error("spawn git EACCES"), { code: "EACCES" });
    expect(() => loadBaseSnapshot("base", "docs/api/openapi.json", ".", sequenceGit(gitResult(null, "", "", denied)))).toThrow("EACCES");
  });

  it("路径检查失败时必须 fail-closed", () => {
    const git = sequenceGit(
      gitResult(0, "base-sha"),
      gitResult(128, "", "fatal: unable to read tree"),
    );
    expect(() => loadBaseSnapshot("base", "docs/api/openapi.json", ".", git)).toThrow("unable to read tree");
  });

  it("路径存在但 git show 失败时必须 fail-closed", () => {
    const git = sequenceGit(
      gitResult(0, "base-sha"),
      gitResult(0, "docs/api/openapi.json\n"),
      gitResult(128, "", "fatal: unable to read object"),
    );
    expect(() => loadBaseSnapshot("base", "docs/api/openapi.json", ".", git)).toThrow("unable to read object");
  });
});

describe("runOpenApiBreakingGate", () => {
  it("只在 loader 明确确认 base 无快照时 bootstrap", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-gate-"));
    mkdirSync(path.join(root, "docs", "api"), { recursive: true });
    writeFileSync(path.join(root, "docs", "api", "openapi.json"), JSON.stringify(document()));
    expect(runOpenApiBreakingGate(root, "base", () => null)).toEqual([]);
  });

  it("只接受与基线和当前快照精确绑定的 breaking approval", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-gate-"));
    mkdirSync(path.join(root, "docs", "api"), { recursive: true });
    const base = JSON.stringify(document());
    const currentDocument = document();
    currentDocument.paths["/words"].post.parameters = [{ in: "header", name: "Origin", required: true, schema: { type: "string" } }];
    const current = JSON.stringify(currentDocument);
    writeFileSync(path.join(root, "docs", "api", "openapi.json"), current);
    writeFileSync(path.join(root, "docs", "api", "openapi-breaking-approval.json"), JSON.stringify({
      version: 1,
      baseSha256: sha256(base),
      currentSha256: sha256(current),
      issues: [{
        kind: "breaking",
        location: "paths./words.post.parameters.header:Origin",
        message: "新增 required request parameter",
      }],
    }));
    expect(runOpenApiBreakingGate(root, "base", (baseRef, snapshotPath) => snapshotPath.endsWith("openapi.json") ? base : null)).toEqual([]);
  });

  it("基线已有且未修改的 approval 不会继续豁免后续 breaking change", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-gate-"));
    mkdirSync(path.join(root, "docs", "api"), { recursive: true });
    const base = JSON.stringify(document());
    const currentDocument = document();
    currentDocument.paths["/words"].post.parameters = [{ in: "header", name: "Origin", required: true, schema: { type: "string" } }];
    const current = JSON.stringify(currentDocument);
    const approval = JSON.stringify({ version: 1, baseSha256: sha256(base), currentSha256: sha256(current), issues: [] });
    writeFileSync(path.join(root, "docs", "api", "openapi.json"), current);
    writeFileSync(path.join(root, "docs", "api", "openapi-breaking-approval.json"), approval);
    expect(runOpenApiBreakingGate(root, "base", (baseRef, snapshotPath) => snapshotPath.endsWith("openapi.json") ? base : approval)).toEqual([
      expect.objectContaining({ kind: "breaking", location: "paths./words.post.parameters.header:Origin" }),
    ]);
  });

  it("拒绝缺失、多余或哈希不匹配的 approval", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-gate-"));
    mkdirSync(path.join(root, "docs", "api"), { recursive: true });
    const base = JSON.stringify(document());
    const currentDocument = document();
    currentDocument.paths["/words"].post.parameters = [{ in: "header", name: "Origin", required: true, schema: { type: "string" } }];
    const current = JSON.stringify(currentDocument);
    writeFileSync(path.join(root, "docs", "api", "openapi.json"), current);
    writeFileSync(path.join(root, "docs", "api", "openapi-breaking-approval.json"), JSON.stringify({
      version: 1,
      baseSha256: "0".repeat(64),
      currentSha256: sha256(current),
      issues: [],
    }));
    expect(() => runOpenApiBreakingGate(root, "base", (baseRef, snapshotPath) => snapshotPath.endsWith("openapi.json") ? base : null)).toThrow(/approval/);
  });

  it("unknown 变化不可被 approval 豁免", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-gate-"));
    mkdirSync(path.join(root, "docs", "api"), { recursive: true });
    const baseDocument = document({ type: "string", pattern: "^a" });
    const currentDocument = document({ type: "string", pattern: "^b" });
    const base = JSON.stringify(baseDocument);
    const current = JSON.stringify(currentDocument);
    writeFileSync(path.join(root, "docs", "api", "openapi.json"), current);
    writeFileSync(path.join(root, "docs", "api", "openapi-breaking-approval.json"), JSON.stringify({
      version: 1,
      baseSha256: sha256(base),
      currentSha256: sha256(current),
      issues: [{ kind: "unknown", location: "x", message: "y" }],
    }));
    expect(() => runOpenApiBreakingGate(root, "base", (baseRef, snapshotPath) => snapshotPath.endsWith("openapi.json") ? base : null)).toThrow(/只能包含明确的 breaking issue|unknown/);
  });

  it("传播 base loader 错误而不是 bootstrap", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openapi-gate-"));
    mkdirSync(path.join(root, "docs", "api"), { recursive: true });
    writeFileSync(path.join(root, "docs", "api", "openapi.json"), JSON.stringify(document()));
    expect(() => runOpenApiBreakingGate(root, "bad-ref", () => { throw new Error("bad base ref"); })).toThrow("bad base ref");
  });
});
