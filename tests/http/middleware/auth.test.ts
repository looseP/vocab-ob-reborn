import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { authMiddleware, type AuthRole, type Principal } from "@/http/middleware/auth";

type AppEnv = { Variables: { role: AuthRole; userId: string; principal: Principal } };

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_AGENT_TOKENS = process.env.AGENT_API_TOKENS;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "owner-secret";
  // ADR-0029 `agentId:token` 格式（T13a 起唯一合法格式）。
  process.env.AGENT_API_TOKENS = "ci-runner:agent-secret-1,review-bot:agent-secret-2";
  process.env.LOCAL_OWNER_ID = "user-uuid-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = ORIGINAL_AGENT_TOKENS;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

function makeApp(requireRole: "owner" | "agent" | "public" = "owner") {
  const app = new Hono<AppEnv>();
  app.use("/*", authMiddleware(undefined, requireRole));
  app.get("/*", (c) => c.json({
    role: c.get("role"),
    userId: c.get("userId"),
    agentId: c.get("principal").agentId ?? null,
  }));
  return app;
}

describe("authMiddleware", () => {
  it("allows owner with correct token", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer owner-secret" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; userId: string };
    expect(body.role).toBe("owner");
  });

  it("rejects missing token for owner-required route", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("allows agent token for agent-required route", async () => {
    const app = makeApp("agent");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-secret-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; userId: string };
    expect(body.role).toBe("agent");
  });

  it("injects the server-attested agentId for agent bearer tokens", async () => {
    const app = makeApp("agent");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-secret-2" },
    });
    const body = (await res.json()) as { agentId: string | null };
    expect(body.agentId).toBe("review-bot");
  });

  it("does not inject agentId on the owner bearer path", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer owner-secret" },
    });
    const body = (await res.json()) as { agentId: string | null };
    expect(body.agentId).toBeNull();
  });

  it("rejects agent token for owner-required route", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-secret-1" },
    });
    expect(res.status).toBe(403);
  });

  it("allows public access to public route", async () => {
    const app = makeApp("public");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("injects userId from LOCAL_OWNER_ID env", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer owner-secret" },
    });
    const body = (await res.json()) as { role: string; userId: string };
    expect(body.userId).toBe("user-uuid-123");
  });

  it("resolves the required role per request via the resolver form", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", authMiddleware(undefined, (c) => (c.req.path === "/read" ? "agent" : "owner")));
    app.get("/*", (c) => c.json({ ok: true }));

    const agentRead = await app.request("/read", { headers: { Authorization: "Bearer agent-secret-1" } });
    expect(agentRead.status).toBe(200);

    const agentWrite = await app.request("/write", { headers: { Authorization: "Bearer agent-secret-1" } });
    expect(agentWrite.status).toBe(403);

    const anonymousRead = await app.request("/read");
    expect(anonymousRead.status).toBe(401);
  });
});
