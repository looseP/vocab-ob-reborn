import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { HttpMethod } from "../src/http/operations";

export interface SourceRoute {
  method: HttpMethod;
  path: string;
}

const ROUTE_METHODS = new Set<HttpMethod>(["get", "post", "put", "patch", "delete"]);
const MOUNT = /app\.route\(\s*["']([^"']+)["']\s*,\s*(\w+)\(/g;
const IMPORT = /import\s*\{([^}]+)\}\s*from\s*["']\.\/routes\/([^"']+)["']/g;
/** 组合器模块内的相对导入（./contexts 等），用于递归解析嵌套挂载。 */
const RELATIVE_IMPORT = /import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g;

function joinRoute(prefix: string, route: string): string {
  const joined = `${prefix}/${route}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

export function extractStaticRoutes(source: string, fileName: string, prefix = ""): SourceRoute[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes: SourceRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "app") {
      const parent = node.parent;
      const allowed = (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isPropertyAccessExpression(parent) && parent.expression === node)
        || (ts.isElementAccessExpression(parent) && parent.expression === node)
        || (ts.isReturnStatement(parent) && parent.expression === node);
      if (!allowed) throw new Error(`${fileName}: aliasing or passing app is not allowed in governed route files`);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === "app") {
      throw new Error(`${fileName}: aliasing app is not allowed in governed route files`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text as HttpMethod | "route";
      if (ts.isIdentifier(receiver) && receiver.text === "app" && !ROUTE_METHODS.has(method as HttpMethod) && !["route", "use", "onError"].includes(method)) {
        throw new Error(`${fileName}: unsupported app.${method} registration is not allowed`);
      }
      if (ts.isIdentifier(receiver) && receiver.text === "app" && method === "route") {
        const prefix = node.arguments[0];
        if (!prefix || !ts.isStringLiteralLike(prefix)) {
          throw new Error(`${fileName}: app.route must use a static string literal prefix`);
        }
      }
      if (ts.isIdentifier(receiver) && receiver.text === "app" && ROUTE_METHODS.has(method as HttpMethod)) {
        const pathArgument = node.arguments[0];
        if (!pathArgument || !ts.isStringLiteralLike(pathArgument)) {
          throw new Error(`${fileName}: app.${method} must use a static string literal path`);
        }
        routes.push({ method: method as HttpMethod, path: joinRoute(prefix, pathArgument.text) });
      }
    }
    if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      if (ts.isIdentifier(receiver) && receiver.text === "app") {
        throw new Error(`${fileName}: computed app route registration is not allowed`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

/**
 * 解析单个路由模块（或组合器目录 index.ts），并递归下钻其 app.route 挂载的
 * 子模块。治理规则不变：app 不得别名/传参、方法与路径必须是静态字面量。
 */
async function extractModuleRoutes(
  routesRoot: string,
  fileName: string,
  prefix: string,
  seen: Set<string>,
): Promise<SourceRoute[]> {
  const source = await readFile(fileName, "utf8");
  const relName = path.relative(routesRoot, fileName).replace(/\\/g, "/");
  const routes = extractStaticRoutes(source, `src/http/routes/${relName}`, prefix);

  // 组合器：app.route("/prefix", childFactory()) → 递归解析相对导入的子模块
  const dir = path.dirname(fileName);
  const imports = new Map<string, string>();
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const resolved = path.relative(routesRoot, path.resolve(dir, match[2])).replace(/\\/g, "/").replace(/\.ts$/, "");
    for (const name of match[1].split(",").map((value) => value.trim().split(/\s+/)[0])) {
      if (name) imports.set(name, resolved);
    }
  }
  for (const mount of source.matchAll(MOUNT)) {
    const child = imports.get(mount[2]);
    if (!child) throw new Error(`src/http/routes/${relName}: cannot resolve nested route factory ${mount[2]}`);
    if (seen.has(child)) continue;
    seen.add(child);
    const childFile = path.join(routesRoot, `${child}.ts`);
    const childIndex = path.join(routesRoot, child, "index.ts");
    const target = existsSync(childFile) ? childFile : childIndex;
    routes.push(...await extractModuleRoutes(routesRoot, target, joinRoute(prefix, mount[1]), seen));
  }
  return routes;
}

export async function extractApiSourceRoutes(root = process.cwd()): Promise<SourceRoute[]> {
  const httpRoot = path.join(root, "src", "http");
  const routesRoot = path.join(httpRoot, "routes");
  const server = await readFile(path.join(httpRoot, "server.ts"), "utf8");
  const routes = extractStaticRoutes(server, "src/http/server.ts");
  const modules = new Map<string, string>();
  for (const match of server.matchAll(IMPORT)) {
    for (const imported of match[1].split(",").map((value) => value.trim().split(/\s+/)[0])) {
      modules.set(imported, match[2]);
    }
  }
  const mounts = [...server.matchAll(MOUNT)];
  const mountCallCount = (server.match(/app\.route\s*\(/g) ?? []).length;
  if (mounts.length !== mountCallCount) {
    throw new Error("src/http/server.ts: every app.route mount must use a static prefix and imported route factory call");
  }
  const seen = new Set<string>();
  for (const mount of mounts) {
    const module = modules.get(mount[2]);
    if (!module) throw new Error(`Cannot resolve route factory ${mount[2]}`);
    seen.add(module);
    // 模块可以是平文件（routes/l2.ts）或目录组合器（routes/l3/index.ts）
    const flatFile = path.join(routesRoot, `${module}.ts`);
    const indexFile = path.join(routesRoot, module, "index.ts");
    const target = existsSync(flatFile) ? flatFile : indexFile;
    routes.push(...await extractModuleRoutes(routesRoot, target, mount[1], seen));
  }
  return routes.sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
}
