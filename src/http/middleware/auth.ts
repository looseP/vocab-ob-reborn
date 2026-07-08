import type { Context, Next } from "hono";

export type AuthRole = "owner" | "agent" | "public";

/**
 * Permission rank — higher values grant access to lower-ranked routes.
 * A route requiring "owner" (2) needs a role whose rank is >= 2.
 */
const roleRank: Record<AuthRole, number> = {
  public: 0,
  agent: 1,
  owner: 2,
};

/**
 * Resolve the effective role of the caller from their bearer token.
 * - owner token (OWNER_API_TOKEN) -> "owner"
 * - any agent token (AGENT_API_TOKENS csv) -> "agent"
 * - missing / unknown token -> "public"
 */
function resolveRole(token: string | undefined): AuthRole {
  if (!token) return "public";
  if (token === process.env.OWNER_API_TOKEN) return "owner";
  const agentTokens = (process.env.AGENT_API_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (agentTokens.includes(token)) return "agent";
  return "public";
}

/**
 * Extract a bearer token from the Authorization header.
 */
function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

/**
 * Hono middleware factory enforcing token-based authorization.
 *
 * @param requireRole minimum role required to access the route.
 *   - "public": anyone (no token needed)
 *   - "agent":  owner or agent token
 *   - "owner":  owner token only
 *
 * On success, sets `role` and `userId` on the context for downstream handlers.
 */
export function authMiddleware(requireRole: AuthRole = "owner") {
  return async (c: Context, next: Next) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    const role = resolveRole(token);

    if (roleRank[role] < roleRank[requireRole]) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    // Set context variables. Hono stores these on the context; the downstream
    // handler reads them via c.get("role") / c.get("userId"). We type-cast via
    // the generic Context so the test's default `new Hono()` works without a
    // Variables declaration.
    c.set("role", role);
    c.set("userId", process.env.LOCAL_OWNER_ID ?? "local-owner");
    await next();
  };
}
