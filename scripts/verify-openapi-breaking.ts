import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
/** 可为「变体数组」的组合键——只有它们的纯新增是可判定的（其余组合键一律 fail-closed）。 */
const UNION_KEYS = ["oneOf", "anyOf"] as const;
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

/** 该键是否为「两侧都是变体数组」的联合键（oneOf/anyOf）。 */
function isUnionArray(base: JsonObject, current: JsonObject, key: string): boolean {
  if (!UNION_KEYS.includes(key as (typeof UNION_KEYS)[number])) return false;
  return Array.isArray(base[key]) && Array.isArray(current[key]);
}

/**
 * 变体数组的**纯新增**：base 的每个变体在 current 中仍按同一稳定序列化存在（只多不少）。
 * 变体被删或被改写都不是纯新增。
 */
function isVariantAddition(before: unknown[], after: unknown[]): boolean {
  const afterKeys = new Set(after.map((variant) => stable(variant)));
  return before.every((variant) => afterKeys.has(stable(variant)));
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
  // Unchanged schema targets cannot introduce a breaking change — skip before
  // composition keywords (oneOf/anyOf/…) trigger fail-closed UNKNOWN noise.
  if (stable(base) === stable(current)) return;
  // 组合/条件关键字仅在「自身发生变化」时才无法安全比较；两侧相同的包装键
  // （如未变化的 propertyNames / anyOf 包裹）不构成变化源，继续按常规键比较。
  // 2026-09-17（T11）：answers 收窄到显式键契约时，其 propertyNames 未变却被
  // 旧检查整体放弃（误报 UNKNOWN）；剔除误报、保留“组合键真变即 fail-closed”。
  const changedUnsupported = UNSUPPORTED_SCHEMA_KEYS.filter(
    (key) => (key in base || key in current) && stable(base[key]) !== stable(current[key]),
  );
  if (changedUnsupported.length > 0) {
    // N2（2026-09-23）：联合变体的变化在结构可比时给出**确定判定**，不再笼统 UNKNOWN——
    //   · 纯新增变体：request = 放宽（旧客户端不受影响）；response = breaking
    //     （旧客户端可能收到不认识的变体，可经重锚 approval 豁免）；
    //   · 变体数相同：逐位递归，覆盖「变体内嵌联合纯新增」（如 PUT 请求体 capture
    //     变体内的 target 联合多出评析变体）——被删改的变体递归后仍按常规键出确定判定；
    //   · 变体数变少，或同时动了其它组合/条件键（not/if/…）：无法配对 → 原 fail-closed。
    if (!changedUnsupported.every((key) => isUnionArray(base, current, key))) {
      issue(issues, "unknown", location, "受影响 schema 使用了无法安全比较的组合/条件关键字");
      return;
    }
    for (const key of changedUnsupported) {
      const before = base[key] as unknown[];
      const after = current[key] as unknown[];
      if (isVariantAddition(before, after)) {
        if (direction === "response") {
          issue(issues, "breaking", location, "response 联合新增变体（旧客户端可能无法解析）");
        }
        continue;
      }
      if (before.length !== after.length) {
        issue(issues, "unknown", location, "受影响 schema 使用了无法安全比较的组合/条件关键字");
        return;
      }
      before.forEach((variant, index) => {
        compareSchema(
          baseDocument, currentDocument, variant, after[index], direction,
          `${location}.${key}[${index}]`, issues, seen,
        );
      });
    }
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
  const baseSecuritySchemes = asObject(asObject(baseDocument.components).securitySchemes);
  const currentSecuritySchemes = asObject(asObject(currentDocument.components).securitySchemes);
  for (const name of Object.keys(baseSecuritySchemes)) {
    if (!(name in currentSecuritySchemes)) {
      issue(issues, "breaking", `components.securitySchemes.${name}`, "security scheme 被删除");
    }
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
      if (baseOperation.security !== undefined && stable(baseOperation.security) !== stable(currentOperation.security)) {
        issue(issues, "breaking", `${location}.${method}.security`, "operation security requirement 被删除或放宽");
      }
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
        else {
          const baseHeaders = asObject(baseResponse.headers);
          const currentHeaders = asObject(currentResponse.headers);
          for (const [name, baseHeaderInput] of Object.entries(baseHeaders)) {
            const baseHeader = resolveObject(baseDocument, baseHeaderInput);
            if (baseHeader?.["x-required"] === true && !(name in currentHeaders)) {
              issue(issues, "breaking", `${location}.${method}.responses.${status}.headers.${name}`, "required response header 被删除");
            }
          }
          compareContent(baseDocument, currentDocument, baseResponse.content, currentResponse.content, "response", `${location}.${method}.responses.${status}`, issues, seen);
        }
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
  // The OpenAPI snapshot is a single-line-ish document that already exceeds
  // 1.2 MB, so the 1 MiB spawnSync default silently truncates it and surfaces
  // as ENOBUFS with status=null — which reads like "git is broken" rather than
  // "the buffer is too small". Give every git read 64 MiB of headroom.
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

interface OpenApiBreakingApproval {
  version: 1;
  baseSha256: string;
  currentSha256: string;
  issues: OpenApiIssue[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseBreakingApproval(value: unknown): OpenApiBreakingApproval {
  if (!isObject(value)) throw new Error("OpenAPI breaking approval 必须是对象");
  const allowedKeys = new Set(["version", "baseSha256", "currentSha256", "issues"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("OpenAPI breaking approval 包含未知字段");
  if (value.version !== 1 || typeof value.baseSha256 !== "string" || typeof value.currentSha256 !== "string" || !Array.isArray(value.issues)) {
    throw new Error("OpenAPI breaking approval 格式无效");
  }
  const issues = value.issues.map((entry) => {
    if (!isObject(entry) || entry.kind !== "breaking" || typeof entry.location !== "string" || typeof entry.message !== "string") {
      throw new Error("OpenAPI breaking approval 只能包含明确的 breaking issue");
    }
    if (Object.keys(entry).some((key) => !new Set(["kind", "location", "message"]).has(key))) {
      throw new Error("OpenAPI breaking approval issue 包含未知字段");
    }
    return { kind: "breaking" as const, location: entry.location, message: entry.message };
  });
  const keys = issues.map((entry) => stable(entry));
  if (new Set(keys).size !== keys.length) throw new Error("OpenAPI breaking approval 包含重复 issue");
  return { version: 1, baseSha256: value.baseSha256, currentSha256: value.currentSha256, issues };
}

// 口径（2026-09-17 深测会审勘误，详见 ADR-0035 §勘误）：approval 相对 base 未变更即
// 早退（既不校验也不豁免）——常规 openapi 再生无须重钉哈希；仅当变更集修改了
// approval 文件时强制整体重锚：baseSha256 ≡ sha256(openapi@PR base)、
// currentSha256 ≡ sha256(openapi@HEAD)、issues ≡ 相对 base 的实测 breaking 集合。
function applyBreakingApproval(
  cwd: string,
  baseText: string,
  currentText: string,
  issues: OpenApiIssue[],
  baseApprovalText: string | null,
): OpenApiIssue[] {
  const approvalPath = path.join(cwd, "docs/api/openapi-breaking-approval.json");
  if (!existsSync(approvalPath)) return issues;
  const currentApprovalText = readFileSync(approvalPath, "utf8");
  if (baseApprovalText === currentApprovalText) return issues;
  const approval = parseBreakingApproval(JSON.parse(currentApprovalText));
  if (issues.some((entry) => entry.kind === "unknown")) throw new Error("OpenAPI unknown change 不可通过 approval 豁免");
  if (approval.baseSha256 !== sha256(baseText) || approval.currentSha256 !== sha256(currentText)) {
    throw new Error("OpenAPI breaking approval 与基线或当前快照哈希不匹配");
  }
  const actual = issues.map((entry) => stable(entry)).sort();
  const approved = approval.issues.map((entry) => stable(entry)).sort();
  if (stable(actual) !== stable(approved)) throw new Error("OpenAPI breaking approval 与实际 issue 集合不完全一致");
  return [];
}

export function runOpenApiBreakingGate(
  cwd = process.cwd(),
  baseRef = process.env.API_CONTRACT_BASE_REF ?? "origin/main",
  loadBase: BaseSnapshotLoader = loadBaseSnapshot,
): OpenApiIssue[] {
  const snapshotPath = "docs/api/openapi.json";
  const approvalPath = "docs/api/openapi-breaking-approval.json";
  const currentText = readFileSync(path.join(cwd, snapshotPath), "utf8");
  const baseText = loadBase(baseRef, snapshotPath, cwd);
  if (baseText === null) {
    console.log(`[openapi-breaking] BOOTSTRAP — ${baseRef} 不含 ${snapshotPath}`);
    return [];
  }
  const issues = compareOpenApiDocuments(JSON.parse(baseText), JSON.parse(currentText));
  const baseApprovalText = loadBase(baseRef, approvalPath, cwd);
  return applyBreakingApproval(cwd, baseText, currentText, issues, baseApprovalText);
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
