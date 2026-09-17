import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { BusinessRuleError, NotFoundError } from "@/errors";
import type { Services } from "@/services";
import {
  forgettingApplyResponseSchema,
  forgettingPreviewResponseSchema,
} from "@/http/forgetting-response-contract";

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

const BOOK_ID = "33333333-3333-4333-8333-333333333333";
const ANCHOR_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ANCHOR_ID = "55555555-5555-4555-8555-555555555555";
const BATCH_ID = "66666666-6666-4666-8666-666666666666";

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };

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
  const forgetting = {
    preview: vi.fn(async () => ({ anchors: [ANCHOR_ID], suspendCount: 12 })),
    apply: vi.fn(async () => ({ batchId: BATCH_ID, suspendedCount: 12, pausedCount: 3, anchors: [ANCHOR_ID] })),
    restore: vi.fn(async () => ({ restoredCount: 12, unpausedCount: 3 })),
  };
  return { services: { forgetting } as unknown as Services, forgetting };
}

describe("one-click forgetting HTTP routes", () => {
  it("GET /preview returns the deterministic candidate preview", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/forgetting/preview?bookId=${BOOK_ID}`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(forgettingPreviewResponseSchema.parse(body)).toEqual({ anchors: [ANCHOR_ID], suspendCount: 12 });
    expect(forgetting.preview).toHaveBeenCalledWith({ userId: "user-123", bookId: BOOK_ID });
  });

  it("GET /preview requires a uuid bookId", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    await expectRouteValidationError(await app.request("/api/forgetting/preview", { headers: AUTH_HEADERS }));
    await expectRouteValidationError(await app.request("/api/forgetting/preview?bookId=nope", { headers: AUTH_HEADERS }));
    expect(forgetting.preview).not.toHaveBeenCalled();
  });

  it("POST /apply forwards the confirmed anchor set", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/forgetting/apply", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID, confirmedAnchorIds: [ANCHOR_ID, OTHER_ANCHOR_ID] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(forgettingApplyResponseSchema.parse(body)).toEqual({
      batchId: BATCH_ID,
      suspendedCount: 12,
      pausedCount: 3,
      anchors: [ANCHOR_ID],
    });
    expect(forgetting.apply).toHaveBeenCalledWith({
      userId: "user-123",
      bookId: BOOK_ID,
      confirmedAnchorIds: [ANCHOR_ID, OTHER_ANCHOR_ID],
    });
  });

  it("POST /apply accepts an empty anchor set (suspend everything)", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/forgetting/apply", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID, confirmedAnchorIds: [] }),
    });

    expect(res.status).toBe(200);
    expect(forgetting.apply).toHaveBeenCalledWith(expect.objectContaining({ confirmedAnchorIds: [] }));
  });

  it("POST /apply rejects a non-uuid anchor element before any service call", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/forgetting/apply", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID, confirmedAnchorIds: [ANCHOR_ID, "not-a-uuid"] }),
    });

    await expectRouteValidationError(res);
    expect(forgetting.apply).not.toHaveBeenCalled();
  });

  it("POST /apply maps a stale confirmation list to 422", async () => {
    const { services, forgetting } = makeMockServices();
    forgetting.apply = vi.fn(async () => {
      throw new BusinessRuleError("preview 已过期，请重新 preview");
    });
    const app = createApp(services);

    await expectServiceError(await app.request("/api/forgetting/apply", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID, confirmedAnchorIds: [ANCHOR_ID] }),
    }), 422, "BUSINESS_RULE");
  });

  it("POST /restore rolls back a batch", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/forgetting/restore", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID, batchId: BATCH_ID }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ restoredCount: 12, unpausedCount: 3 });
    expect(forgetting.restore).toHaveBeenCalledWith({ userId: "user-123", bookId: BOOK_ID, batchId: BATCH_ID });
  });

  it("POST /restore rejects a missing batchId before any service call", async () => {
    const { services, forgetting } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/forgetting/restore", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID }),
    });

    await expectRouteValidationError(res);
    expect(forgetting.restore).not.toHaveBeenCalled();
  });

  it("POST /restore maps an unknown batch to 404", async () => {
    const { services, forgetting } = makeMockServices();
    forgetting.restore = vi.fn(async () => {
      throw new NotFoundError("BulkForgetBatch", BATCH_ID);
    });
    const app = createApp(services);

    await expectServiceError(await app.request("/api/forgetting/restore", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ bookId: BOOK_ID, batchId: BATCH_ID }),
    }), 404, "NOT_FOUND");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);
    const res = await app.request(`/api/forgetting/preview?bookId=${BOOK_ID}`);
    expect(res.status).toBe(401);
  });
});
