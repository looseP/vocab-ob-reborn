import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware, type Principal } from "@/http/middleware/auth";
import { authRoutes } from "@/http/routes/auth";
import type { Services } from "@/services";

const actorId = "00000000-0000-4000-8000-000000000001";
const originalNodeEnv = process.env.NODE_ENV;

function makeServices() {
  const attempts = new Map<string, number>();
  const loginRateLimit = {
    consume: vi.fn(async (key: string) => {
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return count > 8 ? 60 : null;
    }),
    clear: vi.fn(async (key: string) => {
      attempts.delete(key);
    }),
  };
  const authSessions = {
    exchangeOwnerToken: vi.fn(async (token: string) => token === "owner-secret" ? {
      principal: { actorId, role: "owner", authMethod: "session", sessionId: "session-id" },
      sessionToken: "opaque-session-token",
      csrfToken: "csrf-token",
      expiresAt: "2026-07-10T21:00:00.000Z",
    } : null),
    authenticate: vi.fn(async (token: string | undefined) => token === "opaque-session-token" ? {
      principal: { actorId, role: "owner", authMethod: "session", sessionId: "session-id" },
      csrfHash: "csrf-hash",
    } : null),
    verifyCsrf: vi.fn((token: string | undefined, hash: string) => token === "csrf-token" && hash === "csrf-hash"),
    revoke: vi.fn(async () => true),
  };
  return { services: { authSessions, loginRateLimit } as unknown as Services, authSessions, loginRateLimit };
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "http://localhost";
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  delete process.env.APP_ORIGIN;
});

describe("browser auth session", () => {
  it("exchanges an owner token for HttpOnly and CSRF cookies", async () => {
    const { services } = makeServices();
    const app = new Hono();
    app.route("/api/auth", authRoutes(services));
    const response = await app.request("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost", "X-Requested-With": "VocabObservatory" },
      body: JSON.stringify({ ownerToken: "owner-secret" }),
    });

    expect(response.status).toBe(201);
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toContain("vocab_session=opaque-session-token");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("vocab_csrf=csrf-token");
    expect(cookies).toContain("SameSite=Lax");
    expect(cookies.match(/HttpOnly/g)?.length).toBe(1);
  });

  it("returns 401 without exposing credential details", async () => {
    const { services } = makeServices();
    const app = new Hono();
    app.route("/api/auth", authRoutes(services));
    const response = await app.request("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost", "X-Requested-With": "VocabObservatory" },
      body: JSON.stringify({ ownerToken: "wrong" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "Invalid credentials",
      code: "INVALID_CREDENTIALS",
      message: "Invalid credentials",
      requestId: expect.any(String),
    });
  });

  it("rejects cross-origin and script-like login requests", async () => {
    const { services } = makeServices();
    const app = new Hono();
    app.route("/api/auth", authRoutes(services));

    const crossOrigin = await app.request("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example", "X-Requested-With": "VocabObservatory" },
      body: JSON.stringify({ ownerToken: "owner-secret" }),
    });
    expect(crossOrigin.status).toBe(403);

    const missingMarker = await app.request("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ ownerToken: "owner-secret" }),
    });
    expect(missingMarker.status).toBe(403);
  });

  it("rate-limits repeated login attempts with Retry-After", async () => {
    const { services } = makeServices();
    const app = new Hono();
    app.route("/api/auth", authRoutes(services));
    let response: Response | undefined;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      response = await app.request("http://localhost/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost", "X-Requested-With": "VocabObservatory" },
        body: JSON.stringify({ ownerToken: "wrong" }),
      });
    }
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("clears the login attempt window after successful authentication", async () => {
    const { services } = makeServices();
    const app = new Hono();
    app.route("/api/auth", authRoutes(services));

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.request("http://localhost/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost", "X-Requested-With": "VocabObservatory" },
        body: JSON.stringify({ ownerToken: attempt === 7 ? "owner-secret" : "wrong" }),
      });
      expect(response.status).toBe(attempt === 7 ? 201 : 401);
    }

    const nextLogin = await app.request("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost", "X-Requested-With": "VocabObservatory" },
      body: JSON.stringify({ ownerToken: "owner-secret" }),
    });
    expect(nextLogin.status).toBe(201);
  });

  it("allows session GET but requires Origin and double-submit CSRF for mutations", async () => {
    const { services, authSessions } = makeServices();
    const app = new Hono<{ Variables: { principal: Principal; role: string; userId: string } }>();
    app.use("/api/*", authMiddleware(services.authSessions, "owner"));
    app.get("/api/read", (c) => c.json({ actorId: c.get("userId") }));
    app.post("/api/write", (c) => c.json({ ok: true }));

    const cookie = "vocab_session=opaque-session-token; vocab_csrf=csrf-token";
    const read = await app.request("http://localhost/api/read", { headers: { Cookie: cookie } });
    expect(read.status).toBe(200);

    const noCsrf = await app.request("http://localhost/api/write", { method: "POST", headers: { Cookie: cookie } });
    expect(noCsrf.status).toBe(403);

    const badOrigin = await app.request("http://localhost/api/write", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://evil.example", "X-CSRF-Token": "csrf-token" },
    });
    expect(badOrigin.status).toBe(403);

    const write = await app.request("http://localhost/api/write", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost", "X-CSRF-Token": "csrf-token" },
    });
    expect(write.status).toBe(200);
    expect(authSessions.verifyCsrf).toHaveBeenCalledWith("csrf-token", "csrf-hash");
  });

  it("revokes the server session and clears both cookies", async () => {
    const { services, authSessions } = makeServices();
    const app = new Hono();
    app.route("/api/auth", authRoutes(services));
    const response = await app.request("http://localhost/api/auth/session", {
      method: "DELETE",
      headers: {
        Cookie: "vocab_session=opaque-session-token; vocab_csrf=csrf-token",
        Origin: "http://localhost",
        "X-CSRF-Token": "csrf-token",
      },
    });
    expect(response.status).toBe(204);
    expect(authSessions.revoke).toHaveBeenCalledWith("opaque-session-token");
    expect(response.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
  });
});
