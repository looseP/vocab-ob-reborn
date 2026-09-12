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

## 工具一览（11 个）

| 工具 | 作用 | 对应 API |
| --- | --- | --- |
| `search_words` | 按词元/标题前缀搜索词条 | `GET /api/words/suggest` |
| `get_word_detail` | 词条完整详情（含已生效 L2 内容） | `GET /api/words/:slug` |
| `build_l2_prompt` | 组装规范化外部生成提示词（不耗 LLM 预算） | `POST /api/l2/:slug/external-prompt` |
| `propose_l2_content` | **送候选**：写入候选池（`is_active=false`），不出题、不展示，等用户采纳 | `POST /api/l2/:slug/candidates` |
| `list_l2_candidates` | 列出词条的全部待选候选 | `GET /api/l2/:slug/candidates` |
| `list_l3_sources` | 按子空间/方向浏览 L3 来源书架（列料） | `GET /api/l3/sources` |
| `list_l3_word_contexts` | 某词条的 L3 语境列表（可按子空间/方向过滤） | `GET /api/l3/words/:slug/contexts` |
| `list_l3_occurrences` | L3 词形出现记录（圈词划词的证据行） | `GET /api/l3/occurrences` |
| `list_l3_context_links` | L3 语境关联列表 | `GET /api/l3/context-links` |
| `submit_l3_proposal` | **送提案**：提交 pending 提案（`source_type=agent`），等 owner 审阅 | `POST /api/l3/proposals` |
| `get_capabilities` | 能力发现：可读/可写面、预算上限、error code 词表 | `GET /api/l3/capabilities` |

**信任边界（ADR-0029 §3）**：MCP 是传输层、不新增信任级——所有写入都进 candidate/proposal 池、
需人工确认；升级动作（accept / validate / apply / cancel 等）**不在本桥暴露**。
`confirm_l2_content` 工具已于 T13c 下线（`POST /api/l2/:slug/confirm` 端点保留给人用，
`WordL2Composer` 不受影响）。每个工具的 description 都标注"产物进 proposal、需人工确认"。

`field` 取值：`collocation`（搭配）/ `example`（例句）/ `synonym`（同义辨析）/ `antonym`（反义）；
`example` 在存储层映射为 `corpus`。

## 推荐对话流

1. `search_words` 找词 → `get_word_detail` 看现有内容与缺口。
2. `build_l2_prompt` 拿规范化提示词，交给对话中的 LLM 生成 JSON 条目。
3. 走 `propose_l2_content` 送候选——用户在词条详情页「扩展内容」面板的
   **Agent 候选区**勾选条目后点「采纳」（可只采纳子集）或「忽略」。
   采纳 = 激活内容 + 刷新缓存 + L2 软重卡排期。
4. L3 侧：`list_l3_sources` / `list_l3_word_contexts` 按子空间/方向取料 →
   生成关联建议（occurrence / context_link 等）→ `submit_l3_proposal` 送 pending 提案，
   owner 在提案界面 validate/confirm。
5. 需要「直接生效/固定」类升级动作时，MCP 不提供——用 owner token 走 HTTP
   （如 `POST /api/l2/:slug/confirm`），或请在浏览器界面操作。

## 语义约束

- 候选（`is_active=false`）不进 words JSONB 缓存、不参与出题与展示；只有采纳后才激活。
- 拒绝候选为硬删，Agent 可重新 propose。
- 所有写操作在服务端以单一 owner 身份（`LOCAL_OWNER_ID`）执行，RLS 隔离不变。**当前不存在 JWT**：owner token 与 agent token 解析出的是**同一个 actorId**；agent bearer 额外带出服务端认定的 agentId，并落 `proposal.provenance.agentId`（见文末「现状限制」3）。
- 工具执行失败以 `isError: true` 的结果返回（MCP 约定），调用方 Agent 可读取消息自行纠正。

## 现状限制（2026-09-12 T13c 后）

1. **agent token 可用（读 + 写 proposal + 构建提示词 + 发起导入）**：`/api/*` 已从"整体 owner 门禁"升级为**按端点最小角色**（注册表 `src/http/operations.ts` 的 `minRole` + 查找表 `src/http/middleware/api-authorization.ts`）。
   - agent token（`AGENT_API_TOKENS` 的 `agentId:token`，见 `docs/operations/secret-rotation.md`）可：读全量语料（GET；例外见下）；写 proposal（`POST /api/l3/proposals`、`POST /api/l2/:slug/candidates`）；构建提案载荷（`POST /api/l2/:slug/external-prompt`，即 `build_l2_prompt`，纯组装、不写库、不耗预算）；发起 L3 导入（`POST /api/l3/imports/raw-text|structured`，产出 proposal bundle，不写 active L3、不耗预算）。推荐流 `search_words → get_word_detail → build_l2_prompt → propose_l2_content` 在 agent token 下全程可用。
   - **升级动作对 agent 一律 403**：L2 confirm、L2 candidates accept/reject、L3 proposal validate/confirm/reject、L3 recommendation accept/reject、forgetting apply/restore、l3-sessions end、upgrade-work-orders 全部写、l2-rows deactivate/delete/hide/restore 等；owner token 仍全量放行。这些动作**也不在任何 MCP 工具里暴露**。
   - `GET /api/operations/metrics` 等少数读保持 owner-only；`/api/auth` 是唯一豁免组（会话兑换/登出）。
2. **MCP 工具面已收敛（T13c）**：共 11 个工具——5 个 L2 + 5 个 L3（读 + 送提案）+ 1 个能力发现；`confirm_l2_content` 已下线；升级动作（confirm / accept / validate / apply / cancel）不暴露；每个工具 description 标注"产物进 proposal、需人工确认"。行为由 `tests/scripts/run-mcp-server.test.ts` 冒烟钉住（真实子进程 + 真实 app）。
3. **agentId 已落库**：agent bearer 的 `proposal.provenance.agentId` 由服务端按 `AGENT_API_TOKENS` 映射认定、覆盖客户端自述（ADR-0029 §5）；提案幂等由 `inputHash` 查重 + 迁移 0031 的 partial unique index 保障。
4. **能力发现**：`GET /api/l3/capabilities`（MCP `get_capabilities`）返回可读/可写面、预算上限与 error code 词表；数字引用 `src/schemas/resource-budget.ts`、词表引用 `src/errors/codes.ts` 单一真源。
5. **已知缺口**：MCP 未暴露提案状态查询（`GET /api/l3/proposals` 不在工具面）——agent 提交后需由 owner 在服务端/界面侧查看提案状态。
