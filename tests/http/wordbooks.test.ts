import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createApp } from "@/http/server";
import { authMiddleware, type Principal } from "@/http/middleware/auth";
import { wordbookRoutes } from "@/http/routes/wordbooks";
import type { Services } from "@/services";
import {
  wordbookAddWordsResponseSchema,
  wordbookCreateResponseSchema,
  wordbookDefaultResponseSchema,
  wordbookDetailResponseSchema,
  wordbookListResponseSchema,
} from "@/http/note-wordbook-response-contract";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

const WORDBOOK_ID = "11111111-1111-4111-8111-111111111111";
const WORD_ID = "22222222-2222-4222-8222-222222222222";

const SUMMARY = {
  id: WORDBOOK_ID,
  name: "雅思核心",
  description: null,
  isDefault: false,
};

function makeWordbookMocks() {
  return {
    findAllByUser: vi.fn().mockResolvedValue([SUMMARY]),
    getOrCreateDefault: vi.fn().mockResolvedValue({ ...SUMMARY, isDefault: true }),
    create: vi.fn().mockResolvedValue(SUMMARY),
    findById: vi.fn().mockResolvedValue(SUMMARY),
    getWordCount: vi.fn().mockResolvedValue(3),
    addWords: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockServices(): Services {
  return { wordbooks: makeWordbookMocks() } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

function postJson(path: string, body: unknown, headers: Record<string, string> = AUTH_HEADERS) {
  return { headers: { ...headers, "Content-Type": "application/json" }, method: "POST" as const, body: JSON.stringify(body) };
}

describe("GET /api/wordbooks", () => {
  it("lists the actor's wordbooks matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordbookListResponseSchema.parse(await res.json());
    expect(body.total).toBe(1);
    expect(services.wordbooks.findAllByUser).toHaveBeenCalledWith("user-123");
  });
});

describe("POST /api/wordbooks", () => {
  it("creates a wordbook and returns 201 matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", postJson("/api/wordbooks", { name: "雅思核心" }));
    expect(res.status).toBe(201);
    const body = wordbookCreateResponseSchema.parse(await res.json());
    expect(body.name).toBe("雅思核心");
    expect(services.wordbooks.create).toHaveBeenCalledWith({ userId: "user-123", name: "雅思核心" });
  });

  it("forwards an optional description to the service", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", postJson("/api/wordbooks", { name: "雅思核心", description: "核心词表" }));
    expect(res.status).toBe(201);
    expect(services.wordbooks.create).toHaveBeenCalledWith({
      userId: "user-123",
      name: "雅思核心",
      description: "核心词表",
    });
  });

  it("rejects an empty name with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", postJson("/api/wordbooks", { name: "" }));
    expect(res.status).toBe(400);
    expect(services.wordbooks.create).not.toHaveBeenCalled();
  });

  it("rejects missing credentials with 401", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", postJson("/api/wordbooks", { name: "雅思核心" }, {}));
    expect(res.status).toBe(401);
    expect(services.wordbooks.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/wordbooks/:id", () => {
  it("returns the wordbook detail with a word count matching the contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request(`/api/wordbooks/${WORDBOOK_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordbookDetailResponseSchema.parse(await res.json());
    expect(body.wordCount).toBe(3);
    expect(services.wordbooks.getWordCount).toHaveBeenCalledWith("user-123", WORDBOOK_ID);
  });

  it("rejects a non-uuid id with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks/not-a-uuid", { headers: AUTH_HEADERS });
    expect(res.status).toBe(400);
    expect(services.wordbooks.findById).not.toHaveBeenCalled();
  });

  it("returns 404 when the wordbook is not visible to the actor", async () => {
    const services = makeMockServices();
    (services.wordbooks.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = createApp(services);
    const res = await app.request(`/api/wordbooks/${WORDBOOK_ID}`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
    expect(services.wordbooks.getWordCount).not.toHaveBeenCalled();
  });
});

describe("POST /api/wordbooks/:id/words", () => {
  it("adds words and returns the ok/added envelope matching the contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request(
      `/api/wordbooks/${WORDBOOK_ID}/words`,
      postJson(`/api/wordbooks/${WORDBOOK_ID}/words`, { wordIds: [WORD_ID] }),
    );
    expect(res.status).toBe(200);
    const body = wordbookAddWordsResponseSchema.parse(await res.json());
    expect(body).toEqual({ ok: true, added: 1 });
    expect(services.wordbooks.addWords).toHaveBeenCalledWith("user-123", WORDBOOK_ID, [WORD_ID]);
  });

  it("rejects an empty wordIds array with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request(
      `/api/wordbooks/${WORDBOOK_ID}/words`,
      postJson(`/api/wordbooks/${WORDBOOK_ID}/words`, { wordIds: [] }),
    );
    expect(res.status).toBe(400);
    expect(services.wordbooks.addWords).not.toHaveBeenCalled();
  });

  it("returns 404 for a foreign wordbook and never reaches the write", async () => {
    const services = makeMockServices();
    (services.wordbooks.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const app = createApp(services);
    const res = await app.request(
      `/api/wordbooks/${WORDBOOK_ID}/words`,
      postJson(`/api/wordbooks/${WORDBOOK_ID}/words`, { wordIds: [WORD_ID] }),
    );
    expect(res.status).toBe(404);
    expect(services.wordbooks.addWords).not.toHaveBeenCalled();
  });
});

describe("route ordering", () => {
  it("still resolves /api/wordbooks/default as the static route, not /:id", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks/default", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordbookDefaultResponseSchema.parse(await res.json());
    expect(body.isDefault).toBe(true);
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.wordbooks.findById).not.toHaveBeenCalled();
  });
});

describe("session CSRF protection for wordbook mutations", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_APP_ORIGIN = process.env.APP_ORIGIN;

  const SESSION_COOKIE = "vocab_session=opaque-session-token; vocab_csrf=csrf-token";

  // 上面 12 个用例走的是 bearer 认证（authMethod=bearer，天然绕过 CSRF 分支）。
  // 这里额外挂 authSessions，构造 session 认证的最小 app 来验证运行时 CSRF 拦截。
  function makeSessionMockServices() {
    const authSessions = {
      authenticate: vi.fn(async (token: string | undefined) =>
        token === "opaque-session-token"
          ? {
              principal: {
                actorId: "user-123",
                role: "owner",
                authMethod: "session",
                sessionId: "session-id",
              } as Principal,
              csrfHash: "csrf-hash",
            }
          : null,
      ),
      verifyCsrf: vi.fn((token: string | undefined, hash: string) => token === "csrf-token" && hash === "csrf-hash"),
    };
    return {
      services: { wordbooks: makeWordbookMocks(), authSessions } as unknown as Services,
      authSessions,
    };
  }

  function buildSessionApp() {
    const { services } = makeSessionMockServices();
    const app = new Hono<{ Variables: { principal: Principal; role: string; userId: string } }>();
    app.use("/api/*", authMiddleware(services.authSessions, "owner"));
    app.route("/api/wordbooks", wordbookRoutes(services));
    return { app, services };
  }

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.APP_ORIGIN = "http://localhost";
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_APP_ORIGIN === undefined) {
      delete process.env.APP_ORIGIN;
    } else {
      process.env.APP_ORIGIN = ORIGINAL_APP_ORIGIN;
    }
  });

  it("rejects create without an Origin header before reaching the service", async () => {
    const { app, services } = buildSessionApp();
    const res = await app.request("http://localhost/api/wordbooks", {
      method: "POST",
      headers: { Cookie: SESSION_COOKIE, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "雅思核心" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_ORIGIN_REJECTED" });
    expect(services.wordbooks.create).not.toHaveBeenCalled();
  });

  it("creates the wordbook once Origin and the double-submit token both match", async () => {
    const { app, services } = buildSessionApp();
    const res = await app.request("http://localhost/api/wordbooks", {
      method: "POST",
      headers: {
        Cookie: SESSION_COOKIE,
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "X-CSRF-Token": "csrf-token",
      },
      body: JSON.stringify({ name: "雅思核心" }),
    });
    expect(res.status).toBe(201);
    expect(services.wordbooks.create).toHaveBeenCalledWith({ userId: "user-123", name: "雅思核心" });
  });

  it("rejects add-words with a matching Origin but no CSRF header before reaching the service", async () => {
    const { app, services } = buildSessionApp();
    const res = await app.request(`http://localhost/api/wordbooks/${WORDBOOK_ID}/words`, {
      method: "POST",
      headers: {
        Cookie: SESSION_COOKIE,
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      body: JSON.stringify({ wordIds: [WORD_ID] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_TOKEN_REJECTED" });
    expect(services.wordbooks.addWords).not.toHaveBeenCalled();
  });

  it("adds words when cookie, Origin and CSRF header are all valid", async () => {
    const { app, services } = buildSessionApp();
    const res = await app.request(`http://localhost/api/wordbooks/${WORDBOOK_ID}/words`, {
      method: "POST",
      headers: {
        Cookie: SESSION_COOKIE,
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "X-CSRF-Token": "csrf-token",
      },
      body: JSON.stringify({ wordIds: [WORD_ID] }),
    });
    expect(res.status).toBe(200);
    expect(wordbookAddWordsResponseSchema.parse(await res.json())).toEqual({ ok: true, added: 1 });
    expect(services.wordbooks.addWords).toHaveBeenCalledWith("user-123", WORDBOOK_ID, [WORD_ID]);
  });
});
