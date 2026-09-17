#!/usr/bin/env node
/**
 * Vocab Observatory MCP server — zero-dependency stdio bridge.
 *
 * Speaks the Model Context Protocol (JSON-RPC 2.0, newline-delimited) on
 * stdin/stdout and proxies every tool call to the running Vocab Observatory
 * HTTP API with Bearer auth. All business rules (RLS actor, content budgets,
 * candidate pool semantics) stay server-side; this process holds no DB access.
 *
 * Tools (T13c):
 *   search_words          find words by lemma/slug prefix (suggest endpoint)
 *   get_word_detail       full word detail incl. current L2 content
 *   build_l2_prompt       assemble the canonical external-generation prompt
 *   propose_l2_content    write an is_active=false candidate → user reviews it
 *                         in the word detail composer panel (采纳/忽略)
 *   list_l2_candidates    list pending candidates for a word
 *   list_l3_sources       browse L3 sources by sub-space / direction (书架列料)
 *   list_l3_word_contexts list a word's L3 contexts by sub-space / direction
 *   list_l3_occurrences   list L3 occurrence evidence by word/context/space
 *   list_l3_context_links list L3 context links by type/word/context/space
 *   list_l3_proposals     list L3 proposals by status (default: pending)
 *   get_l3_proposal       read one proposal's status and items
 *   submit_l3_proposal    write a PENDING L3 proposal (agent path, 需人工确认)
 *   get_capabilities      read the capability envelope (budgets / error codes)
 *
 * Trust boundary (ADR-0029 §3): MCP is a transport, not a trust level — every
 * write goes to the candidate / proposal pool and requires human confirmation,
 * and upgrade actions (confirm / accept / validate / apply / cancel) are NOT
 * exposed here. `confirm_l2_content` was removed with T13c (the HTTP endpoint
 * itself stays for humans in WordL2Composer).
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

/**
 * v1 条目的 provenance 必填；外部 Agent 通常不带。注入默认溯源，让调用方
 * 无需感知 provenance 契约（collocation 的词典锚定 superRefine 规则仍然
 * 生效——400 会返回首个 issue 提示补 evidence）。
 */
function withDefaultProvenance(items) {
  return Array.isArray(items)
    ? items.map((item) =>
        item && typeof item === "object" && !Array.isArray(item) && item.provenance === undefined
          ? { ...item, provenance: { source: "external_chat" } }
          : item,
      )
    : items;
}

function stringProp(description, required = true) {
  return { type: "string", description, ...(required ? {} : { minLength: 0 }) };
}

const FIELD_DESCRIPTION =
  "内容字段：collocation（搭配）/ example（例句）/ synonym（同义辨析）/ antonym（反义）。" +
  "example 在存储层映射为 corpus。";

// ── L3 tooling helpers (T13c) ─────────────────────────────────────────────

// 统一尾注（ADR-0029 §8①）：每个工具的 description 都必须标注"产物进
// proposal、需人工确认"，并声明升级动作不进 MCP 工具面。
const READ_ONLY_NOTE =
  "只读；本桥一切写入产物进 proposal、需人工确认，升级动作（confirm / accept / validate / apply / cancel）不暴露。";

// 词表与 src/services/l3-practice.service.ts 的 L3_SUB_SPACES / 服务端 schema
// 的枚举同值；此处仅作 inputSchema 提示，服务端校验仍是唯一真源。
const L3_DIRECTIONS = ["通用", "考研", "雅思"];
const L3_SPACES = ["语法", "阅读", "作文", "翻译", "通用"];
const L3_SOURCE_TYPES = ["article", "book", "video", "audio", "chat", "manual", "web", "other"];
const L3_LINK_TYPES = ["supports", "illustrates", "contrasts", "collocates_with", "synonym_of", "antonym_of", "derived_from", "topic_related", "manual_link"];
const L3_LINK_TARGET_TYPES = ["word", "l2_item", "context", "source", "topic", "external"];

function toQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

const TOOLS = [
  {
    name: "search_words",
    description: "按词元（lemma）/标题前缀搜索词库中的词条，返回候选列表（slug、词元、词性、CEFR、短释义）。只读；本桥一切写入产物进 proposal、需人工确认，升级动作（confirm / accept / validate / apply / cancel）不暴露。",
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
    description: "取词条完整详情：释义、正文、原型、例句、当前已生效的 L2 扩展内容（l2_content）与是否已晋升 L2。只读；本桥一切写入产物进 proposal、需人工确认，升级动作不暴露。",
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
    description: "为某词条某字段组装规范化的外部生成提示词（不消耗 LLM 预算）。把返回的 prompt 交给任意 LLM，将其 JSON 返回作为 propose_l2_content 的 items。只读组装；本桥一切写入产物进 proposal、需人工确认，升级动作不暴露。",
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
      "产物进 proposal、需人工确认——这是默认推荐通道，内容先经用户确认再生效；升级动作不在本桥暴露。",
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
      const body = { field: String(args.field), items: withDefaultProvenance(args.items) };
      if (args.document !== undefined) body.document = args.document;
      if (args.source !== undefined) body.source = args.source;
      if (args.sourceRef !== undefined) body.sourceRef = args.sourceRef;
      return apiCall("POST", `/api/l2/${encodeURIComponent(String(args.slug))}/candidates`, body);
    },
  },
  {
    name: "list_l2_candidates",
    description: "列出某词条候选池中的全部待选内容（供用户在 UI 中采纳/忽略之前由 Agent 复查）。" + READ_ONLY_NOTE,
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
  {
    name: "list_l3_sources",
    description:
      "按子空间（语法/阅读/作文/翻译/通用）与方向（通用/考研/雅思）浏览 L3 素材来源书架（书架列料）：" +
      "按类型过滤、标题/内容搜索、按最近（recent）或圈记次数（captures）排序。" + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        sourceType: { type: "string", description: "来源类型（可选）", enum: L3_SOURCE_TYPES },
        q: { type: "string", description: "标题/内容搜索词（可选）" },
        sort: { type: "string", description: "排序（默认 recent）", enum: ["recent", "captures"] },
        direction: { type: "string", description: "考试方向（可选）", enum: L3_DIRECTIONS },
        space: { type: "string", description: "子空间（可选）", enum: L3_SPACES },
        limit: { type: "number", description: "返回条数上限 1-50（默认 20）", minimum: 1, maximum: 50 },
        offset: { type: "number", description: "偏移分页（默认 0）", minimum: 0 },
      },
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/l3/sources${toQuery(args)}`);
    },
  },
  {
    name: "list_l3_word_contexts",
    description:
      "列出某词条在 L3 素材空间中的语境条目（词语境列表），可按子空间/方向过滤，cursor 分页。" + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        slug: stringProp("词条 slug"),
        direction: { type: "string", description: "考试方向（可选）", enum: L3_DIRECTIONS },
        space: { type: "string", description: "子空间（可选）", enum: L3_SPACES },
        limit: { type: "number", description: "返回条数上限 1-100（默认 50）", minimum: 1, maximum: 100 },
        cursor: { type: "string", description: "分页游标（上一页返回的 nextCursor）" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    async run(args) {
      const { slug, ...rest } = args;
      return apiCall("GET", `/api/l3/words/${encodeURIComponent(String(slug))}/contexts${toQuery(rest)}`);
    },
  },
  {
    name: "list_l3_occurrences",
    description:
      "列出 L3 词形出现记录（occurrences，圈词划词的证据行）：可按词（slug / wordId）、语境（contextId）" +
      "与子空间/方向过滤，cursor 分页。" + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "词条 slug（可选）" },
        wordId: { type: "string", description: "词条 uuid（可选）" },
        contextId: { type: "string", description: "语境 uuid（可选）" },
        direction: { type: "string", description: "考试方向（可选）", enum: L3_DIRECTIONS },
        space: { type: "string", description: "子空间（可选）", enum: L3_SPACES },
        limit: { type: "number", description: "返回条数上限 1-100（默认 50）", minimum: 1, maximum: 100 },
        cursor: { type: "string", description: "分页游标（可选）" },
      },
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/l3/occurrences${toQuery(args)}`);
    },
  },
  {
    name: "list_l3_context_links",
    description:
      "列出 L3 语境关联（context-links）：可按关联类型（supports / illustrates / contrasts / collocates_with / …）、" +
      "目标类型、词（slug / wordId）、语境与子空间/方向过滤，cursor 分页。" + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "词条 slug（可选）" },
        wordId: { type: "string", description: "词条 uuid（可选）" },
        contextId: { type: "string", description: "语境 uuid（可选）" },
        linkType: { type: "string", description: "关联类型（可选）", enum: L3_LINK_TYPES },
        targetType: { type: "string", description: "目标类型（可选）", enum: L3_LINK_TARGET_TYPES },
        direction: { type: "string", description: "考试方向（可选）", enum: L3_DIRECTIONS },
        space: { type: "string", description: "子空间（可选）", enum: L3_SPACES },
        limit: { type: "number", description: "返回条数上限 1-100（默认 50）", minimum: 1, maximum: 100 },
        cursor: { type: "string", description: "分页游标（可选）" },
      },
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/l3/context-links${toQuery(args)}`);
    },
  },
  {
    name: "list_l3_proposals",
    description:
      "列出 L3 提案（agent 提交后自查）：按 status（pending / confirmed / rejected / canceled，默认 pending）、" +
      "limit 上限（1-100）与 cursor 分页过滤。" + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "提案状态（默认 pending）", enum: ["pending", "confirmed", "rejected", "canceled"] },
        limit: { type: "number", description: "返回条数上限 1-100（默认 50）", minimum: 1, maximum: 100 },
        cursor: { type: "string", description: "分页游标（上一页返回的 nextCursor）" },
      },
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/l3/proposals${toQuery(args)}`);
    },
  },
  {
    name: "get_l3_proposal",
    description:
      "按 proposalId 读取单个 L3 提案（bundle：proposal + items）：响应体现 status 与 items 概览，" +
      "供 agent 提交后自查审阅进度。" + READ_ONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        proposalId: stringProp("提案 id（submit_l3_proposal 返回的 proposal.id，或 list_l3_proposals 的行 id）"),
      },
      required: ["proposalId"],
      additionalProperties: false,
    },
    async run(args) {
      return apiCall("GET", `/api/l3/proposals/${encodeURIComponent(String(args.proposalId))}`);
    },
  },
  {
    name: "submit_l3_proposal",
    description:
      "把 agent 生成的 L3 素材条目（source / context / occurrence / context_link）提交为 pending 提案：" +
      "产物进 proposal、需人工确认——owner 在提案审阅界面 validate/confirm 后才进入权威数据；" +
      "写入一律 pending（source_type=agent），相同 inputHash 重复提交幂等返回既有提案；升级动作不在本桥暴露。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "提案标题（可选）" },
        summary: { type: "string", description: "提案摘要（可选）" },
        wordbookId: { type: "string", description: "词书 uuid（可选）" },
        inputHash: { type: "string", description: "幂等键（可选）：相同 hash 重复提交返回既有提案" },
        provenance: { description: "溯源补充（可选；agentId 由服务端认定并覆盖自述值）", ...JSON_SCHEMA },
        items: {
          type: "array",
          description:
            "提案条目（至少 1 条）。itemType：source / context / occurrence / context_link；payload 用 camelCase 的 " +
            "service 形状：context 用 sourceId 或引用先序条目的 sourceRef；occurrence 用 contextId 或 contextRef；" +
            "context_link 用 contextId/contextRef（可带 wordId）。",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              itemType: { type: "string", enum: ["source", "context", "occurrence", "context_link"] },
              clientRef: { type: "string", description: "本提案内的局部引用名（可选）" },
              payload: JSON_SCHEMA,
            },
            required: ["itemType", "payload"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    async run(args) {
      const body = {
        sourceType: "agent",
        items: args.items.map((item) => ({
          itemType: item.itemType,
          ...(item.clientRef !== undefined ? { clientRef: item.clientRef } : {}),
          payload: item.payload,
        })),
      };
      if (args.title !== undefined) body.title = args.title;
      if (args.summary !== undefined) body.summary = args.summary;
      if (args.wordbookId !== undefined) body.wordbookId = args.wordbookId;
      if (args.inputHash !== undefined) body.inputHash = args.inputHash;
      if (args.provenance !== undefined) body.provenance = args.provenance;
      return apiCall("POST", "/api/l3/proposals", body);
    },
  },
  {
    name: "get_capabilities",
    description:
      "读取服务器能力清单（能力发现）：含调用者 role 与 access 事实——可读面 / 可写面（仅 proposal）、" +
      "升级动作不可用、预算上限（提案条目数与字节数、JSON 深度）与 error code 词表。" + READ_ONLY_NOTE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return apiCall("GET", "/api/l3/capabilities");
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
