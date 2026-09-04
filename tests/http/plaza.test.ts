import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { NotFoundError } from "@/errors";
import {
  plazaOverviewResponseSchema,
  plazaCollectionResponseSchema,
  plazaRootsResponseSchema,
  plazaReviewStatsResponseSchema,
  rootCollectionDetailResponseSchema,
} from "@/http/plaza-response-contract";

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
    plaza: {
      getOverview: vi.fn().mockResolvedValue({
        available: true,
        counts: { showing: 1, total: 1 },
        groups: [{
          kind: "semantic_field",
          label: "语义场",
          count: 1,
          collections: [{
            slug: "semantic-学校教育",
            title: "学校教育",
            kind: "semantic_field",
            count: 401,
            updatedAt: "2026-08-28T00:00:00.000Z",
          }],
        }],
        total: 1,
      }),
      getCollection: vi.fn().mockResolvedValue({
        slug: "semantic-学校教育",
        title: "学校教育",
        kind: "semantic_field",
        count: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
        words: [{
          id: "w-1",
          slug: "abound",
          lemma: "abound",
          cefr: "B2",
          short_definition: "大量存在",
          semantic_chain: "丰富 -> 大量存在",
        }],
      }),
      getRootsOverview: vi.fn().mockResolvedValue({
        available: true,
        counts: { showing: 1, total: 1 },
        collections: [{
          slug: "root-chart",
          title: "chart",
          kind: "root_affix",
          count: 6,
          updatedAt: "2026-08-28T00:00:00.000Z",
        }],
        total: 1,
      }),
      getRootCollection: vi.fn().mockResolvedValue({
        slug: "root-chart",
        title: "chart",
        kind: "root_affix",
        count: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
        type: "simple",
        words: [{
          id: "w-1",
          slug: "abound",
          lemma: "abound",
          cefr: "B2",
          short_definition: "大量存在",
          semantic_chain: "纸 -> 图表",
          root: "chart (from Late Latin charta)",
          prefix: null,
          suffix: null,
        }],
      }),
      getReviewStats: vi.fn().mockResolvedValue({ tracked: 5, due: 2 }),
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

describe("GET /api/plaza", () => {
  it("returns the plaza overview matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = plazaOverviewResponseSchema.parse(await res.json());
    expect(body.counts).toEqual({ showing: 1, total: 1 });
    expect(body.groups[0].collections[0].slug).toBe("semantic-学校教育");
    expect(services.plaza.getOverview).toHaveBeenCalledWith({ userId: "user-123", q: undefined });
  });

  it("passes q through to the service", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza?q=%E5%A4%AA%E7%A9%BA", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(services.plaza.getOverview).toHaveBeenCalledWith({ userId: "user-123", q: "太空" });
  });

  it("rejects missing credentials with 401", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/plaza/roots", () => {
  it("returns the roots overview matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza/roots?minCount=5&letter=t&q=tele", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = plazaRootsResponseSchema.parse(await res.json());
    expect(body.collections[0].slug).toBe("root-chart");
    expect(services.plaza.getRootsOverview).toHaveBeenCalledWith({
      userId: "user-123",
      minCount: 5,
      q: "tele",
      letter: "t",
    });
  });

  it("defaults minCount to 3 when omitted", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza/roots", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(services.plaza.getRootsOverview).toHaveBeenCalledWith({
      userId: "user-123",
      minCount: 3,
      q: undefined,
      letter: undefined,
    });
  });
});

describe("GET /api/plaza/collections/:slug", () => {
  it("returns the collection detail matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza/collections/semantic-%E5%AD%A6%E6%A0%A1%E6%95%99%E8%82%B2", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = plazaCollectionResponseSchema.parse(await res.json());
    expect(body.title).toBe("学校教育");
    expect(body.words).toHaveLength(1);
    expect(services.plaza.getCollection).toHaveBeenCalledWith({ userId: "user-123", slug: "semantic-学校教育" });
  });

  it("maps NotFoundError to 404", async () => {
    const services = makeMockServices();
    (services.plaza.getCollection as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundError("PlazaCollection", "nope"));
    const app = createApp(services);
    const res = await app.request("/api/plaza/collections/nope", { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
  });

  it("returns a root_affix collection detail with root structure cards", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza/roots/root-chart", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = rootCollectionDetailResponseSchema.parse(await res.json());
    expect(body.kind).toBe("root_affix");
    expect(body.type).toBe("simple");
    expect(body.words[0]).toMatchObject({ root: "chart (from Late Latin charta)", prefix: null, suffix: null });
    expect(services.plaza.getRootCollection).toHaveBeenCalledWith({ userId: "user-123", slug: "root-chart" });
  });
});

describe("GET /api/plaza/review-stats/:slug", () => {
  it("returns tracked/due counts matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza/review-stats/semantic-%E5%AD%A6%E6%A0%A1%E6%95%99%E8%82%B2", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = plazaReviewStatsResponseSchema.parse(await res.json());
    expect(body).toEqual({ tracked: 5, due: 2 });
    expect(services.plaza.getReviewStats).toHaveBeenCalledWith({ userId: "user-123", slug: "semantic-学校教育" });
  });

  it("maps NotFoundError to 404", async () => {
    const services = makeMockServices();
    (services.plaza.getReviewStats as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundError("PlazaCollection", "nope"));
    const app = createApp(services);
    const res = await app.request("/api/plaza/review-stats/nope", { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
  });
});
