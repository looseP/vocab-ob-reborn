# ADR-0029: MCP / agent 接入边界（传输层不新增信任级 + 资源级 role 强制）

- **Status**: Accepted（局部修订 2026-09-17：评析区 = agent 首个可写持久区，见文末 Amendment）
- **Date**: 2026-09-12
- **Amends**: ADR-0008 §Non-goals（**仅声明修订，不修改原文**——ADR 不可变）
- **Amended by**: ADR-0034 v2 条 10/11（评析区开口，2026-09-17 增补批 T13）
- **References**: ADR-0004 §6.3（agent 不得直接写权威数据）、ADR-0008（proposal 边界）、ADR-0022（单 owner）、ADR-0024（公网信任边界）、CONTEXT.md（Agent / Proposal-only write / Agent token·agentId / Trusted transport）
- **上游**: 2026-09-12 API 与 MCP 设计拷问会话（第一轮 Q1–Q7）

## Context

实测（2026-09-12，逐条回码核验）：

- `scripts/run-mcp-server.mjs` **已存在**（零依赖 stdio MCP 桥，协议 `2025-06-18`，`tools/list` + `tools/call`，`isError` 约定），但**6 个工具全是 L2，没有任何 L3 工具**（`:136-256`）。
- `/api/*` 整体挂在 owner 门禁上（`src/http/server.ts:101` + `roleRank`：`agent=1 < owner=2`，`src/http/middleware/auth.ts:19-23,87-89`）⇒ **agent token 对全部端点 403（含读）**；MCP 实际只能用 owner token。
- 服务端**没有任何按 role 的业务分支**（grep `role === "agent"` 零命中）⇒ ADR-0004 §6.3 的红线只靠"agent 够不着"间接成立，**不是资源级规则**。
- 于是 `confirm_l2_content`（→ `POST /api/l2/:slug/confirm`，直接写 `is_active=true`，`src/services/l2-content.service.ts:1015-1048`）在 owner token 下**可直达**：红线的 L2 侧存在真实空档。
- owner token 与 agent token 解析出**同一个 actorId**（`auth.ts:33-42`），`Principal` 无 token 级身份 ⇒ 数据层无法区分 agent 与 owner 的写入；`source_type` / `provenance` 都是调用方自述。
- `l3_proposals.source_type` 枚举已含 `agent`，并预留了从未被写入的 `mcp_future`（`src/db/schema.ts:1076`）。
- `POST /api/l3/proposals` **存了 `input_hash` 却不查重**（`src/services/l3-proposal.service.ts:195-211`；`findProposalByInputHash` 只被 import 路径使用）；而 `l3_import_jobs` 侧已有完整幂等范式（唯一索引 `schema.ts:1046` + 竞态回读 `l3-import.service.ts:235`）。
- graph 的 `depth` 是**显式 fail-closed**（`src/schemas/http/index.ts:355-357` 的 `.max(1)` + 注释「拒绝 depth=2，而不是静默返回与 depth=1 相同的结果」），**不是漏做**。
- `POST /api/l2/:slug/confirm` **仍由人在使用**（`src/frontend/components/words/WordL2Composer.tsx:301-309`，`source:"manual"`）⇒ 端点是人的通道，保留。

## Decision

1. **agent 定位 = 读全量 + 写只走 proposal**；**owner token 只给人**（浏览器/命令行），agent 与 MCP **一律使用 agent token**。
2. **Proposal-only write 必须落到资源级代码强制**（路由层最小角色守卫），**不能只靠 token 分发纪律**——现状空档的成因恰恰是"靠自觉"。
3. **MCP = 传输层，不新增信任级**（Trusted transport）：经 MCP 的写入仍进 proposal；`confirm` / `accept` / `validate` 这类**升级动作不进 MCP 工具面**；MCP 侧下线 `confirm_l2_content`，任何 active L3 直写一律不可暴露。
4. **修订 ADR-0008 §Non-goals**：其原文"does not implement MCP server"已被现实取代，本 ADR 声明该非目标作废。`mcp_future` 枚举值**仅作文档级弃用**（🔴 不为删一个无人用过的枚举值单开迁移；下次触及 `l3_proposals` 时顺手收敛）。
5. **agentId 是服务端认定的信任锚**：`AGENT_API_TOKENS` 升级为 `id:token,...` 映射（按**第一个** `:` 分割；token 本身为 hex/base64url、不含冒号），middleware 解析出 `agentId` 放入 `Principal`，写入落 `proposal.provenance.agentId`（jsonb 已存在，**0 迁移**）。agentId **不是自述标签**——它由服务端持有的 token↔id 映射认定，信任强度**高于** client 提交的任何 `provenance` 字段。撤销语义 = 改 env 重启（与 ADR-0024 的设备会话对称，单机可接受）。
6. **读面放开与缺口补齐**：`GET` → agent 可用；`POST` proposal → agent 可用；**其余写 → owner only**。补缺按 ②>①>③：
   - **②** L3 主要读端点补 `space`/`direction` 过滤（复用现成 `directionSchema` / `L3_SUB_SPACES`）——agent 的工作方式就是"按空间/方向取料"；
   - **①** `occurrences` / `context-links` 补 **list**（现在只有写/删；分页沿用 `l3LimitCursorQuerySchema`）；
   - **③** error code 集中为 `src/errors/` 的**单一导出**（代码，可被 `api:governance` 钉住；**不写成文档**——文档会腐化）。
7. **proposal 幂等两步走**：① 本轮在 `createProposal` 入口先调 `findProposalByInputHash`，命中即返回既有 bundle（复刻 import 范式）；② 下一步在 `l3_proposals` 补 partial unique index `(user_id, input_hash) WHERE input_hash IS NOT NULL`（与 `l3_import_jobs` 对齐；现 `input_hash` nullable 且**无**唯一索引）。**不给** occurrences/links/confirm/validate/reject/sessions 盲加幂等键——幂等键是接口契约，状态机动作靠状态守卫，**加错地方比不加更糟**。
8. **能力发现两件半**：① MCP `tools/list` 每个工具 description 标注"产物进 proposal、需人工确认"；② 新增 `GET /api/l3/capabilities` + MCP `get_capabilities`，数字**从 `src/schemas/resource-budget.ts` 常量导出**（禁止复制成第二套真源）；③ error code 枚举（同 6③）。**不做** MCP resources/prompts 全套。

## Tradeoffs

- **放开 agent 读 vs 攻击面**：agent token 从"全 403"变为"可读全量语料"。本机 `127.0.0.1` 绑定下风险低；**一旦走 ADR-0024 的公网暴露，token 泄漏 = 全量语料可读**——这是本决策明示接受的代价。
- **门禁分级 vs 一次性粗门禁**：粗门禁简单，但让 agent 完全不可用、并把红线降级为"够不着"；分级要动**全部路由模块**（工作量与回归风险的真实来源），但它是"可用"与"被强制"的唯一交点。
- **MCP 不暴露 confirm vs 行为变更**：端点保留（人用），MCP 侧下线后，习惯用 MCP"直接固定"的工作流只能改走 HTTP + owner token。
- **DB 幂等索引延后 vs 立刻**：延后让**并发**重试仍可能双写重复 pending（人审可见、可拒绝，**不污染权威数据**）；立刻则要动已应用迁移的表。

## Consequences

- ✅ 红线从"约定"升级为**可测的资源级规则**；agent 从"完全不可用"变为"可读 + 可提案"。
- ✅ 写入来源可追溯（agentId 由服务端认定），为按客户端撤销/限流留出锚点。
- ⚠️ **公网暴露下代价必须进 ADR-0024 的语境**：agent token 泄漏 = 全量语料可读 ⇒ CF Access + 源站锁定不只是防外部，也是这个信任模型的**必要前提**。
- ⚠️ **最大工作量在门禁改造**：`/api/*` 粗门禁 → 按端点最小角色，涉及全部路由模块与全量测试。**本 ADR 不锁定子任务编号**（子任务拆分见计划文档；编号纪律同 H 系列：ADR 只引用 ADR 号，不引用卡片号）。
- ⚠️ `confirm_l2_content` 从 MCP 下线是**行为变更**（端点本身保留，人仍可从 `WordL2Composer` 使用）。
- ⚠️ **待跟踪**：第 7 条第二步（`l3_proposals` 的 partial unique index）必须在"下次触及该表"时落地，不得静默蒸发。
- ⚠️ `docs/operations/secret-rotation.md` 需同步 token 语义（owner vs agent、`id:token` 映射、撤销 = 改 env 重启）。
- ⚠️ graph `depth>1` 仍为显式拒绝（本决策不变）；若要开放，需先解决 repo 层一跳限制。

## Amendment（2026-09-17，增补批 T13——随 ADR-0034 v2 条 10/11）

**范围**：本 ADR 决策 1「agent 定位 = 读全量 + 写只走 proposal」与决策 6「其余写 → owner only」被**局部修订**——评析区 `l3_question_assessments` 成为 **agent 首个可写持久区**。

- **开口范围严格限于评析区**：`GET/PUT /api/l3/questions/:id/assessment`（minRole=agent；agent 与 owner 同一端点双身份写入，`last_editor` 按服务端认定的 role 留痕）——此外任何持久区不开口。
- **红线不变**：注记内容（note / 锚点 / 用户原判标签）agent 永不写（只写 review 段，ADR-0034 §4）；attempts 双方不可写（不可变事实）；proposal 路径与其余 owner-only 写面照旧。
- **开口依据**：评析区是「agent 解读后的结晶沉淀地」（设计卡 v2 §11）——工作流 = 导出题纸 → 外部 agent 解读痕迹 → 直写评析（或用户粘贴，同一端点）。latest-wins 无历史版本（last_editor + updated_at 留痕兜底），覆写可被 owner 随时修正，风险面受控（单 owner 本机语义）。
- **信任锚不变**：agentId 仍由 `AGENT_API_TOKENS` 映射认定（决策 5）；CSRF 检查仅对 session 路径生效（agent bearer 不受影响，middleware 现状）。
