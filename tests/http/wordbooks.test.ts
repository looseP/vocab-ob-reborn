import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { NotFoundError } from "@/errors";
import {
  wordbookDefaultResponseSchema,
  wordbookListResponseSchema,
} from "@/http/note-wordbook-response-contract";

// ── Auth env setup ──────────────────────────────────────────────────────────
// Same pattern as tests/http/words.test.ts: the bearer token is resolved
// against OWNER_API_TOKEN and LOCAL_OWNER_ID becomes the authenticated userId.
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
const OTHER_WORDBOOK_ID = "22222222-2222-4222-8222-222222222222";

const SUMMARY = {
  id: WORDBOOK_ID,
  name: "雅思核心",
  description: null,
  isDefault: true,
};

function makeWordbookMocks() {
  return {
    findAllByUser: vi.fn().mockResolvedValue([
      SUMMARY,
      { id: OTHER_WORDBOOK_ID, name: "GRE 3000", description: "难点词", isDefault: false },
    ]),
    getOrCreateDefault: vi.fn().mockResolvedValue(SUMMARY),
  };
}

function makeMockServices(): Services {
  return { wordbooks: makeWordbookMocks() } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

describe("GET /api/wordbooks", () => {
  it("lists the actor's wordbooks matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordbookListResponseSchema.parse(await res.json());
    expect(body.total).toBe(2);
    expect(body.items).toEqual([
      { id: WORDBOOK_ID, name: "雅思核心", description: null, isDefault: true },
      { id: OTHER_WORDBOOK_ID, name: "GRE 3000", description: "难点词", isDefault: false },
    ]);
    expect(services.wordbooks.findAllByUser).toHaveBeenCalledWith("user-123");
  });

  it("returns an empty list with total=0 when the user has no wordbooks", async () => {
    const services = makeMockServices();
    services.wordbooks.findAllByUser = vi.fn().mockResolvedValue([]);
    const app = createApp(services);
    const res = await app.request("/api/wordbooks", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(wordbookListResponseSchema.parse(await res.json())).toEqual({
      items: [],
      total: 0,
    });
  });

  it("rejects missing credentials with 401 and never reaches the service", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks");
    expect(res.status).toBe(401);
    expect(services.wordbooks.findAllByUser).not.toHaveBeenCalled();
  });
});

describe("GET /api/wordbooks/default", () => {
  it("returns the default wordbook matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/wordbooks/default", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = wordbookDefaultResponseSchema.parse(await res.json());
    expect(body).toEqual({
      id: WORDBOOK_ID,
      name: "雅思核心",
      description: null,
      isDefault: true,
    });
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    // The list endpoint must not have been touched by this request.
    expect(services.wordbooks.findAllByUser).not.toHaveBeenCalled();
  });

  it("maps a service-level NotFoundError to 404 NOT_FOUND via handleError", async () => {
    const services = makeMockServices();
    services.wordbooks.getOrCreateDefault = vi
      .fn()
      .mockRejectedValue(new NotFoundError("Wordbook", "user-123"));
    const app = createApp(services);
    const res = await app.request("/api/wordbooks/default", { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBeDefined();
  });

  it("reduces unexpected service failures to a 500 without leaking internals", async () => {
    const services = makeMockServices();
    services.wordbooks.getOrCreateDefault = vi
      .fn()
      .mockRejectedValue(new Error("secret SQL: select * from wordbooks"));
    const app = createApp(services);
    const res = await app.request("/api/wordbooks/default", { headers: AUTH_HEADERS });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("secret SQL");
  });
});
