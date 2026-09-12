/**
 * GET /api/l3/space-summary（B1 素材宇宙）——空间汇总读面。
 *
 * 本套件钉四件事：
 * 1) 门禁：agent / owner token 可读（minRole=agent），未认证 401；
 * 2) 形状：响应严格符合 l3SpaceSummaryResponseSchema（.strict()）；
 * 3) 透传：actor 与 days→windowDays 映射（默认 30）；
 * 4) 校验：days 越界 / 非数字 → 400 VALIDATION_ERROR。
 *
 * services 用最小 mock（本端点只触 l3Context.getSpaceSummary）；
 * createApp 构造期不调用任何 service 方法（capabilities 测试同款先例）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { l3SpaceSummaryResponseSchema } from "@/http/l3-summary-response-contract";

const ORIGINAL = {
  owner: process.env.OWNER_API_TOKEN,
  agents: process.env.AGENT_API_TOKENS,
  localOwner: process.env.LOCAL_OWNER_ID,
};

const OWNER_TOKEN = "owner-space-summary-probe";
const AGENT_TOKEN = "agent-space-summary-probe-secret";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = `summary-agent:${AGENT_TOKEN}`;
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL.owner;
  process.env.AGENT_API_TOKENS = ORIGINAL.agents;
  process.env.LOCAL_OWNER_ID = ORIGINAL.localOwner;
});

const SUMMARY = {
  counts: { sourceCount: 2, contextCount: 5, occurrenceCount: 7, linkCount: 1 },
  growth: {
    windowDays: 30,
    byDay: [{ day: "2026-09-08", sourceCount: 2, contextCount: 5, occurrenceCount: 7, linkCount: 1 }],
  },
};

const getSpaceSummary = vi.fn(async () => SUMMARY);
const app = createApp({ l3Context: { getSpaceSummary } } as unknown as Services);

async function fetchSummary(query = "", token?: string): Promise<Response> {
  return app.request(`/api/l3/space-summary${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /api/l3/space-summary", () => {
  it("serves the summary to owner tokens and passes the actor with the default window", async () => {
    getSpaceSummary.mockClear();
    const res = await fetchSummary("", OWNER_TOKEN);
    expect(res.status).toBe(200);
    const body = l3SpaceSummaryResponseSchema.parse(await res.json());
    expect(body).toEqual(SUMMARY);
    expect(getSpaceSummary).toHaveBeenCalledWith({ userId: "user-123", windowDays: 30 });
  });

  it("maps ?days to the service window and lets agent tokens read", async () => {
    getSpaceSummary.mockClear();
    const res = await fetchSummary("?days=7", AGENT_TOKEN);
    expect(res.status).toBe(200);
    l3SpaceSummaryResponseSchema.parse(await res.json());
    expect(getSpaceSummary).toHaveBeenCalledWith({ userId: expect.any(String), windowDays: 7 });
  });

  it("requires authentication", async () => {
    const res = await fetchSummary();
    expect(res.status).toBe(401);
  });

  it("rejects out-of-range or non-numeric days with 400", async () => {
    getSpaceSummary.mockClear();
    for (const bad of ["?days=0", "?days=91", "?days=abc"]) {
      const res = await fetchSummary(bad, OWNER_TOKEN);
      expect(res.status, bad).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code, bad).toBe("VALIDATION_ERROR");
    }
    expect(getSpaceSummary).not.toHaveBeenCalled();
  });
});
