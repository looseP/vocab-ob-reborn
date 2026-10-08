/**
 * M2 复习日历两条只读端点的回归锁。
 *
 * 锁的不是"能返回 200"，而是**口径**：
 *  ① 过去/未来/今天都走显示时区日历日（`today.date` 由服务端给，前端不自己算）；
 *  ② 「今天」的两个值**从两条序列里派生** —— 不额外查汇总，也就不会与卡片口径漂移；
 *  ③ 参数非法一律 400（而不是静默取默认值骗出一个看起来正常的响应）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { todayKeyInDisplayTz } from "@/db/timezone";
import {
  reviewCalendarResponseSchema,
  reviewDayResponseSchema,
} from "@/http/review-calendar-response-contract";

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
const TODAY = todayKeyInDisplayTz();
/** 昨天 / 明天（用 UTC 算术，避开本地时区）。 */
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const HEATMAP = [
  { date: YESTERDAY, count: "4" },
  { date: TODAY, count: "2" },
];
const DUE_BUCKETS = [
  { date: TODAY, count: 14 }, // 含积压
  { date: TOMORROW, count: 3 },
];

function makeMockServices(overrides: Partial<Record<string, unknown>> = {}): Services {
  return {
    words: {} as never,
    notes: {} as never,
    wordbooks: { getOrCreateDefault: vi.fn().mockResolvedValue({ id: WORDBOOK_ID }) },
    reviews: { getHeatmap: vi.fn().mockResolvedValue(HEATMAP) },
    stats: {
      getDailyDueCounts: vi.fn().mockResolvedValue(DUE_BUCKETS),
      getDayWords: vi.fn().mockResolvedValue({
        total: 1,
        items: [{ id: "w1", slug: "abide", title: "abide", lemma: "abide", shortDefinition: "遵守" }],
      }),
      ...overrides,
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

describe("GET /api/review/stats/calendar", () => {
  it("返回过去/今天/未来三段，且「今天」从两条序列派生（不额外查汇总）", async () => {
    const services = makeMockServices();
    const res = await createApp(services).request("/api/review/stats/calendar?days=30", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = reviewCalendarResponseSchema.parse(await res.json());
    expect(body.past).toEqual([
      { date: YESTERDAY, reviewed: 4 },
      { date: TODAY, reviewed: 2 },
    ]);
    expect(body.future).toEqual([
      { date: TODAY, due: 14 },
      { date: TOMORROW, due: 3 },
    ]);
    // 今天 = 序列里今天那一桶；date 由服务端给（前端不自己算时区）
    expect(body.today).toEqual({ date: TODAY, dueNow: 14, reviewedToday: 2 });
    expect(services.stats.getDailyDueCounts).toHaveBeenCalledWith("user-123", WORDBOOK_ID, 30);
    expect(services.reviews.getHeatmap).toHaveBeenCalledWith("user-123", WORDBOOK_ID, 30);
  });

  it("今天不在任何序列里时两个值都按 0（不是 undefined/NaN）", async () => {
    const services = makeMockServices();
    (services.reviews.getHeatmap as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (services.stats.getDailyDueCounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await createApp(services).request("/api/review/stats/calendar", { headers: AUTH_HEADERS });

    const body = reviewCalendarResponseSchema.parse(await res.json());
    expect(body.today).toEqual({ date: TODAY, dueNow: 0, reviewedToday: 0 });
    expect(body.past).toEqual([]);
  });

  it("days 越界被钳制在 [1,180]，非法值回落 30", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    await app.request("/api/review/stats/calendar?days=9999", { headers: AUTH_HEADERS });
    expect(services.stats.getDailyDueCounts).toHaveBeenLastCalledWith("user-123", WORDBOOK_ID, 180);
    await app.request("/api/review/stats/calendar?days=abc", { headers: AUTH_HEADERS });
    expect(services.stats.getDailyDueCounts).toHaveBeenLastCalledWith("user-123", WORDBOOK_ID, 30);
    await app.request("/api/review/stats/calendar?days=0", { headers: AUTH_HEADERS });
    expect(services.stats.getDailyDueCounts).toHaveBeenLastCalledWith("user-123", WORDBOOK_ID, 1);
  });

  it("未认证 401", async () => {
    const res = await createApp(makeMockServices()).request("/api/review/stats/calendar");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/review/day", () => {
  it("按 date+scope 取当日词表", async () => {
    const services = makeMockServices();
    const res = await createApp(services).request(
      `/api/review/day?date=${YESTERDAY}&scope=reviewed&limit=10`,
      { headers: AUTH_HEADERS },
    );

    expect(res.status).toBe(200);
    const body = reviewDayResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ date: YESTERDAY, scope: "reviewed", total: 1 });
    expect(body.items[0].lemma).toBe("abide");
    expect(services.stats.getDayWords).toHaveBeenCalledWith("user-123", WORDBOOK_ID, YESTERDAY, "reviewed", 10);
  });

  it("date 非法或 scope 非法 → 400（不静默取默认值）", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    expect((await app.request("/api/review/day?date=2026-13-99&scope=due", { headers: AUTH_HEADERS })).status).toBe(400);
    expect((await app.request("/api/review/day?date=2026-10-07&scope=whatever", { headers: AUTH_HEADERS })).status).toBe(400);
    expect((await app.request("/api/review/day?scope=due", { headers: AUTH_HEADERS })).status).toBe(400);
    // 400 时不该碰仓储
    expect(services.stats.getDayWords).not.toHaveBeenCalled();
  });
});
