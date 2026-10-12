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
  // dueToday(18) > dueNow(15)：差的 3 张是「今天稍后到点」的卡 —— 2026-10-12 用户报
  // 「仪表盘 1 / 队列 0 像调度坏了」的那个差，也是 dueWindow facet 存在的原因。
  counts: { due: 12, learning: 3, review: 40, new: 100, suspended: 2, dueNow: 15, dueToday: 18, laterToday: 3, total: 157 },
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
      dueWindow: null,
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
      dueWindow: null,
      search: "abandon",
      limit: 20,
      offset: 40,
    });
  });

  it("dueWindow=today 透传（「今日到期」facet：仪表盘那个数的清单）", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/queue/list?dueWindow=today&limit=20", {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(services.reviewCards.listQueue).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: "wb-default",
      bucket: "all",
      dueWindow: "today",
      search: null,
      limit: 20,
      offset: 0,
    });
    // 契约里 dueToday 与 dueNow 并列，前端 tab 徽标直接用
    const body = reviewQueueListResponseSchema.parse(await res.json());
    expect(body.counts.dueToday).toBe(18);
    expect(body.counts.dueNow).toBe(15);
  });

  it("未知 dueWindow 返回 400（zod enum 拒绝，绝不把非法值带进仓储）", async () => {
    const services = makeMockServices();
    const app = createApp(services);

    const res = await app.request("/api/review/queue/list?dueWindow=this-week", {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(400);
    expect(services.reviewCards.listQueue).not.toHaveBeenCalled();
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
