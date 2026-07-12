import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthSessionService } from "../../services/auth-session.service";

export type AuthRole = "owner" | "agent" | "public";
export type AuthMethod = "bearer" | "session" | "public";
export type Principal = {
  actorId: string;
  role: AuthRole;
  authMethod: AuthMethod;
  sessionId?: string;
};

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
  const agentTokens = (process.env.AGENT_API_TOKENS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (agentTokens.includes(token)) return { actorId, role: "agent", authMethod: "bearer" };
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

export function authMiddleware(authSessions: AuthSessionService | undefined, requireRole: AuthRole = "owner") {
  return async (c: Context, next: Next) => {
    const bearerToken = extractBearerToken(c.req.header("Authorization"));
    let principal = resolveBearerPrincipal(bearerToken);
    let expectedCsrfHash: string | undefined;

    if (!principal && authSessions) {
      const authenticated = await authSessions.authenticate(getCookie(c, SESSION_COOKIE_NAME));
      principal = authenticated?.principal ?? null;
      expectedCsrfHash = authenticated?.csrfHash;
    }

    if (!principal && requireRole === "public") {
      principal = { actorId: "public", role: "public", authMethod: "public" };
    }

    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer realm="vocab-observatory"');
      return c.json({ error: "Authentication required", code: "UNAUTHENTICATED" }, 401);
    }

    if (roleRank[principal.role] < roleRank[requireRole]) {
      return c.json({ error: "Insufficient permissions", code: "FORBIDDEN" }, 403);
    }

    if (principal.authMethod === "session" && isStateChanging(c.req.method)) {
      const origin = requestOrigin(c);
      if (!origin || origin !== expectedOrigin(c)) {
        return c.json({ error: "Invalid request origin", code: "CSRF_ORIGIN_REJECTED" }, 403);
      }
      const csrfHeader = c.req.header(CSRF_HEADER_NAME);
      const csrfCookie = getCookie(c, CSRF_COOKIE_NAME);
      if (!csrfHeader || csrfHeader !== csrfCookie || !expectedCsrfHash || !authSessions?.verifyCsrf(csrfHeader, expectedCsrfHash)) {
        return c.json({ error: "Invalid CSRF token", code: "CSRF_TOKEN_REJECTED" }, 403);
      }
    }

    c.set("principal", principal);
    c.set("role", principal.role);
    c.set("userId", principal.actorId);
    await next();
  };
}
