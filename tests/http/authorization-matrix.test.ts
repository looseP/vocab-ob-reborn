/**
 * 授权矩阵（T13a §D）：只钉"谁能进门"，不测业务。
 *
 * 层级：断言在中间件层拦截、不触 service（放行后落到一个 stub 200 handler）。
 * 行 = 全部 /api/* 操作（不抽样）；列 = owner / agent / 未认证 / session。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware, type Principal } from "@/http/middleware/auth";
import { resolveMinRole } from "@/http/middleware/api-authorization";
import { apiOperations } from "@/http/operations";
import type { AuthSessionService } from "@/services/auth-session.service";

type AppEnv = { Variables: { principal: Principal; role: string; userId: string } };

const ORIGINAL = {
  owner: process.env.OWNER_API_TOKEN,
  agents: process.env.AGENT_API_TOKENS,
  localOwner: process.env.LOCAL_OWNER_ID,
  origin: process.env.APP_ORIGIN,
};

const OWNER_TOKEN = "owner-secret-matrix";
const AGENT_TOKEN = "agent-secret-matrix";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = `matrix-agent:${AGENT_TOKEN}`;
  process.env.LOCAL_OWNER_ID = "00000000-0000-4000-8000-000000000001";
  process.env.APP_ORIGIN = "http://localhost";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL.owner;
  process.env.AGENT_API_TOKENS = ORIGINAL.agents;
  process.env.LOCAL_OWNER_ID = ORIGINAL.localOwner;
  process.env.APP_ORIGIN = ORIGINAL.origin;
});

const SESSION_COOKIE = "vocab_session=opaque-session-token; vocab_csrf=csrf-token";

function makeServices() {
  const authSessions = {
    authenticate: vi.fn(async (token: string | undefined) => token === "opaque-session-token" ? {
      principal: { actorId: "owner-1", role: "owner", authMethod: "session", sessionId: "session-id" } as Principal,
      csrfHash: "csrf-hash",
    } : null),
    verifyCsrf: vi.fn((token: string | undefined, hash: string) => token === "csrf-token" && hash === "csrf-hash"),
  };
  return authSessions as unknown as AuthSessionService;
}

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // 与 src/http/server.ts 完全相同的解析路径：注册表 → method+模板 → 比较角色。
  app.use("/api/*", authMiddleware(makeServices(), (c) => resolveMinRole(c.req.method, c.req.path)));
  app.all("/api/*", (c) => c.json({ ok: true }));
  return app;
}

const app = buildApp();

// 豁免组：/api/auth 在全局中间件之前挂载，其门禁由路由自持（E 测试覆盖）。
const governedOperations = apiOperations.filter(
  (operation) => operation.path.startsWith("/api/") && !operation.path.startsWith("/api/auth"),
);

function concretePath(template: string): string {
  return template.replace(/:[A-Za-z0-9_]+/g, "sample");
}

const isWrite = (method: string): boolean => method !== "get";

describe("authorization matrix (D1–D4)", () => {
  it("owner bearer is allowed on every governed /api/* operation", async () => {
    for (const operation of governedOperations) {
      const response = await app.request(`http://localhost${concretePath(operation.path)}`, {
        method: operation.method.toUpperCase(),
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
      });
      expect(response.status, `${operation.operationId} (owner)`).toBe(200);
    }
  });

  it("agent bearer: read 200, proposal write 200, everything else 403", async () => {
    for (const operation of governedOperations) {
      const response = await app.request(`http://localhost${concretePath(operation.path)}`, {
        method: operation.method.toUpperCase(),
        headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
      });
      const expected = operation.minRole === "agent" ? 200 : 403;
      expect(response.status, `${operation.operationId} (agent)`).toBe(expected);
    }
  });

  it("unauthenticated: 401 unless the endpoint is minRole public", async () => {
    for (const operation of governedOperations) {
      const response = await app.request(`http://localhost${concretePath(operation.path)}`, {
        method: operation.method.toUpperCase(),
        headers: { "Content-Type": "application/json" },
      });
      const expected = operation.minRole === "public" ? 200 : 401;
      expect(response.status, `${operation.operationId} (anonymous)`).toBe(expected);
      if (expected === 401) {
        expect(response.headers.get("WWW-Authenticate"), operation.operationId).toContain("Bearer");
      }
    }
  });

  it("session channel: reads and CSRF-proven writes are owner-allowed", async () => {
    for (const operation of governedOperations) {
      const headers: Record<string, string> = { Cookie: SESSION_COOKIE };
      if (isWrite(operation.method)) {
        headers.Origin = "http://localhost";
        headers["X-CSRF-Token"] = "csrf-token";
        headers["Content-Type"] = "application/json";
      }
      const response = await app.request(`http://localhost${concretePath(operation.path)}`, {
        method: operation.method.toUpperCase(),
        headers,
      });
      expect(response.status, `${operation.operationId} (session+)`).toBe(200);
    }
  });

  it("session channel: state-changing requests without CSRF are rejected with 403", async () => {
    for (const operation of governedOperations.filter((candidate) => isWrite(candidate.method))) {
      const response = await app.request(`http://localhost${concretePath(operation.path)}`, {
        method: operation.method.toUpperCase(),
        headers: { Cookie: SESSION_COOKIE, "Content-Type": "application/json" },
      });
      expect(response.status, `${operation.operationId} (session, no csrf)`).toBe(403);
    }
  });

  it("agent bearer is not subject to CSRF (bearer path unaffected by the session rule)", async () => {
    const describeL2 = await app.request("http://localhost/api/l2/sample/candidates", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    });
    expect(describeL2.status).toBe(200);

    const confirm = await app.request("http://localhost/api/l2/sample/confirm", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    });
    expect(confirm.status).toBe(403);
  });
});

// ── 验收 1/2 的定点断言（读全量 200 / 写 proposal 200 / 升级动作 403 / 未认证 401）──
describe("acceptance spot checks", () => {
  it("agent token: read 200, proposal write 200, upgrade action 403, anonymous 401", async () => {
    const agent = async (method: string, path: string): Promise<number> => (await app.request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    })).status;

    expect(await agent("GET", "/api/l3/proposals")).toBe(200);
    expect(await agent("POST", "/api/l3/proposals")).toBe(200);
    expect(await agent("POST", "/api/l2/sample/candidates")).toBe(200);
    expect(await agent("POST", "/api/l3/proposals/sample/confirm")).toBe(403);
    expect(await agent("POST", "/api/forgetting/apply")).toBe(403);
    expect(await agent("POST", "/api/upgrade-work-orders/sample/cancel")).toBe(403);

    const anonymous = await app.request("http://localhost/api/l3/proposals");
    expect(anonymous.status).toBe(401);
  });
});
