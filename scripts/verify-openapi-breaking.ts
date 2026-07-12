import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface OpenApiIssue {
  kind: "breaking" | "unknown";
  location: string;
  message: string;
}

type JsonObject = Record<string, unknown>;
type Direction = "request" | "response";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const UNSUPPORTED_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else", "dependentSchemas", "unevaluatedProperties", "propertyNames"] as const;
const LOWER_BOUND_KEYS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"] as const;
const UPPER_BOUND_KEYS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"] as const;
const FAIL_CLOSED_ON_CHANGE_KEYS = [
  "format",
  "multipleOf",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
] as const;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function resolveSchema(document: JsonObject, schema: unknown): JsonObject | null {
  if (!isObject(schema)) return null;
  if (typeof schema.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/")) return null;
  let current: unknown = document;
  for (const rawPart of schema.$ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current) || !(part in current)) return null;
    current = current[part];
  }
  return isObject(current) ? current : null;
}

function issue(issues: OpenApiIssue[], kind: OpenApiIssue["kind"], location: string, message: string): void {
  issues.push({ kind, location, message });
}

function compareSchema(
  baseDocument: JsonObject,
  currentDocument: JsonObject,
  baseInput: unknown,
  currentInput: unknown,
  direction: Direction,
  location: string,
  issues: OpenApiIssue[],
  seen: Set<string>,
): void {
  if (stable(baseInput) === stable(currentInput)) {
    const sameReference = isObject(baseInput) && typeof baseInput.$ref === "string";
    if (!sameReference) return;
  }
  const pair = `${direction}:${location}:${stable(baseInput)}=>${stable(currentInput)}`;
  if (seen.has(pair)) return;
  seen.add(pair);

  const base = resolveSchema(baseDocument, baseInput);
  const current = resolveSchema(currentDocument, currentInput);
  if (!base || !current) {
    issue(issues, "unknown", location, "schema 无法解析（仅支持有效的本地 $ref）");
    return;
  }
  if (UNSUPPORTED_SCHEMA_KEYS.some((key) => key in base || key in current)) {
    issue(issues, "unknown", location, "受影响 schema 使用了无法安全比较的组合/条件关键字");
    return;
  }

  if (stable(base.type) !== stable(current.type)) {
    issue(issues, "breaking", location, "schema type 发生变化");
  }

  const baseEnum = Array.isArray(base.enum) ? base.enum : null;
  const currentEnum = Array.isArray(current.enum) ? current.enum : null;
  if (direction === "request") {
    if (currentEnum && (!baseEnum || baseEnum.some((entry) => !currentEnum.some((candidate) => stable(candidate) === stable(entry))))) {
      issue(issues, "breaking", location, "request enum 允许值被收窄");
    }
  } else if (baseEnum && !currentEnum) {
    issue(issues, "breaking", location, "response enum 约束被删除");
  } else if (currentEnum && baseEnum && currentEnum.some((entry) => !baseEnum.some((candidate) => stable(candidate) === stable(entry)))) {
    issue(issues, "breaking", location, "response enum 新增未声明值");
  }

  if (base.const !== undefined && stable(base.const) !== stable(current.const)) {
    issue(issues, "breaking", location, "schema const 发生变化");
  } else if (base.const === undefined && current.const !== undefined && direction === "request") {
    issue(issues, "breaking", location, "request 新增 const 限制");
  }
  if (stable(base.pattern) !== stable(current.pattern) && (base.pattern !== undefined || current.pattern !== undefined)) {
    issue(issues, "unknown", location, "pattern 变化无法安全判定兼容性");
  }
  for (const key of FAIL_CLOSED_ON_CHANGE_KEYS) {
    if (stable(base[key]) !== stable(current[key]) && (base[key] !== undefined || current[key] !== undefined)) {
      issue(issues, "unknown", location, `${key} 变化无法安全判定兼容性`);
    }
  }
  for (const key of LOWER_BOUND_KEYS) {
    const before = typeof base[key] === "number" ? base[key] : null;
    const after = typeof current[key] === "number" ? current[key] : null;
    if (direction === "request" && after !== null && (before === null || after > before)) issue(issues, "breaking", location, `request ${key} 收紧`);
    if (direction === "response" && before !== null && (after === null || after < before)) issue(issues, "breaking", location, `response ${key} 放宽`);
  }
  for (const key of UPPER_BOUND_KEYS) {
    const before = typeof base[key] === "number" ? base[key] : null;
    const after = typeof current[key] === "number" ? current[key] : null;
    if (direction === "request" && after !== null && (before === null || after < before)) issue(issues, "breaking", location, `request ${key} 收紧`);
    if (direction === "response" && before !== null && (after === null || after > before)) issue(issues, "breaking", location, `response ${key} 放宽`);
  }
  if (direction === "request" && base.additionalProperties !== false && current.additionalProperties === false) {
    issue(issues, "breaking", location, "request additionalProperties 被禁止");
  }
  if (direction === "response" && base.additionalProperties === false && current.additionalProperties !== false) {
    issue(issues, "breaking", location, "response additionalProperties 被放宽");
  }

  const baseProperties = isObject(base.properties) ? base.properties : {};
  const currentProperties = isObject(current.properties) ? current.properties : {};
  const baseRequired = new Set(Array.isArray(base.required) ? base.required.filter((v): v is string => typeof v === "string") : []);
  const currentRequired = new Set(Array.isArray(current.required) ? current.required.filter((v): v is string => typeof v === "string") : []);

  if (direction === "request") {
    for (const name of currentRequired) {
      if (!baseRequired.has(name)) issue(issues, "breaking", `${location}.properties.${name}`, "新增 required request field");
    }
  } else {
    for (const name of baseRequired) {
      if (!currentRequired.has(name) || !(name in currentProperties)) {
        issue(issues, "breaking", `${location}.properties.${name}`, "删除 required response field");
      }
    }
  }

  for (const name of Object.keys(baseProperties)) {
    if (!(name in currentProperties)) {
      if (direction === "request") {
        issue(issues, "breaking", `${location}.properties.${name}`, "删除 request field");
      }
      continue;
    }
    compareSchema(baseDocument, currentDocument, baseProperties[name], currentProperties[name], direction, `${location}.properties.${name}`, issues, seen);
  }

  if (base.items !== undefined || current.items !== undefined) {
    if (base.items === undefined || current.items === undefined) {
      issue(issues, "unknown", `${location}.items`, "数组 items 结构无法安全比较");
    } else {
      compareSchema(baseDocument, currentDocument, base.items, current.items, direction, `${location}.items`, issues, seen);
    }
  }
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function compareContent(
  baseDocument: JsonObject,
  currentDocument: JsonObject,
  baseContentInput: unknown,
  currentContentInput: unknown,
  direction: Direction,
  location: string,
  issues: OpenApiIssue[],
  seen: Set<string>,
): void {
  const baseContent = asObject(baseContentInput);
  const currentContent = asObject(currentContentInput);
  for (const [mediaType, baseMediaInput] of Object.entries(baseContent)) {
    const currentMediaInput = currentContent[mediaType];
    if (currentMediaInput === undefined) {
      issue(issues, "unknown", `${location}.content.${mediaType}`, "原有 media type 被删除，无法安全比较 schema");
      continue;
    }
    const baseMedia = asObject(baseMediaInput);
    const currentMedia = asObject(currentMediaInput);
    if (baseMedia.schema !== undefined || currentMedia.schema !== undefined) {
      compareSchema(baseDocument, currentDocument, baseMedia.schema, currentMedia.schema, direction, `${location}.content.${mediaType}.schema`, issues, seen);
    }
  }
}

function parameterKey(parameter: JsonObject): string | null {
  return typeof parameter.name === "string" && typeof parameter.in === "string" ? `${parameter.in}:${parameter.name}` : null;
}

function resolveObject(document: JsonObject, input: unknown): JsonObject | null {
  return resolveSchema(document, input);
}

function compareParameters(
  baseDocument: JsonObject,
  currentDocument: JsonObject,
  baseInputs: unknown[],
  currentInputs: unknown[],
  location: string,
  issues: OpenApiIssue[],
  seen: Set<string>,
): void {
  const base = new Map<string, JsonObject>();
  const current = new Map<string, JsonObject>();
  for (const input of baseInputs) {
    const parameter = resolveObject(baseDocument, input);
    const key = parameter && parameterKey(parameter);
    if (!parameter || !key) issue(issues, "unknown", location, "base parameter 无法安全解析");
    else base.set(key, parameter);
  }
  for (const input of currentInputs) {
    const parameter = resolveObject(currentDocument, input);
    const key = parameter && parameterKey(parameter);
    if (!parameter || !key) issue(issues, "unknown", location, "current parameter 无法安全解析");
    else current.set(key, parameter);
  }
  for (const key of base.keys()) {
    if (!current.has(key)) {
      issue(issues, "breaking", `${location}.parameters.${key}`, "删除 request parameter");
    }
  }
  for (const [key, parameter] of current) {
    const previous = base.get(key);
    if (parameter.required === true && (!previous || previous.required !== true)) {
      issue(issues, "breaking", `${location}.parameters.${key}`, "新增 required request parameter");
    }
    if (previous && (previous.schema !== undefined || parameter.schema !== undefined)) {
      compareSchema(baseDocument, currentDocument, previous.schema, parameter.schema, "request", `${location}.parameters.${key}.schema`, issues, seen);
    }
  }
}

export function compareOpenApiDocuments(baseDocument: unknown, currentDocument: unknown): OpenApiIssue[] {
  const issues: OpenApiIssue[] = [];
  if (!isObject(baseDocument) || !isObject(currentDocument)) return [{ kind: "unknown", location: "$", message: "OpenAPI 文档不是对象" }];
  if (typeof baseDocument.openapi !== "string" || typeof currentDocument.openapi !== "string") {
    return [{ kind: "unknown", location: "$.openapi", message: "缺少 OpenAPI 版本" }];
  }
  const basePaths = asObject(baseDocument.paths);
  const currentPaths = asObject(currentDocument.paths);
  const seen = new Set<string>();

  for (const [pathName, basePathInput] of Object.entries(basePaths)) {
    const location = `paths.${pathName}`;
    if (!(pathName in currentPaths)) {
      issue(issues, "breaking", location, "path 被删除");
      continue;
    }
    const basePath = asObject(basePathInput);
    const currentPath = asObject(currentPaths[pathName]);
    for (const method of HTTP_METHODS) {
      if (!(method in basePath)) continue;
      if (!(method in currentPath)) {
        issue(issues, "breaking", `${location}.${method}`, "HTTP method 被删除");
        continue;
      }
      const baseOperation = asObject(basePath[method]);
      const currentOperation = asObject(currentPath[method]);
      const baseParameters = [...(Array.isArray(basePath.parameters) ? basePath.parameters : []), ...(Array.isArray(baseOperation.parameters) ? baseOperation.parameters : [])];
      const currentParameters = [...(Array.isArray(currentPath.parameters) ? currentPath.parameters : []), ...(Array.isArray(currentOperation.parameters) ? currentOperation.parameters : [])];
      compareParameters(baseDocument, currentDocument, baseParameters, currentParameters, `${location}.${method}`, issues, seen);

      const baseRequestBody = resolveObject(baseDocument, baseOperation.requestBody);
      const currentRequestBody = resolveObject(currentDocument, currentOperation.requestBody);
      if (currentRequestBody?.required === true && baseRequestBody?.required !== true) {
        issue(issues, "breaking", `${location}.${method}.requestBody`, "request body 新增 required");
      }
      if (baseOperation.requestBody !== undefined && currentOperation.requestBody === undefined) {
        // Removing request input is not treated as breaking for callers.
      } else if (baseOperation.requestBody !== undefined || currentOperation.requestBody !== undefined) {
        if (!baseRequestBody || !currentRequestBody) issue(issues, "unknown", `${location}.${method}.requestBody`, "request body 无法安全解析");
        else compareContent(baseDocument, currentDocument, baseRequestBody.content, currentRequestBody.content, "request", `${location}.${method}.requestBody`, issues, seen);
      }

      const baseResponses = asObject(baseOperation.responses);
      const currentResponses = asObject(currentOperation.responses);
      for (const [status, baseResponseInput] of Object.entries(baseResponses)) {
        if (!(status in currentResponses)) {
          issue(issues, "breaking", `${location}.${method}.responses.${status}`, "response status 被删除");
          continue;
        }
        const baseResponse = resolveObject(baseDocument, baseResponseInput);
        const currentResponse = resolveObject(currentDocument, currentResponses[status]);
        if (!baseResponse || !currentResponse) issue(issues, "unknown", `${location}.${method}.responses.${status}`, "response 无法安全解析");
        else compareContent(baseDocument, currentDocument, baseResponse.content, currentResponse.content, "response", `${location}.${method}.responses.${status}`, issues, seen);
      }
    }
  }
  return issues;
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GitRunner = (args: string[], cwd: string) => GitResult;

const runGit: GitRunner = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
};

export function loadBaseSnapshot(baseRef: string, snapshotPath: string, cwd = process.cwd(), git: GitRunner = runGit): string | null {
  const normalizedPath = snapshotPath.replaceAll(path.sep, "/");
  const baseExists = git(["rev-parse", "--verify", `${baseRef}^{commit}`], cwd);
  if (baseExists.error) throw baseExists.error;
  if (baseExists.status !== 0) {
    throw new Error((baseExists.stderr || baseExists.stdout || `base ref 不存在：${baseRef}`).trim());
  }

  const tree = git(["ls-tree", "--name-only", baseRef, "--", normalizedPath], cwd);
  if (tree.error) throw tree.error;
  if (tree.status !== 0) {
    throw new Error((tree.stderr || tree.stdout || `无法检查 base 快照：${normalizedPath}`).trim());
  }
  if (tree.stdout.trim() === "") return null;

  const result = git(["show", `${baseRef}:${normalizedPath}`], cwd);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git show 失败（exit ${result.status ?? "unknown"}）`).trim());
  }
  return result.stdout;
}

export type BaseSnapshotLoader = (baseRef: string, snapshotPath: string, cwd: string) => string | null;

export function runOpenApiBreakingGate(
  cwd = process.cwd(),
  baseRef = process.env.API_CONTRACT_BASE_REF ?? "origin/main",
  loadBase: BaseSnapshotLoader = loadBaseSnapshot,
): OpenApiIssue[] {
  const snapshotPath = "docs/api/openapi.json";
  const currentText = readFileSync(path.join(cwd, snapshotPath), "utf8");
  const baseText = loadBase(baseRef, snapshotPath, cwd);
  if (baseText === null) {
    console.log(`[openapi-breaking] BOOTSTRAP — ${baseRef} 不含 ${snapshotPath}`);
    return [];
  }
  return compareOpenApiDocuments(JSON.parse(baseText), JSON.parse(currentText));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const issues = runOpenApiBreakingGate();
    if (issues.length > 0) {
      for (const entry of issues) console.error(`[openapi-breaking] ${entry.kind.toUpperCase()} ${entry.location}: ${entry.message}`);
      process.exitCode = 1;
    } else {
      console.log("[openapi-breaking] OK — 未发现 breaking change");
    }
  } catch (error) {
    console.error(`[openapi-breaking] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
