import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiOperations } from "@/http/operations";
import { resolveMinRole } from "@/http/middleware/api-authorization";

// 本套件钉住两层含义：
//
// (1) 数据库层不再是 L2 缓存 RPC 的边界。drizzle-release/0018 把
//     refresh_l2_cache / finalize_l2_content_hash 从"actor 必须持有该词的
//     user_word_l2_progress 行"放宽为"任何已认证 actor"，以支持 Phase G 的
//     content-first 候选流。真正的安全边界是 HTTP 层：src/http/server.ts 在
//     /api/* 上挂一个鉴权中间件，且所有受保护 /api 路由都注册在该挂载之后。
//     这条 RPC 放宽的事实是本测试存在的理由，不得删除。
//
// (2) 门禁已从"粗粒度 owner"升级为"按端点最小角色"（ADR-0029 决策 1/2 / T13a），
//     因此"注册表即真源"：每条 /api/* 的 minRole 由 src/http/operations.ts 声明，
//     运行时经 method+模板查找表消费。任何路由的最小角色都必须与注册表一致。
//
// 仍以文本方式读取 server.ts：createApp() 需要完整 Services 图，而这里要钉的
// 是"注册顺序 + 单一挂载点"这类纯文件结构不变量。

const SERVER_SOURCE_PATH = fileURLToPath(new URL("../../src/http/server.ts", import.meta.url));

// 浏览器会话兑换必须在受保护中间件之前，所以 /api/auth 是唯一被允许提前注册的
// /api 路由；其余 /api 路由必须位于该挂载之后。
const ROUTES_ALLOWED_BEFORE_AUTH_MOUNT = new Set<string>(["/api/auth"]);

// 锚定在行首的活代码（非注释），因此被注释掉的挂载无法通过断言。
const AUTH_MOUNT_PATTERN = /^\s*app\.use\(\s*["']\/api\/\*["']\s*,\s*authMiddleware\(/;
const API_ROUTE_PATTERN = /app\.(?:route|get|post|put|patch|delete)\(\s*["'](\/api\/[^"']*)["']/;

// 只在活代码行上匹配：先看行首 token 判断注释，而不是剥掉 "//"（后者会破坏
// 像 "https://..." 这样的字符串字面量）。
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

const lines = readFileSync(SERVER_SOURCE_PATH, "utf8").split(/\r?\n/);

const authMountIndexes = lines.reduce<number[]>((indexes, line, index) => {
  if (!isCommentLine(line) && AUTH_MOUNT_PATTERN.test(line)) indexes.push(index);
  return indexes;
}, []);
const authMountIndex = authMountIndexes[0] ?? -1;

const apiRoutes = lines.flatMap((line, index) => {
  if (isCommentLine(line)) return [];
  const match = line.match(API_ROUTE_PATTERN);
  return match ? [{ path: match[1], index }] : [];
});

// 触及被放宽 RPC（refresh_l2_cache / finalize_l2_content_hash）的端点必须是 owner-only：
// 数据层不再拦，HTTP 层是唯一边界（见头注释 (1)）。
const BOUNDARY_ROUTES_REACHING_RELAXED_L2_RPC = [
  "confirmL2Draft",
  "acceptL2Candidate",
  "deactivateL2ContentRow",
  "deleteL2ContentRow",
  "removeL2ContentRowItem",
  "hideL2ContentRowItem",
  "restoreL2ContentRowItem",
] as const;

describe("src/http/server.ts route authorization ordering", () => {
  it("mounts exactly one auth middleware on /api/* (single mount point)", () => {
    expect(authMountIndexes.length).toBe(1);
    const mountLine = lines[authMountIndex];
    // 必须是活代码，不能是注释掉的挂载——被禁用的守卫正是本套件要抓的回归。
    expect(isCommentLine(mountLine)).toBe(false);
    expect(mountLine).toContain("authMiddleware(");
    expect(mountLine).toContain("resolveMinRole(");
  });

  it("registers every governed /api route strictly after the auth mount", () => {
    expect(authMountIndex).toBeGreaterThanOrEqual(0);
    expect(apiRoutes.length).toBeGreaterThan(0);

    const aheadOfMount = apiRoutes.filter((route) => route.index < authMountIndex);
    const illegal = aheadOfMount
      .map((route) => route.path)
      .filter((path) => !ROUTES_ALLOWED_BEFORE_AUTH_MOUNT.has(path));
    expect(illegal).toEqual([]);
  });

  it("mounts /api/l2 (relaxed-RPC boundary) behind the auth guard", () => {
    expect(authMountIndex).toBeGreaterThanOrEqual(0);
    const l2Routes = apiRoutes.filter((route) => route.path === "/api/l2");
    expect(l2Routes.length).toBeGreaterThan(0);
    for (const route of l2Routes) {
      expect(route.index).toBeGreaterThan(authMountIndex);
    }
  });

  it("keeps every relaxed-RPC boundary endpoint owner-only in the registry", () => {
    const byId = new Map(apiOperations.map((operation) => [operation.operationId, operation]));
    for (const operationId of BOUNDARY_ROUTES_REACHING_RELAXED_L2_RPC) {
      const operation = byId.get(operationId);
      expect(operation, operationId).toBeDefined();
      expect(operation?.minRole, operationId).toBe("owner");
    }
  });
});

describe("registry is the single source of truth for /api/* minRole", () => {
  it("resolves every governed /api/* operation to exactly its declared minRole", () => {
    for (const operation of apiOperations) {
      if (!operation.path.startsWith("/api/")) continue;
      if (operation.path.startsWith("/api/auth")) continue; // 豁免组，由路由自持
      const concrete = operation.path.replace(/:[A-Za-z0-9_]+/g, "sample");
      expect(resolveMinRole(operation.method, concrete), operation.operationId).toBe(operation.minRole);
    }
  });

  it("fails closed to owner outside the declared table", () => {
    expect(resolveMinRole("get", "/api/not-registered")).toBe("owner");
  });
});
