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

export async function extractApiSourceRoutes(root = process.cwd()): Promise<SourceRoute[]> {
  const httpRoot = path.join(root, "src", "http");
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
  for (const mount of mounts) {
    const module = modules.get(mount[2]);
    if (!module) throw new Error(`Cannot resolve route factory ${mount[2]}`);
    const source = await readFile(path.join(httpRoot, "routes", `${module}.ts`), "utf8");
    routes.push(...extractStaticRoutes(source, `src/http/routes/${module}.ts`, mount[1]));
  }
  return routes.sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
}
