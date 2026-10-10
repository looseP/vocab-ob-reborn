import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { reviewCardsMutationResponseSchema } from "@/http/review-cards-response-contract";

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

function makeMockServices(): Services {
  return {
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: "wb-default" }),
    },
    reviewCards: {
      removeCards: vi.fn().mockResolvedValue({ ok: true, count: 2, wordIds: ["w-1", "w-2"] }),
      expireCards: vi.fn().mockResolvedValue({ ok: true, count: 1, wordIds: ["w-3"] }),
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };

/** batchAddToReviewSchema 的 wordIds 是 UUID 数组 —— 测试须用合法 UUID。 */
const W1 = "00000000-0000-4000-8000-000000000101";
const W2 = "00000000-0000-4000-8000-000000000102";
const W3 = "00000000-0000-4000-8000-000000000103";
const WB = "00000000-0000-4000-8000-000000000001";

describe("POST /api/review/cards/remove（P1 移出队列）", () => {
  it("按显式 wordbookId 转发并以契约形状返回", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/cards/remove", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordIds: [W1, W2], wordbookId: WB }),
    });

    expect(res.status).toBe(200);
    const body = reviewCardsMutationResponseSchema.parse(await res.json());
    expect(body).toEqual({ ok: true, count: 2, wordIds: ["w-1", "w-2"] });
    expect(services.reviewCards.removeCards).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: WB,
      wordIds: [W1, W2],
    });
  });

  it("缺省 wordbookId 回退默认词书", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/cards/remove", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordIds: [W1] }),
    });

    expect(res.status).toBe(200);
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.reviewCards.removeCards).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: "wb-default",
      wordIds: [W1],
    });
  });

  it("空 wordIds 返回 400（validation）", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/cards/remove", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordIds: [] }),
    });

    expect(res.status).toBe(400);
    expect(services.reviewCards.removeCards).not.toHaveBeenCalled();
  });
});

describe("POST /api/review/cards/expire（P1 提前到期）", () => {
  it("转发并返回实际变更的 id（契约形状）", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/cards/expire", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ wordIds: [W3] }),
    });

    expect(res.status).toBe(200);
    const body = reviewCardsMutationResponseSchema.parse(await res.json());
    expect(body).toEqual({ ok: true, count: 1, wordIds: ["w-3"] });
    expect(services.reviewCards.expireCards).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: "wb-default",
      wordIds: [W3],
    });
  });
});
