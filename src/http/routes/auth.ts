import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Services } from "../../services";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  authMiddleware,
  type Principal,
} from "../middleware/auth";
import type { AppEnv } from "./words";

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_ATTEMPT_LIMIT = 8;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function expectedOrigin(requestUrl: string): string {
  return new URL(process.env.APP_ORIGIN ?? requestUrl).origin;
}

function isSameOrigin(requestUrl: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === expectedOrigin(requestUrl);
  } catch {
    return false;
  }
}

function loginRateLimitKey(headers: Headers): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim();
    const realIp = headers.get("X-Real-IP")?.trim();
    if (forwarded || realIp) return forwarded ?? realIp ?? "proxy-unknown";
  }
  return "direct-client";
}

function consumeLoginAttempt(key: string): number | null {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return null;
  }
  current.count += 1;
  if (current.count <= LOGIN_ATTEMPT_LIMIT) return null;
  return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
}

export function resetLoginRateLimitsForTests(): void {
  loginAttempts.clear();
}

function cookieSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

function setSessionCookies(c: Parameters<typeof setCookie>[0], sessionToken: string, csrfToken: string): void {
  const common = {
    secure: cookieSecure(),
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
  setCookie(c, SESSION_COOKIE_NAME, sessionToken, { ...common, httpOnly: true });
  setCookie(c, CSRF_COOKIE_NAME, csrfToken, { ...common, httpOnly: false });
}

function clearSessionCookies(c: Parameters<typeof deleteCookie>[0]): void {
  const options = { secure: cookieSecure(), sameSite: "Lax" as const, path: "/" };
  deleteCookie(c, SESSION_COOKIE_NAME, options);
  deleteCookie(c, CSRF_COOKIE_NAME, options);
}

export function authRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/session", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!isSameOrigin(c.req.url, c.req.header("Origin")) || c.req.header("X-Requested-With") !== "VocabObservatory") {
      return c.json({ error: "Invalid request origin", code: "AUTH_ORIGIN_REJECTED" }, 403);
    }
    const rateLimitKey = loginRateLimitKey(c.req.raw.headers);
    const retryAfter = consumeLoginAttempt(rateLimitKey);
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many authentication attempts", code: "AUTH_RATE_LIMITED" }, 429);
    }
    const contentType = c.req.header("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "Content-Type must be application/json", code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
    }
    const body = await c.req.json<{ ownerToken?: unknown }>().catch(() => null);
    if (!body || typeof body.ownerToken !== "string" || body.ownerToken.length === 0) {
      return c.json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" }, 401);
    }
    const issued = await services.authSessions.exchangeOwnerToken(body.ownerToken);
    if (!issued) return c.json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" }, 401);

    loginAttempts.delete(rateLimitKey);
    setSessionCookies(c, issued.sessionToken, issued.csrfToken);
    return c.json({
      authenticated: true,
      actorId: issued.principal.actorId,
      role: issued.principal.role,
      expiresAt: issued.expiresAt,
      csrfToken: issued.csrfToken,
    }, 201);
  });

  app.get("/session", authMiddleware(services.authSessions, "owner"), (c) => {
    const principal = c.get("principal") as Principal;
    c.header("Cache-Control", "no-store");
    return c.json({ authenticated: true, actorId: principal.actorId, role: principal.role, authMethod: principal.authMethod });
  });

  app.delete("/session", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    const authenticated = await services.authSessions.authenticate(token);
    if (authenticated) {
      const csrfHeader = c.req.header("X-CSRF-Token");
      const csrfCookie = getCookie(c, CSRF_COOKIE_NAME);
      if (!isSameOrigin(c.req.url, c.req.header("Origin")) || !csrfHeader || csrfHeader !== csrfCookie || !services.authSessions.verifyCsrf(csrfHeader, authenticated.csrfHash)) {
        return c.json({ error: "Invalid CSRF proof", code: "CSRF_REJECTED" }, 403);
      }
      await services.authSessions.revoke(token);
    }
    clearSessionCookies(c);
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  return app;
}
