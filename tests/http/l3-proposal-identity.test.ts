/**
 * ADR-0029 §5：agentId 是服务端认定的信任锚——agent bearer 的写入必须能把
 * Principal.agentId 送达 proposal 的 provenance；client 自述的 provenance.agentId
 * 不得冒充服务端认定值。
 *
 * 分层职责（本文件只钉 HTTP→service 边界，stub services，不触 DB）：
 *   - 路由：把 `Principal.agentId`（owner 路径为 null）作为**独立入参**传给
 *     service，请求体 provenance 原样透传（不合并、不剥离）；
 *   - service：合并语义（服务端 agentId 覆盖客户端自述、owner 无锚不动原
 *     provenance）落库，由 tests/services/l3-proposal.test.ts 的 provenance
 *     用例与迁移 0031 保障。
 *
 * 覆盖三条 agent 可写、且有 proposal 产物的路由：POST /api/l3/proposals、
 * POST /api/l3/imports/raw-text、POST /api/l3/imports/structured。
 * （POST /api/l2/:slug/external-prompt 纯组装不落库、无 proposal provenance，
 * 不在本文件范围。）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { createMockPool } from "../helpers/mock-db";

const mockDb = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mockDb.pool,
  getBatchImportPool: () => mockDb.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
  pool: () => mockDb.pool,
}));

const ORIGINAL = {
  owner: process.env.OWNER_API_TOKEN,
  agents: process.env.AGENT_API_TOKENS,
  localOwner: process.env.LOCAL_OWNER_ID,
};

const OWNER_TOKEN = "test-owner-identity";
const AGENT_ID = "probe-agent";
const AGENT_TOKEN = "probe-agent-secret";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = `${AGENT_ID}:${AGENT_TOKEN}`;
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL.owner;
  process.env.AGENT_API_TOKENS = ORIGINAL.agents;
  process.env.LOCAL_OWNER_ID = ORIGINAL.localOwner;
});

const OWNER_HEADERS = {
  Authorization: `Bearer ${OWNER_TOKEN}`,
  "Content-Type": "application/json",
};
const AGENT_HEADERS = {
  Authorization: `Bearer ${AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

function firstCallArg<T>(method: unknown): T {
  return (method as { mock: { calls: Array<[T]> } }).mock.calls[0][0];
}

function makeServices() {
  const l3Proposal = {
    createProposal: vi.fn(async () => ({ proposal: { id: "prop-1", status: "pending" }, items: [] })),
  };
  const l3Import = {
    createRawTextImportProposal: vi.fn(async () => ({
      importJob: { id: "job-1", status: "completed" },
      proposal: { id: "prop-1", status: "pending" },
      items: [],
      parseStats: { contextCount: 1, occurrenceCount: 1, linkCount: 0, skippedContextCount: 0, warnings: [] },
    })),
    createStructuredImportProposal: vi.fn(async () => ({
      importJob: { id: "job-1", status: "completed" },
      proposal: { id: "prop-1", status: "pending" },
      items: [],
      parseStats: { contextCount: 1, occurrenceCount: 1, linkCount: 1, skippedContextCount: 0, warnings: [] },
    })),
  };
  return {
    authSessions: undefined,
    l3Proposal,
    l3Import,
  } as unknown as Services;
}

type ProvenanceArg = {
  userId: string;
  provenance: { agentId?: string; note?: string };
  agentId?: string | null;
};

const PROPOSAL_BODY = {
  sourceType: "agent",
  title: "Candidate contexts",
  items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
};

const RAW_TEXT_BODY = {
  source: { sourceType: "article", title: "Essay", language: "en" },
  text: "She gave a vivid account.",
  targetWords: [{ slug: "vivid" }],
  options: { contextType: "sentence" },
};

const STRUCTURED_BODY = {
  source: { sourceType: "manual", title: "Examples" },
  contexts: [{
    clientRef: "ctx-1",
    contextType: "sentence",
    text: "She gave a vivid account.",
    occurrences: [{ slug: "vivid", surface: "vivid", startOffset: 11, endOffset: 16 }],
  }],
};

describe("ADR-0029 §5 agent identity stamping (proposal provenance)", () => {
  it("passes the server-asserted agentId to the service on POST /api/l3/proposals", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/proposals", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({
        ...PROPOSAL_BODY,
        provenance: { note: "from-mcp", agentId: "self-declared-lie" },
      }),
    });

    expect(res.status).toBe(201);
    const arg = firstCallArg<ProvenanceArg>(services.l3Proposal.createProposal);
    // 服务端认定锚经独立入参下传（agent bearer 必有值）。
    expect(arg.agentId).toBe(AGENT_ID);
    // 请求体 provenance 原样透传（合并/覆盖发生在 service 层，见服务层用例）。
    expect(arg.provenance.note).toBe("from-mcp");
    expect(arg.provenance.agentId).toBe("self-declared-lie");
  });

  it("passes agentId=null and untouched provenance for owner bearers on POST /api/l3/proposals", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/proposals", {
      method: "POST",
      headers: OWNER_HEADERS,
      body: JSON.stringify({
        ...PROPOSAL_BODY,
        provenance: { note: "from-owner", agentId: "self-declared-lie" },
      }),
    });

    expect(res.status).toBe(201);
    const arg = firstCallArg<ProvenanceArg>(services.l3Proposal.createProposal);
    // owner 无服务端认定锚：入参为 null（service 层不注入、不动原 provenance）。
    expect(arg.agentId ?? null).toBeNull();
    expect(arg.provenance.note).toBe("from-owner");
    expect(arg.provenance.agentId).toBe("self-declared-lie");
  });

  it("passes the server-asserted agentId on POST /api/l3/imports/raw-text", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/imports/raw-text", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({ ...RAW_TEXT_BODY, provenance: { note: "raw" } }),
    });

    expect(res.status).toBe(201);
    const arg = firstCallArg<ProvenanceArg>(services.l3Import.createRawTextImportProposal);
    expect(arg.agentId).toBe(AGENT_ID);
    expect(arg.provenance.note).toBe("raw");
  });

  it("passes the server-asserted agentId on POST /api/l3/imports/structured", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/imports/structured", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify({ ...STRUCTURED_BODY, provenance: { agentId: "self-declared-lie" } }),
    });

    expect(res.status).toBe(201);
    const arg = firstCallArg<ProvenanceArg>(services.l3Import.createStructuredImportProposal);
    expect(arg.agentId).toBe(AGENT_ID);
  });

  it("passes agentId=null for owner bearers on POST /api/l3/imports/raw-text", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/imports/raw-text", {
      method: "POST",
      headers: OWNER_HEADERS,
      body: JSON.stringify({ ...RAW_TEXT_BODY, provenance: { agentId: "self-declared-lie", note: "owner-raw" } }),
    });

    expect(res.status).toBe(201);
    const arg = firstCallArg<ProvenanceArg>(services.l3Import.createRawTextImportProposal);
    expect(arg.agentId ?? null).toBeNull();
    expect(arg.provenance.note).toBe("owner-raw");
    expect(arg.provenance.agentId).toBe("self-declared-lie");
  });
});
