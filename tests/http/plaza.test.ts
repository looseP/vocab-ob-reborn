import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { NotFoundError } from "@/errors";
import {
  plazaOverviewResponseSchema,
  plazaCollectionResponseSchema,
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

describe("GET /api/plaza/collections/:slug", () => {
  it("returns the collection detail matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/plaza/collections/semantic-%E5%AD%A6%E6%A0%A1%E6%95%99%E8%82%B2", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = plazaCollectionResponseSchema.parse(await res.json());
    expect(body.title).toBe("学校教育");
    expect(body.words).toHaveLength(1);
    expect(services.plaza.getCollection).toHaveBeenCalledWith("semantic-学校教育");
  });

  it("maps NotFoundError to 404", async () => {
    const services = makeMockServices();
    (services.plaza.getCollection as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundError("PlazaCollection", "nope"));
    const app = createApp(services);
    const res = await app.request("/api/plaza/collections/nope", { headers: AUTH_HEADERS });
    expect(res.status).toBe(404);
  });
});
