import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { BusinessRuleError, NotFoundError } from "@/errors";
import type { Services } from "@/services";
import {
  upgradeWorkOrderListItemResponseSchema,
  upgradeWorkOrderRowResponseSchema,
} from "@/http/upgrade-work-order-response-contract";

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

const WORDBOOK_ID = "33333333-3333-4333-8333-333333333333";
const WORD_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };

const ORDER_ROW = {
  id: ORDER_ID,
  user_id: "user-123",
  word_id: WORD_ID,
  wordbook_id: WORDBOOK_ID,
  direction: "通用",
  status: "标记中",
  suggestion_snapshot: { level: "normal" },
  created_at: "2026-09-11T00:00:00.000Z",
  updated_at: "2026-09-11T00:00:00.000Z",
  completed_at: null,
};

/** 清单 service item（行 + 词面 + 档位）；HTTP 响应再组装为 word 嵌套。 */
const ORDER_LIST_ITEM = {
  ...ORDER_ROW,
  wordSlug: "comprehend" as string | null,
  wordText: "comprehend" as string | null,
  suggestion: "normal",
};

const SNAPSHOT = {
  level: "normal",
  currentBookL1: { recentRatings: ["good"], state: "review" },
  otherBooksL2: [],
  capturedAt: "2026-09-11T00:00:00.000Z",
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
  const upgradeWorkOrders = {
    mark: vi.fn(async () => ({ workOrder: ORDER_ROW, suggestion: "normal", suggestionSnapshot: SNAPSHOT })),
    list: vi.fn(async () => [ORDER_LIST_ITEM]),
    start: vi.fn(async () => ({ ...ORDER_ROW, status: "升级中" })),
    cancel: vi.fn(async () => ({ ...ORDER_ROW, status: "已取消" })),
    complete: vi.fn(async () => ({
      workOrder: { ...ORDER_ROW, status: "已完成" },
      alreadyPromoted: false,
      l2DueAt: null,
      seeded: false,
    })),
  };
  return {
    services: { upgradeWorkOrders } as unknown as Services,
    upgradeWorkOrders,
  };
}

describe("upgrade work order HTTP routes", () => {
  it("POST / marks an upgrade and returns the frozen 201 shape", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/upgrade-work-orders", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WORDBOOK_ID, wordId: WORD_ID }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(upgradeWorkOrderRowResponseSchema.parse(body.workOrder)).toEqual(ORDER_ROW);
    expect(upgradeWorkOrders.mark).toHaveBeenCalledWith("user-123", WORDBOOK_ID, WORD_ID, undefined);
  });

  it("POST / passes an explicit direction through", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/upgrade-work-orders", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: WORDBOOK_ID, wordId: WORD_ID, direction: "考研" }),
    });

    expect(res.status).toBe(201);
    expect(upgradeWorkOrders.mark).toHaveBeenCalledWith("user-123", WORDBOOK_ID, WORD_ID, "考研");
  });

  it("POST / rejects a malformed body before any service call", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/upgrade-work-orders", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordbookId: "not-a-uuid", wordId: WORD_ID, direction: "bogus" }),
    });

    await expectRouteValidationError(res);
    expect(upgradeWorkOrders.mark).not.toHaveBeenCalled();
  });

  it("GET / lists pending work orders with an explicit wordbookId", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/upgrade-work-orders?wordbookId=${WORDBOOK_ID}&limit=5`, {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // 清单 item：行字段 + word 嵌套 + suggestion（契约见 response-contract）。
    expect(body).toEqual({
      items: [upgradeWorkOrderListItemResponseSchema.parse({
        ...ORDER_ROW,
        word: { slug: "comprehend", text: "comprehend" },
        suggestion: "normal",
      })],
    });
    expect(upgradeWorkOrders.list).toHaveBeenCalledWith("user-123", WORDBOOK_ID, 5);
  });

  it("GET / passes a missing word join through as null surfaces", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    upgradeWorkOrders.list.mockResolvedValueOnce([
      { ...ORDER_LIST_ITEM, wordSlug: null, wordText: null },
    ]);
    const app = createApp(services);

    const res = await app.request(`/api/upgrade-work-orders?wordbookId=${WORDBOOK_ID}`, {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ word: unknown }> };
    expect(body.items[0]!.word).toEqual({ slug: null, text: null });
  });

  it("GET / requires wordbookId instead of falling back to the default wordbook", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/upgrade-work-orders", { headers: AUTH_HEADERS });

    await expectRouteValidationError(res);
    expect(upgradeWorkOrders.list).not.toHaveBeenCalled();
  });

  it("POST /:id/start transitions the work order", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/upgrade-work-orders/${ORDER_ID}/start`, {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "升级中" });
    expect(upgradeWorkOrders.start).toHaveBeenCalledWith("user-123", ORDER_ID);
  });

  it("POST /:id/cancel transitions the work order", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/upgrade-work-orders/${ORDER_ID}/cancel`, {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(upgradeWorkOrders.cancel).toHaveBeenCalledWith("user-123", ORDER_ID);
  });

  it("POST /:id/complete returns the promotion result", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/upgrade-work-orders/${ORDER_ID}/complete`, {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ alreadyPromoted: false, seeded: false, l2DueAt: null });
    expect(upgradeWorkOrders.complete).toHaveBeenCalledWith("user-123", ORDER_ID);
  });

  it("rejects a non-uuid path id before any service call", async () => {
    const { services, upgradeWorkOrders } = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/upgrade-work-orders/not-a-uuid/start", {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    await expectRouteValidationError(res);
    expect(upgradeWorkOrders.start).not.toHaveBeenCalled();
  });

  it("maps service NotFound to 404 and BusinessRule to 422", async () => {
    const missing = makeMockServices();
    missing.upgradeWorkOrders.start = vi.fn(async () => {
      throw new NotFoundError("UpgradeWorkOrder", ORDER_ID);
    });
    const missingApp = createApp(missing.services);
    await expectServiceError(await missingApp.request(`/api/upgrade-work-orders/${ORDER_ID}/start`, {
      method: "POST",
      headers: AUTH_HEADERS,
    }), 404, "NOT_FOUND");

    const blocked = makeMockServices();
    blocked.upgradeWorkOrders.complete = vi.fn(async () => {
      throw new BusinessRuleError("Cancelled upgrade work order cannot be completed");
    });
    const blockedApp = createApp(blocked.services);
    await expectServiceError(await blockedApp.request(`/api/upgrade-work-orders/${ORDER_ID}/complete`, {
      method: "POST",
      headers: AUTH_HEADERS,
    }), 422, "BUSINESS_RULE");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { services } = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/upgrade-work-orders");
    expect(res.status).toBe(401);
  });
});
