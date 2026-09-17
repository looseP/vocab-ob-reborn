import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { BusinessRuleError, NotFoundError } from "@/errors";
import type { Services } from "@/services";
import { l3SessionRenderDescriptionResponseSchema } from "@/http/l3-session-response-contract";

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

const SESSION_ID = "66666666-6666-4666-8666-666666666666";
const CONTEXT_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_ID = "00000000-0000-4000-8000-000000000001";

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };

const SESSION_ROW = {
  id: SESSION_ID,
  user_id: "user-123",
  type: "l3_practice",
  title: null,
  plan: { version: 1, days: 1, seed: "seed-1", items: [{ day: 1, contextIds: [CONTEXT_ID] }] },
  version: 1,
  status: "active",
  started_at: "2026-09-11T00:00:00.000Z",
  ended_at: null,
  created_at: "2026-09-11T00:00:00.000Z",
};

const RENDER = {
  session: SESSION_ROW,
  items: [{
    day: 1,
    contexts: [{
      id: CONTEXT_ID,
      text: "A vivid context.",
      context_type: "sentence",
      source_id: SOURCE_ID,
      source_title: "Essay",
    }],
  }],
};

async function expectRouteValidationError(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json() as { code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
}

async function expectServiceError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json() as { code: string };
  expect(body.code).toBe(code);
}

function makeMockServices() {
  const l3Sessions = {
    createPlan: vi.fn(async () => SESSION_ROW),
    getSession: vi.fn(async () => RENDER),
    endSession: vi.fn(async () => ({ ...SESSION_ROW, status: "completed", ended_at: "2026-09-11T01:00:00.000Z" })),
  };
  return { services: { l3Sessions } as unknown as Services, l3Sessions };
}

describe("L3 session HTTP routes", () => {
  it("POST / creates a session plan and returns 201", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-sessions", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        type: "l3_practice",
        title: "Weekly practice",
        space: "阅读",
        direction: "考研",
        contextCount: 20,
        days: 3,
        seed: "seed-1",
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(SESSION_ROW);
    expect(l3Sessions.createPlan).toHaveBeenCalledWith({
      userId: "user-123",
      type: "l3_practice",
      title: "Weekly practice",
      space: "阅读",
      direction: "考研",
      contextCount: 20,
      days: 3,
      seed: "seed-1",
    });
  });

  it("POST / defaults omitted optional fields to null", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-sessions", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ type: "cram_pack" }),
    });

    expect(res.status).toBe(201);
    expect(l3Sessions.createPlan).toHaveBeenCalledWith({
      userId: "user-123",
      type: "cram_pack",
      title: null,
      space: null,
      direction: null,
      contextCount: null,
      days: null,
      seed: null,
    });
  });

  it("POST / rejects an unknown session type before any service call", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-sessions", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ type: "bogus" }),
    });

    await expectRouteValidationError(res);
    expect(l3Sessions.createPlan).not.toHaveBeenCalled();
  });

  it("GET /:id returns the render description", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3-sessions/${SESSION_ID}`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(l3SessionRenderDescriptionResponseSchema.parse(body)).toEqual(RENDER);
    expect(l3Sessions.getSession).toHaveBeenCalledWith({ userId: "user-123", sessionId: SESSION_ID });
  });

  it("GET /:id rejects a non-uuid id before any service call", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/l3-sessions/not-a-uuid", { headers: AUTH_HEADERS });

    await expectRouteValidationError(res);
    expect(l3Sessions.getSession).not.toHaveBeenCalled();
  });

  it("GET /:id maps a missing session to 404", async () => {
    const { services, l3Sessions } = makeMockServices();
    l3Sessions.getSession = vi.fn(async () => {
      throw new NotFoundError("L3Session", SESSION_ID);
    });
    const app = createApp(services);

    await expectServiceError(
      await app.request(`/api/l3-sessions/${SESSION_ID}`, { headers: AUTH_HEADERS }),
      404,
      "NOT_FOUND",
    );
  });

  it("POST /:id/end ends the session with a validated status", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3-sessions/${SESSION_ID}/end`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ status: "completed" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "completed" });
    expect(l3Sessions.endSession).toHaveBeenCalledWith({
      userId: "user-123",
      sessionId: SESSION_ID,
      status: "completed",
    });
  });

  it("POST /:id/end rejects 'active' and unknown statuses", async () => {
    const { services, l3Sessions } = makeMockServices();
    const app = createApp(services);

    const active = await app.request(`/api/l3-sessions/${SESSION_ID}/end`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ status: "active" }),
    });
    await expectRouteValidationError(active);

    const unknown = await app.request(`/api/l3-sessions/${SESSION_ID}/end`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ status: "bogus" }),
    });
    await expectRouteValidationError(unknown);

    expect(l3Sessions.endSession).not.toHaveBeenCalled();
  });

  it("POST /:id/end maps a state conflict to 422", async () => {
    const { services, l3Sessions } = makeMockServices();
    l3Sessions.endSession = vi.fn(async () => {
      throw new BusinessRuleError("L3 session is already abandoned");
    });
    const app = createApp(services);

    await expectServiceError(
      await app.request(`/api/l3-sessions/${SESSION_ID}/end`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ status: "completed" }),
      }),
      422,
      "BUSINESS_RULE",
    );
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);
    const res = await app.request(`/api/l3-sessions/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });
});
