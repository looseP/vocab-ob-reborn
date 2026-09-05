# MCP Server（外部 Agent 接入）

`scripts/run-mcp-server.mjs` 是一个**零依赖**的 stdio MCP（Model Context Protocol）桥：
外部 Agent（Claude Desktop、Codex CLI、Cursor 等）通过 MCP 协议调用它，它把工具调用代理到
本机运行中的 Vocab Observatory HTTP API（Bearer 认证）。业务规则（RLS、内容预算、候选池语义）
全部留在服务端，MCP 进程不直接访问数据库。

## 配置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `VOCAB_MCP_BASE_URL` | API 基地址 | `http://127.0.0.1:3001` |
| `VOCAB_MCP_TOKEN` | Bearer 令牌（**必填**），取 `OWNER_API_TOKEN` 或 `AGENT_API_TOKENS` 中的一项 | 无 |
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
- 所有写操作在服务端以令牌对应的用户身份（`request.jwt.claim.sub`）执行，RLS 隔离不变。
- 工具执行失败以 `isError: true` 的结果返回（MCP 约定），调用方 Agent 可读取消息自行纠正。
