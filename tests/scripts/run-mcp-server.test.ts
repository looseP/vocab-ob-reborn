/**
 * MCP 冒烟（T13c）：真实子进程 + 真实 HTTP app（stub services）。
 *
 * 验证四件事：
 * 1) tools/list 不再包含 confirm_l2_content（ADR-0029 §3 下线），且没有任何
 *    升级动作（confirm / accept / validate / apply / cancel）工具；
 * 2) 每个工具 description 都标注"产物进 proposal、需人工确认"（ADR-0029 §8①）；
 * 3) 新增 L3 工具可调：space/direction 过滤经桥转发到真实路由（§6①/②）；
 * 4) agent token 经 MCP 提交的提案进 pending（source_type=agent、agentId 由
 *    服务端认定），升级动作对 agent 403。
 *
 * 桥本身是零依赖 stdio 进程：直接 spawn scripts/run-mcp-server.mjs，
 * VOCAB_MCP_BASE_URL 指向本测试启动的真实 Hono app（getRequestListener）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
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

const MCP_SCRIPT = fileURLToPath(new URL("../../scripts/run-mcp-server.mjs", import.meta.url));
const ORIGINAL = {
  owner: process.env.OWNER_API_TOKEN,
  agents: process.env.AGENT_API_TOKENS,
  localOwner: process.env.LOCAL_OWNER_ID,
};

const OWNER_TOKEN = "owner-mcp-smoke";
const AGENT_ID = "smoke-agent";
const AGENT_TOKEN = "smoke-agent-secret";

// ── stub services（本套件只钉桥↔HTTP 边界，不触 DB）────────────────────────

type ProposalInput = {
  userId: string;
  agentId: string | null;
  sourceType: string;
  items: Array<{ itemType: string; clientRef: string | null; payload: Record<string, unknown> }>;
};

function makeServices() {
  const l3Proposal = {
    createProposal: vi.fn(async (_input: ProposalInput) => ({
      proposal: { id: "prop-smoke", status: "pending", source_type: "agent" },
      items: [],
    })),
  };
  const l3Context = {
    listSources: vi.fn(async (input: Record<string, unknown>) => ({
      items: [{ id: "src-1", title: "Essay" }],
      limit: 20,
      offset: 0,
      total: 1,
      echo: input,
    })),
    listContextsForWord: vi.fn(async () => ({ items: [], limit: 50, cursor: null, nextCursor: null })),
    listOccurrences: vi.fn(async (input: Record<string, unknown>) => ({
      items: [{ id: "occ-1" }],
      limit: 50,
      cursor: null,
      nextCursor: null,
      echo: input,
    })),
    listContextLinks: vi.fn(async () => ({ items: [], limit: 50, cursor: null, nextCursor: null })),
  };
  return { authSessions: undefined, l3Proposal, l3Context } as unknown as Services;
}

function firstCallArg<T>(method: unknown): T {
  return (method as { mock: { calls: Array<[T]> } }).mock.calls[0][0];
}

// ── 真实 app + MCP 子进程 ─────────────────────────────────────────────────

type JsonRpcMessage = { id?: number; result?: unknown; error?: { code: number; message: string } };

let server: Server;
let child: ChildProcess;
let services: Services;
let requestId = 0;
let app: ReturnType<typeof createApp>;
const pending = new Map<number, (message: JsonRpcMessage) => void>();

function mcpRequest(method: string, params?: unknown): Promise<JsonRpcMessage> {
  const id = ++requestId;
  return new Promise<JsonRpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function toolResultText(message: JsonRpcMessage): Record<string, unknown> {
  const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = `${AGENT_ID}:${AGENT_TOKEN}`;
  process.env.LOCAL_OWNER_ID = "user-123";

  services = makeServices();
  app = createApp(services);
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  child = spawn(process.execPath, [MCP_SCRIPT], {
    env: {
      ...process.env,
      VOCAB_MCP_BASE_URL: `http://127.0.0.1:${port}`,
      VOCAB_MCP_TOKEN: AGENT_TOKEN,
      VOCAB_MCP_TIMEOUT_MS: "10000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") pending.get(message.id)?.(message);
    if (typeof message.id === "number") pending.delete(message.id);
  });

  const initialized = await mcpRequest("initialize", { protocolVersion: "2025-06-18" });
  expect((initialized.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("vocab-observatory");
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.OWNER_API_TOKEN = ORIGINAL.owner;
  process.env.AGENT_API_TOKENS = ORIGINAL.agents;
  process.env.LOCAL_OWNER_ID = ORIGINAL.localOwner;
});

// ── 工具面 ────────────────────────────────────────────────────────────────

async function listTools(): Promise<Array<{ name: string; description: string }>> {
  const message = await mcpRequest("tools/list");
  return (message.result as { tools: Array<{ name: string; description: string }> }).tools;
}

describe("MCP tools/list (T13c 工具面)", () => {
  it("exposes exactly the L2 + L3 tool set and no confirm_l2_content", async () => {
    const names = (await listTools()).map((tool) => tool.name);
    expect(names).toEqual([
      "search_words",
      "get_word_detail",
      "build_l2_prompt",
      "propose_l2_content",
      "list_l2_candidates",
      "list_l3_sources",
      "list_l3_word_contexts",
      "list_l3_occurrences",
      "list_l3_context_links",
      "submit_l3_proposal",
      "get_capabilities",
    ]);
    expect(names).not.toContain("confirm_l2_content");
  });

  it("annotates every tool with the proposal / human-confirmation note", async () => {
    for (const tool of await listTools()) {
      expect(tool.description, tool.name).toContain("产物进 proposal、需人工确认");
    }
  });

  it("never exposes an upgrade action name (confirm / accept / validate / apply / cancel)", async () => {
    for (const tool of await listTools()) {
      expect(tool.name, tool.name).not.toMatch(/confirm|accept|validate|apply|cancel/i);
    }
  });

  it("surfaces unknown tools as JSON-RPC errors, not crashes", async () => {
    const message = await mcpRequest("tools/call", { name: "confirm_l2_content", arguments: {} });
    expect(message.error?.message).toContain("unknown tool");
  });
});

// ── 新 L3 工具可调（转发语义）────────────────────────────────────────────

describe("MCP L3 tool calls", () => {
  it("forwards space/direction filters through list_l3_sources", async () => {
    const message = await mcpRequest("tools/call", {
      name: "list_l3_sources",
      arguments: { space: "阅读", direction: "考研", sort: "captures" },
    });
    expect(message.result).toBeDefined();
    const echo = toolResultText(message).echo as Record<string, unknown>;
    expect(echo).toMatchObject({ userId: "user-123", space: "阅读", direction: "考研", sort: "captures" });
  });

  it("forwards word filters through list_l3_occurrences", async () => {
    const message = await mcpRequest("tools/call", {
      name: "list_l3_occurrences",
      arguments: { slug: "orbit", space: "阅读" },
    });
    expect(message.result).toBeDefined();
    const echo = toolResultText(message).echo as Record<string, unknown>;
    expect(echo).toMatchObject({ userId: "user-123", slug: "orbit", space: "阅读" });
  });

  it("reads the capability envelope through get_capabilities", async () => {
    const message = await mcpRequest("tools/call", { name: "get_capabilities", arguments: {} });
    const body = toolResultText(message);
    expect(body.role).toBe("agent");
    expect(body.access).toEqual({ read: "all", write: "proposal_only", upgrade: "owner_only" });
  });
});

// ── 提案通道（agent token 进 pending）＋升级动作不可达 ─────────────────────

describe("MCP proposal channel (agent token)", () => {
  it("submits a pending proposal with server-asserted agentId and sourceType=agent", async () => {
    const message = await mcpRequest("tools/call", {
      name: "submit_l3_proposal",
      arguments: {
        title: "Candidate contexts",
        inputHash: "smoke-1",
        items: [
          {
            itemType: "context",
            clientRef: "ctx-a",
            payload: { contextType: "sentence", text: "She gave a vivid account.", sourceRef: "src-a" },
          },
        ],
      },
    });

    const arg = firstCallArg<ProposalInput>(services.l3Proposal.createProposal);
    // 工具固定 source_type=agent；agentId 由服务端从 AGENT_API_TOKENS 认定（非自述）。
    expect(arg.sourceType).toBe("agent");
    expect(arg.agentId).toBe(AGENT_ID);
    expect(arg.items).toEqual([
      { itemType: "context", clientRef: "ctx-a", payload: { contextType: "sentence", text: "She gave a vivid account.", sourceRef: "src-a" } },
    ]);
    // 桥返回服务端 bundle：写入一律 pending（人工确认前不进入权威数据）。
    const bundle = toolResultText(message) as { proposal?: { status?: string } };
    expect(bundle.proposal?.status).toBe("pending");
  });

  it("keeps upgrade actions unreachable for agent tokens (403)", async () => {
    const res = await app.request("/api/l3/proposals/prop-smoke/confirm", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });
});
