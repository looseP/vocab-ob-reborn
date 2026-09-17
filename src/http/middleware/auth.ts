import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthSessionService } from "../../services/auth-session.service";
import { parseAgentTokens } from "../../config/agent-tokens";
import { jsonError } from "../error-response";

export type AuthRole = "owner" | "agent" | "public";
export type AuthMethod = "bearer" | "session" | "public";
export type Principal = {
  actorId: string;
  role: AuthRole;
  authMethod: AuthMethod;
  sessionId?: string;
  /**
   * ADR-0029 决策 5：服务端由 `AGENT_API_TOKENS` 的 `agentId:token` 映射认定的
   * 信任锚。仅 agent bearer 路径有值；owner/bearer 与 session 路径无。
   * T13a 只注入到 Principal；落 `proposal.provenance.agentId` 属 T13c。
   */
  agentId?: string;
};
/** 每次请求解析所需最小角色的策略（用于 `/api/*` 的按端点分级）。 */
export type AuthRoleResolver = (c: Context) => AuthRole;

export const SESSION_COOKIE_NAME = "vocab_session";
export const CSRF_COOKIE_NAME = "vocab_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

const roleRank: Record<AuthRole, number> = {
  public: 0,
  agent: 1,
  owner: 2,
};

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

function resolveBearerPrincipal(token: string | undefined): Principal | null {
  if (!token) return null;
  const actorId = process.env.LOCAL_OWNER_ID;
  if (!actorId) return null;
  if (process.env.OWNER_API_TOKEN && token === process.env.OWNER_API_TOKEN) {
    return { actorId, role: "owner", authMethod: "bearer" };
  }
  // `id:token` 映射是 agentId 信任锚的唯一来源；词法/唯一性已由启动 fail-fast 拒启，
  // 此处若仍遇非法配置会抛错（fail-closed：宁可 500 也不放行未认定身份）。
  const agent = parseAgentTokens(process.env.AGENT_API_TOKENS, process.env.OWNER_API_TOKEN)
    .find((entry) => entry.token === token);
  if (agent) return { actorId, role: "agent", authMethod: "bearer", agentId: agent.agentId };
  return null;
}

function isStateChanging(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function requestOrigin(c: Context): string | null {
  const origin = c.req.header("Origin");
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function expectedOrigin(c: Context): string {
  const configuredOrigin = process.env.APP_ORIGIN;
  if (configuredOrigin) return new URL(configuredOrigin).origin;
  return new URL(c.req.url).origin;
}

export function authMiddleware(
  authSessions: AuthSessionService | undefined,
  requireRole: AuthRole | AuthRoleResolver = "owner",
) {
  return async (c: Context, next: Next) => {
    // 按端点分级：所需角色是每次请求解析出来的（/api/* 由注册表查找表给出）。
    const requiredRole: AuthRole = typeof requireRole === "function" ? requireRole(c) : requireRole;
    const bearerToken = extractBearerToken(c.req.header("Authorization"));
    let principal = resolveBearerPrincipal(bearerToken);
    let expectedCsrfHash: string | undefined;

    if (!principal && authSessions) {
      const authenticated = await authSessions.authenticate(getCookie(c, SESSION_COOKIE_NAME));
      principal = authenticated?.principal ?? null;
      expectedCsrfHash = authenticated?.csrfHash;
    }

    if (!principal && requiredRole === "public") {
      principal = { actorId: "public", role: "public", authMethod: "public" };
    }

    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer realm="vocab-observatory"');
      return jsonError(c, 401, "UNAUTHENTICATED", "Authentication required");
    }

    if (roleRank[principal.role] < roleRank[requiredRole]) {
      return jsonError(c, 403, "FORBIDDEN", "Insufficient permissions");
    }

    if (principal.authMethod === "session" && isStateChanging(c.req.method)) {
      const origin = requestOrigin(c);
      if (!origin || origin !== expectedOrigin(c)) {
        return jsonError(c, 403, "CSRF_ORIGIN_REJECTED", "Invalid request origin");
      }
      const csrfHeader = c.req.header(CSRF_HEADER_NAME);
      const csrfCookie = getCookie(c, CSRF_COOKIE_NAME);
      if (!csrfHeader || csrfHeader !== csrfCookie || !expectedCsrfHash || !authSessions?.verifyCsrf(csrfHeader, expectedCsrfHash)) {
        return jsonError(c, 403, "CSRF_TOKEN_REJECTED", "Invalid CSRF token");
      }
    }

    c.set("principal", principal);
    c.set("role", principal.role);
    c.set("userId", principal.actorId);
    await next();
  };
}
