# MCP Server（外部 Agent 接入）

`scripts/run-mcp-server.mjs` 是一个**零依赖**的 stdio MCP（Model Context Protocol）桥：
外部 Agent（Claude Desktop、Codex CLI、Cursor 等）通过 MCP 协议调用它，它把工具调用代理到
本机运行中的 Vocab Observatory HTTP API（Bearer 认证）。业务规则（RLS、内容预算、候选池语义）
全部留在服务端，MCP 进程不直接访问数据库。

## 配置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `VOCAB_MCP_BASE_URL` | API 基地址 | `http://127.0.0.1:3001` |
| `VOCAB_MCP_TOKEN` | Bearer 令牌（**必填**），取 `OWNER_API_TOKEN` 或 `AGENT_API_TOKENS` 中某个 token（agent token 现可读全量 + 写 proposal，升级动作 403；见文末「现状限制」） | 无 |
| `VOCAB_MCP_TIMEOUT_MS` | 单请求超时 | `60000` |

本地开发默认 Owner Token 见 `compose.yaml`（`local-owner-api-token-only-0001`），仅限本地使用。

## 在客户端中注册

以 Claude Desktop / 通用 `mcpServers` 配置为例：

```json
{
  "mcpServers": {
    "vocab-observatory": {
      "command": "node",
      "args": ["D:/path/to/wt-main/scripts/run-mcp-server.mjs"],
      "env": {
        "VOCAB_MCP_BASE_URL": "http://127.0.0.1:3001",
        "VOCAB_MCP_TOKEN": "<OWNER_API_TOKEN 或 AGENT_API_TOKENS 之一>"
      }
    }
  }
}
```

也可用 `npm run mcp:server`（从仓库根目录继承环境变量）。

## 工具一览（6 个）

| 工具 | 作用 | 对应 API |
| --- | --- | --- |
| `search_words` | 按词元/标题前缀搜索词条 | `GET /api/words/suggest` |
| `get_word_detail` | 词条完整详情（含已生效 L2 内容） | `GET /api/words/:slug` |
| `build_l2_prompt` | 组装规范化外部生成提示词（不耗 LLM 预算） | `POST /api/l2/:slug/external-prompt` |
| `propose_l2_content` | **送候选**：写入候选池（`is_active=false`），不出题、不展示，等用户采纳 | `POST /api/l2/:slug/candidates` |
| `confirm_l2_content` | **直接固定**：跳过候选池立即生效（写缓存 + L2 软重卡） | `POST /api/l2/:slug/confirm` |
| `list_l2_candidates` | 列出词条的全部待选候选 | `GET /api/l2/:slug/candidates` |

`field` 取值：`collocation`（搭配）/ `example`（例句）/ `synonym`（同义辨析）/ `antonym`（反义）；
`example` 在存储层映射为 `corpus`。

## 推荐对话流

1. `search_words` 找词 → `get_word_detail` 看现有内容与缺口。
2. `build_l2_prompt` 拿规范化提示词，交给对话中的 LLM 生成 JSON 条目。
3. 默认走 `propose_l2_content` 送候选——用户在词条详情页「扩展内容」面板的
   **Agent 候选区**勾选条目后点「采纳」（可只采纳子集）或「忽略」。
   采纳 = 激活内容 + 刷新缓存 + L2 软重卡排期。
4. 仅当用户明确说「直接生效/固定」时才用 `confirm_l2_content`。

## 语义约束

- 候选（`is_active=false`）不进 words JSONB 缓存、不参与出题与展示；只有采纳后才激活。
- 拒绝候选为硬删，Agent 可重新 propose。
- 所有写操作在服务端以单一 owner 身份（`LOCAL_OWNER_ID`）执行，RLS 隔离不变。**当前不存在 JWT**：owner token 与 agent token 解析出的是**同一个 actorId**；agent bearer 额外在 `Principal.agentId` 上带出服务端认定的 agentId，但 T13a 尚未落库（见文末「现状限制」4）。
- 工具执行失败以 `isError: true` 的结果返回（MCP 约定），调用方 Agent 可读取消息自行纠正。

## 现状限制（2026-09-12 T13a 后）

1. **agent token 可用（读 + 写 proposal）**：`/api/*` 已从"整体 owner 门禁"升级为**按端点最小角色**（注册表 `src/http/operations.ts` 的 `minRole` + 查找表 `src/http/middleware/api-authorization.ts`）。
   - agent token（`AGENT_API_TOKENS` 的 `agentId:token`，见 `docs/operations/secret-rotation.md`）可：读全量语料（GET；例外见下）；写 proposal（`POST /api/l3/proposals`、`POST /api/l2/:slug/candidates`）。
   - **升级动作对 agent 一律 403**：L2 confirm、L2 candidates accept/reject、L3 proposal validate/confirm/reject、L3 recommendation accept/reject、forgetting apply/restore、l3-sessions end、upgrade-work-orders 全部写、l2-rows deactivate/delete/hide/restore 等；owner token 仍全量放行。
   - `GET /api/operations/metrics` 等少数读保持 owner-only；`/api/auth` 是唯一豁免组（会话兑换/登出）。
2. **MCP 工具边界尚未收敛（属 T13c）**：本桥 6 个工具仍共用 `VOCAB_MCP_TOKEN`（可为 owner 或 agent）。用 owner token 时 `confirm_l2_content` 仍可直达；用 agent token 时它会被服务端 403 拦下。ADR-0029 要求 MCP 工具面**下线** `confirm_l2_content` 并补 L3 工具——该工作属 T13c，本文档未改工具面。
3. **MCP 工具集目前只有 L2 的 6 个**，没有任何 L3 工具（`scripts/run-mcp-server.mjs:136-256`；属 T13c）。
4. **agentId 只到 Principal，未落库**：T13a 只做到中间件按 `id:token` 映射解析并注入 `Principal.agentId`；把 agentId 落 `proposal.provenance.agentId` 属 T13c（0 迁移）。因此数据层仍无法区分某次写入来自 agent 还是 owner，`source_type` / `provenance` 仍是调用方自述。
