/**
 * GET /api/l3/capabilities（ADR-0029 §8② / T13c）——能力发现读面。
 *
 * 本套件钉三件事：
 * 1) 门禁：agent token（以及 owner token）可读，未认证 401；
 * 2) 单一真源：limits 的每个数字必须**等于** src/schemas/resource-budget.ts 的
 *    对应常量——实现里若复制字面值，常量一改本测试即红（禁止第二套真源）；
 * 3) errorCodes 词表必须等于 src/errors/codes.ts 的 ERROR_CODES 单一导出。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { ERROR_CODES } from "@/errors/codes";
import {
  API_JSON_BODY_MAX_BYTES,
  JSON_MAX_DEPTH,
  JSON_RECORD_MAX_BYTES,
  L3_PROPOSAL_MAX_ITEMS,
  L3_PROPOSAL_PAYLOAD_MAX_BYTES,
  L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
} from "@/schemas/resource-budget";
import { l3CapabilitiesResponseSchema, type L3Capabilities } from "@/http/l3-response-contract";

const ORIGINAL = {
  owner: process.env.OWNER_API_TOKEN,
  agents: process.env.AGENT_API_TOKENS,
  localOwner: process.env.LOCAL_OWNER_ID,
};

const OWNER_TOKEN = "owner-capabilities-probe";
const AGENT_TOKEN = "agent-capabilities-probe-secret";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = `capabilities-agent:${AGENT_TOKEN}`;
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL.owner;
  process.env.AGENT_API_TOKENS = ORIGINAL.agents;
  process.env.LOCAL_OWNER_ID = ORIGINAL.localOwner;
});

// capabilities 是纯静态读面（不触任何 service）：空 services 即可挂载全 app。
const app = createApp({ authSessions: undefined } as unknown as Services);

async function fetchCapabilities(token?: string): Promise<Response> {
  return app.request("/api/l3/capabilities", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /api/l3/capabilities", () => {
  it("serves the discovery payload to agent tokens with role=agent", async () => {
    const res = await fetchCapabilities(AGENT_TOKEN);
    expect(res.status).toBe(200);
    const body = l3CapabilitiesResponseSchema.parse(await res.json()) as L3Capabilities;
    expect(body.role).toBe("agent");
    expect(body.access).toEqual({ read: "all", write: "proposal_only", upgrade: "owner_only" });
    // 批次二（ADR-0034 §4）：评卷授权语义登记（提交即授权；执行面批次三）。
    expect(body.grading).toEqual({
      annotationReadScope: "submitted_sheet_drafts",
      annotationWriteScope: "review_only",
    });
  });

  it("serves the same shape to owner tokens with role=owner", async () => {
    const res = await fetchCapabilities(OWNER_TOKEN);
    expect(res.status).toBe(200);
    const body = l3CapabilitiesResponseSchema.parse(await res.json()) as L3Capabilities;
    expect(body.role).toBe("owner");
  });

  it("requires authentication", async () => {
    const res = await fetchCapabilities();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("keeps every limit equal to the resource-budget single source", async () => {
    const body = l3CapabilitiesResponseSchema.parse(
      await (await fetchCapabilities(AGENT_TOKEN)).json(),
    ) as L3Capabilities;
    expect(body.limits).toEqual({
      apiJsonBodyMaxBytes: API_JSON_BODY_MAX_BYTES,
      jsonRecordMaxBytes: JSON_RECORD_MAX_BYTES,
      jsonMaxDepth: JSON_MAX_DEPTH,
      proposalMaxItems: L3_PROPOSAL_MAX_ITEMS,
      proposalPayloadMaxBytes: L3_PROPOSAL_PAYLOAD_MAX_BYTES,
      proposalTotalPayloadMaxBytes: L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
    });
  });

  it("keeps the error code vocabulary equal to the errors/codes single export", async () => {
    const body = l3CapabilitiesResponseSchema.parse(
      await (await fetchCapabilities(AGENT_TOKEN)).json(),
    ) as L3Capabilities;
    expect(body.errorCodes).toEqual(Object.values(ERROR_CODES));
  });
});
