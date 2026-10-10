import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { reviewQueueListResponseSchema } from "@/http/review-queue-list-response-contract";

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

const QUEUE_PAYLOAD = {
  counts: { due: 12, learning: 3, review: 40, new: 100, suspended: 2, dueNow: 15, total: 157 },
  items: [
    {
      wordId: "w-1",
      slug: "abandon",
      title: "abandon",
      lemma: "abandon",
      shortDefinition: "放弃",
      pos: "v",
      cefr: "B2",
      state: "review",
      dueAt: "2026-10-09T08:00:00.000Z",
      reviewCount: 4,
      lapseCount: 0,
      stability: 12.5,
      intervalDays: 9,
      lastReviewedAt: "2026-09-30T08:00:00.000Z",
      lastRating: "good",
      needsRecheck: false,
    },
  ],
  total: 157,
  limit: 50,
  offset: 0,
  hasMore: true,
};

function makeMockServices(): Services {
  return {
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: "wb-default" }),
    },
    reviewCards: {
      listQueue: vi.fn().mockResolvedValue(QUEUE_PAYLOAD),
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };
const WB = "00000000-0000-4000-8000-000000000001";

describe("GET /api/review/queue/list（P1 队列全景）", () => {
  it("缺省参数转发（bucket=all / limit=50 / offset=0）并以契约形状返回", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/queue/list", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = reviewQueueListResponseSchema.parse(await res.json());
    expect(body.counts.dueNow).toBe(15);
    expect(body.items[0].lemma).toBe("abandon");
    expect(body.hasMore).toBe(true);
    expect(services.reviewCards.listQueue).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: "wb-default",
      bucket: "all",
      search: null,
      limit: 50,
      offset: 0,
    });
  });

  it("显式 wordbookId + bucket + 搜索词 + 分页全部透传", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request(
      `/api/review/queue/list?wordbookId=${WB}&bucket=due&q=abandon&limit=20&offset=40`,
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(200);
    expect(services.reviewCards.listQueue).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: WB,
      bucket: "due",
      search: "abandon",
      limit: 20,
      offset: 40,
    });
  });

  it("未知 bucket 返回 400（zod enum 拒绝，绝不把非法值带进仓储）", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/queue/list?bucket=whatever", { headers: AUTH_HEADERS });

    expect(res.status).toBe(400);
    expect(services.reviewCards.listQueue).not.toHaveBeenCalled();
  });

  it("limit 超过上限返回 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/queue/list?limit=5000", { headers: AUTH_HEADERS });

    expect(res.status).toBe(400);
    expect(services.reviewCards.listQueue).not.toHaveBeenCalled();
  });

  it("超长搜索词返回 400（避免 ILIKE 全表扫）", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request(`/api/review/queue/list?q=${"x".repeat(81)}`, {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(400);
    expect(services.reviewCards.listQueue).not.toHaveBeenCalled();
  });

  it("无鉴权返回 401", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/queue/list");

    expect(res.status).toBe(401);
    expect(services.reviewCards.listQueue).not.toHaveBeenCalled();
  });
});
