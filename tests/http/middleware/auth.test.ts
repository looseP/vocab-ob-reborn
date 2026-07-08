import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { authMiddleware, type AuthRole } from "@/http/middleware/auth";

type AppEnv = { Variables: { role: AuthRole; userId: string } };

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_AGENT_TOKENS = process.env.AGENT_API_TOKENS;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "owner-secret";
  process.env.AGENT_API_TOKENS = "agent-1,agent-2";
  process.env.LOCAL_OWNER_ID = "user-uuid-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = ORIGINAL_AGENT_TOKENS;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

function makeApp(requireRole: "owner" | "agent" | "public" = "owner") {
  const app = new Hono<AppEnv>();
  app.use("/*", authMiddleware(requireRole));
  app.get("/*", (c) => c.json({ role: c.get("role"), userId: c.get("userId") }));
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
    expect(res.status).toBe(403);
  });

  it("allows agent token for agent-required route", async () => {
    const app = makeApp("agent");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; userId: string };
    expect(body.role).toBe("agent");
  });

  it("rejects agent token for owner-required route", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-1" },
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
});
