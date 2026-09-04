import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { reviewDashboardStatsResponseSchema } from "@/http/review-response-contract";

// ── Auth env setup ──────────────────────────────────────────────────────
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

// ── Fixtures ────────────────────────────────────────────────────────────
const WORDBOOK_ID = "33333333-3333-4333-8333-333333333333";

const SUMMARY = {
  totalWords: 100,
  trackedWords: 40,
  dueToday: 12,
  reviewedToday: 5,
  reviewed7d: 30,
  reviewed30d: 80,
  streakDays: 3,
  notesCount: 7,
} as const;

const RATING_DIST = { again: 2, hard: 3, good: 20, easy: 10 } as const;

const FORECAST = { dueNow: 12, due7d: 18, due14d: 24 } as const;

// ── Mock services (no DB) ───────────────────────────────────────────────
function makeMockServices(): Services {
  return {
    words: {} as never,
    reviews: {} as never,
    notes: {} as never,
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: WORDBOOK_ID }),
    },
    stats: {
      getDashboardSummary: vi.fn().mockResolvedValue(SUMMARY),
      getRatingDistribution: vi.fn().mockResolvedValue(RATING_DIST),
      computeForecast: vi.fn(() => FORECAST),
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

// ── Tests ───────────────────────────────────────────────────────────────
describe("GET /api/review/stats/dashboard", () => {
  it("returns dashboard summary with streak, rating distribution and forecast", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/review/stats/dashboard", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = reviewDashboardStatsResponseSchema.parse(await res.json());
    expect(body).toEqual({ ...SUMMARY, ratingDist: RATING_DIST, forecast: FORECAST });

    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.stats.getDashboardSummary).toHaveBeenCalledWith("user-123", WORDBOOK_ID);
    expect(services.stats.getRatingDistribution).toHaveBeenCalledWith("user-123", WORDBOOK_ID);
    expect(services.stats.computeForecast).toHaveBeenCalledWith(SUMMARY);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createApp(makeMockServices());
    const res = await app.request("/api/review/stats/dashboard");
    expect(res.status).toBe(401);
  });
});
