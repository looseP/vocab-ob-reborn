#!/usr/bin/env node
/**
 * Vocab Observatory MCP server — zero-dependency stdio bridge.
 *
 * Speaks the Model Context Protocol (JSON-RPC 2.0, newline-delimited) on
 * stdin/stdout and proxies every tool call to the running Vocab Observatory
 * HTTP API with Bearer auth. All business rules (RLS actor, content budgets,
 * candidate pool semantics) stay server-side; this process holds no DB access.
 *
 * Tools (Phase G):
 *   search_words        find words by lemma/slug prefix (suggest endpoint)
 *   get_word_detail     full word detail incl. current L2 content
 *   build_l2_prompt     assemble the canonical external-generation prompt
 *   propose_l2_content  write an is_active=false candidate → user reviews it
 *                       in the word detail composer panel (采纳/忽略)
 *   confirm_l2_content  write content directly as ACTIVE (固定：缓存刷新 +
 *                       L2 软重卡)，跳过候选池
 *   list_l2_candidates  list pending candidates for a word
 *
 * Configuration (env):
 *   VOCAB_MCP_BASE_URL   API base URL           (default http://127.0.0.1:3001)
 *   VOCAB_MCP_TOKEN      Bearer token, required (OWNER_API_TOKEN or AGENT_API_TOKENS entry)
 *   VOCAB_MCP_TIMEOUT_MS per-request timeout    (default 60000)
 *
 * Local default token (compose.yaml): local-owner-api-token-only-0001
 */

import { createInterface } from "node:readline";

const BASE_URL = (process.env.VOCAB_MCP_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
const TOKEN = process.env.VOCAB_MCP_TOKEN ?? "";
const TIMEOUT_MS = Number(process.env.VOCAB_MCP_TIMEOUT_MS ?? 60000);

const SERVER_INFO = { name: "vocab-observatory", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────

function writeMessage(message) {
  // MCP stdio framing: one JSON value per line, no embedded newlines.
  process.stdout.write(`${JSON.stringify(message).replace(/\n/g, " ")}\n`);
}

function reply(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function notification(method, params) {
  writeMessage({ jsonrpc: "2.0", method, params });
}

const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// ── API client ────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

async function apiCall(method, path, body) {
  if (!TOKEN) {
    throw new ApiError(0, "CONFIG", "VOCAB_MCP_TOKEN is not set");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new ApiError(0, "TIMEOUT", `request timed out after ${TIMEOUT_MS}ms`);
    }
    throw new ApiError(0, "NETWORK", `cannot reach ${BASE_URL} (${err?.message ?? err})`);
  }
  clearTimeout(timer);

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const code = payload?.code ?? "HTTP_ERROR";
    const message = payload?.message ?? res.statusText;
    throw new ApiError(res.status, code, typeof message === "string" ? message : JSON.stringify(message));
  }
  return payload;
}

// ── Tool definitions ──────────────────────────────────────────────────────

const JSON_SCHEMA = { type: "object", properties: {}, additionalProperties: true };

function stringProp(description, required = true) {
  return { type: "string", description, ...(required ? {} : { minLength: 0 }) };
}

const FIELD_DESCRIPTION =
  "内容字段：collocation（搭配）/ example（例句）/ synonym（同义辨析）/ antonym（反义）。" +
  "example 在存储层映射为 corpus。";

const TOOLS = [
  {
    name: "search_words",
    description: "按词元（lemma）/标题前缀搜索词库中的词条，返回候选列表（slug、词元、词性、CEFR、短释义）。",
    inputSchema: {
      type: "object",
      properties: {
        q: stringProp("搜索前缀（1-100 字符）"),
        limit: { type: "number", description: "返回条数上限 1-20（默认 8）", minimum: 1, maximum: 20 },
      },
      required: ["q"],
      additionalProperties: false,
    },
    async run(args) {
      const params = new URLSearchParams({ q: String(args.q) });
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      const data = await apiCall("GET", `/api/words/suggest?${params}`);
      return data.items;
    },
  },
  {
    name: "get_word_detail",
    description: "取词条完整详情：释义、正文、原型、例句、当前已生效的 L2 扩展内容（l2_content）与是否已晋升 L2。",
    inputSchema: {
      type: "object",
      properties: { slug: stringProp("词条 slug（search_words 返回的 slug）") },
      required: ["slug"],
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/words/${encodeURIComponent(String(args.slug))}`);
    },
  },
  {
    name: "build_l2_prompt",
    description: "为某词条某字段组装规范化的外部生成提示词（不消耗 LLM 预算）。把返回的 prompt 交给任意 LLM，将其 JSON 返回作为 propose_l2_content / confirm_l2_content 的 items。",
    inputSchema: {
      type: "object",
      properties: {
        slug: stringProp("词条 slug"),
        field: { type: "string", description: FIELD_DESCRIPTION, enum: ["collocation", "example", "synonym", "antonym"] },
        count: { type: "number", description: "条目数量（可选）", minimum: 1 },
        styleProfileId: { type: "string", description: "例句/搭配的风格档案 id（可选）" },
        userInstruction: { type: "string", description: "额外的自由文本要求（可选）" },
      },
      required: ["slug", "field"],
      additionalProperties: false,
    },
    async run(args) {
      const body = { field: String(args.field) };
      if (args.count !== undefined) body.count = args.count;
      if (args.styleProfileId !== undefined) body.styleProfileId = args.styleProfileId;
      if (args.userInstruction !== undefined) body.userInstruction = args.userInstruction;
      return apiCall("POST", `/api/l2/${encodeURIComponent(String(args.slug))}/external-prompt`, body);
    },
  },
  {
    name: "propose_l2_content",
    description:
      "把生成内容写入候选池（is_active=false）：不出题、不展示，等用户在词条详情页「扩展内容」面板中勾选采纳或忽略。" +
      "这是默认推荐通道——内容先经用户确认再生效。",
    inputSchema: {
      type: "object",
      properties: {
        slug: stringProp("词条 slug"),
        field: { type: "string", description: FIELD_DESCRIPTION, enum: ["collocation", "example", "synonym", "antonym"] },
        items: { type: "array", description: "条目数组（build_l2_prompt 的 expectedJsonSchema 描述了每字段条目结构）", items: JSON_SCHEMA },
        document: { description: "可选：完整 v1 文档 { schemaVersion: 'l2-content-v1', field, items }（优先于 items）", ...JSON_SCHEMA },
        source: { type: "string", description: "来源标识（默认 external_chat）" },
        sourceRef: { type: "string", description: "来源引用，如会话 id / URL（可选）" },
      },
      required: ["slug", "field", "items"],
      additionalProperties: false,
    },
    async run(args) {
      const body = { field: String(args.field), items: args.items };
      if (args.document !== undefined) body.document = args.document;
      if (args.source !== undefined) body.source = args.source;
      if (args.sourceRef !== undefined) body.sourceRef = args.sourceRef;
      return apiCall("POST", `/api/l2/${encodeURIComponent(String(args.slug))}/candidates`, body);
    },
  },
  {
    name: "confirm_l2_content",
    description:
      "直接固定内容为已生效（跳过候选池）：立即写入缓存、触发 L2 软重卡排期。仅在用户明确要求「直接生效/固定」时使用。",
    inputSchema: {
      type: "object",
      properties: {
        slug: stringProp("词条 slug"),
        field: { type: "string", description: FIELD_DESCRIPTION, enum: ["collocation", "example", "synonym", "antonym"] },
        items: { type: "array", description: "条目数组", items: JSON_SCHEMA },
        document: { description: "可选：完整 v1 文档（优先于 items）", ...JSON_SCHEMA },
        source: { type: "string", description: "来源标识（默认 external_chat）" },
        sourceRef: { type: "string", description: "来源引用（可选）" },
      },
      required: ["slug", "field", "items"],
      additionalProperties: false,
    },
    async run(args) {
      const body = { field: String(args.field), items: args.items };
      if (args.document !== undefined) body.document = args.document;
      if (args.source !== undefined) body.source = args.source;
      if (args.sourceRef !== undefined) body.sourceRef = args.sourceRef;
      return apiCall("POST", `/api/l2/${encodeURIComponent(String(args.slug))}/confirm`, body);
    },
  },
  {
    name: "list_l2_candidates",
    description: "列出某词条候选池中的全部待选内容（供用户在 UI 中采纳/忽略之前由 Agent 复查）。",
    inputSchema: {
      type: "object",
      properties: { slug: stringProp("词条 slug") },
      required: ["slug"],
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/l2/${encodeURIComponent(String(args.slug))}/candidates`);
    },
  },
];

// ── Request handlers ──────────────────────────────────────────────────────

function normalizeL2Content(result) {
  // Keep tool results compact but lossless: the caller (LLM) reads them as text.
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleToolsCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    return replyError(id, JSON_RPC_ERRORS.INVALID_PARAMS, `unknown tool: ${params?.name}`);
  }
  try {
    const result = await tool.run(params.arguments ?? {});
    return reply(id, normalizeL2Content(result));
  } catch (err) {
    // Tool failures are results with isError=true (MCP convention), so the
    // calling agent can read the message and self-correct.
    return reply(id, {
      content: [{ type: "text", text: String(err?.message ?? err) }],
      isError: true,
    });
  }
}

function handleInitialize(id, params) {
  // Echo the client's protocolVersion when absent/unknown so permissive
  // clients (Claude Desktop, Codex, Cursor) negotiate successfully.
  const version =
    typeof params?.protocolVersion === "string" && params.protocolVersion
      ? params.protocolVersion
      : PROTOCOL_VERSION;
  return reply(id, {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  });
}

async function dispatch(id, method, params) {
  switch (method) {
    case "initialize":
      return handleInitialize(id, params);
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call":
      return handleToolsCall(id, params);
    default:
      return replyError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `method not supported: ${method}`);
  }
}

// ── stdio loop ────────────────────────────────────────────────────────────

async function main() {
  if (!TOKEN) {
    process.stderr.write("[vocab-mcp] VOCAB_MCP_TOKEN is required\n");
    process.exit(1);
  }
  process.stderr.write(`[vocab-mcp] bridging to ${BASE_URL}\n`);

  const readline = createInterface({ input: process.stdin, terminal: false });
  for await (const line of readline) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: "invalid JSON" },
      });
      continue;
    }
    // Notifications (no id) get no response per JSON-RPC 2.0.
    if (message.id === undefined || message.id === null) continue;
    try {
      await dispatch(message.id, message.method, message.params);
    } catch (err) {
      replyError(message.id, JSON_RPC_ERRORS.INTERNAL_ERROR, String(err?.message ?? err));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[vocab-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
