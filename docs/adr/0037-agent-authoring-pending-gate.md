# ADR-0037: agent 录题通道（pending 闸门 + owner 批量采纳；`trusted_agent` 不启用）

- **Status**: Accepted
- **Date**: 2026-09-26
- **Amends**: ADR-0030 §5（**仅声明修订，不修改原文**——ADR 不可变）：§5 声明的 `trusted_agent` 白名单直写面（录题 + 评卷）**判为不启用**，理由见决策 1；§5「评卷需 trusted 开口」被本 ADR 决策 7 显式作废
- **Amends**: ADR-0035 决策 3（**记录并处置**其与 ADR-0030 §5 的口径冲突，普通 agent 写评卷的现状**保持不变**，见决策 7）
- **Narrows**: ADR-0029 决策 1/6 —— 录题面从「其余写 owner only」放宽为「agent 可写 `pending`」，但**不引入新信任级、不新增 role、不实现三段 token**；proposal-only 与 owner-only 两端一字不动
- **References**: ADR-0004 §6（agent 不得直写权威数据）、ADR-0022（单 owner）、ADR-0024（公网暴露信任边界）、ADR-0029（agentId 信任锚 + 资源级 role 强制 + 能力发现）、ADR-0030 §5（被本 ADR 判不启用的原文）、ADR-0033/0034（注记与 stage）、ADR-0035 决策 3/8（评卷 agent 写面与「服务端认定 graded_by」同一信任模型）、CONTEXT.md（Agent / Proposal-only write / Agent token·agentId）
- **上游**: `docs/plan/practice-loop-p3-2026-09-26.md` §5 待裁决点 1

## Context

逐条回码核验（2026-09-26）：

1. **§5 的三段 token 从未实现**。ADR-0030 §5 自述「本 ADR Accepted 时三级 token 解析与 MCP 工具尚未实现」（`docs/adr/0030-l3-question-paper-venue.md:65`），ADR-0035 §Context 复述同一句。`AGENT_API_TOKENS` 仍按两段 `agentId:token` 解析，无 role 后缀 —— 故「三段 token 格式」**不是待裁决项，是一段从未落地的声明**。
2. **录题面当前全 owner-only**：`createL3Paper` / `updateL3Paper` / `createL3Question` / `updateL3Question` / `deleteL3Question` 五面 minRole=owner（`src/http/operations.ts:526,530,533,534,535`）。
3. **但 pending 闸门的管道已经铺好**：`l3_questions.status` CHECK 就是 `pending|active|rejected`（`drizzle-release/0032_great_blockbuster.sql:65`），schema 注释自述「pending（agent 提案，后续波次启用）/ active（owner/trusted 直写）/ rejected」（`src/db/schema.ts:1276`），`created_by` 注释「服务端认定的写入者：'owner' 或 agentId（ADR-0029 信任锚，非调用方自报）」（`:1278`）；仓储 INSERT 已写 `COALESCE($12,'active')` / `COALESCE($13,'owner')`（`src/repositories/l3-paper.repository.ts:93-98`），`NewL3Question` 已声明 `status?` / `created_by?`（`src/repositories/interfaces.ts:1495`）。**唯一缺口在 service**：它不传这两项，落库恒为 `active` + `'owner'`（`src/services/l3-paper.service.ts:156-167`）。
4. **没有晋级路径**：全库无 pending→active 的端点或服务方法。好处是题读面本就按 `status='active'` 过滤（`src/repositories/l3-paper.repository.ts` 内 7 处），故 **pending 题天然不可见、采纳后自然出现，读面零改动**。
5. **决定性论据（由本轮 P3-1 刚写出的代码提供）**：`updateQuestion` 在 `countQuestionAttempts > 0` 时抛 409，文案明说「答案历史不可改写；请复制为新题」（`src/services/l3-paper.service.ts:310-321`）。⇒ **一道答案键有误的 active 题，只要被做过一次，就永久不可修正**；而题级作答 `l3_question_attempts`、题级错题库（`verdict IN ('wrong','partial')`）、评卷分析全部建立在这道错题之上。直写 active 等于把一个**不可撤销的判定**交给 agent。
6. **§5 与 ADR-0035 早已冲突，此前无人记录**：§5 声明 trusted 白名单只有两面、评卷只对 trusted 开口；ADR-0035 决策 3 把 `POST /api/l3/sheets/:id/grading` 注册为 **minRole=agent**（`docs/adr/0035-agent-grading-execution.md:34`）。现状是**普通 agent 即可写评卷结果**，而 trusted 从未实现 —— 设计的方向与落地恰好相反。
7. 能力发现的唯一面是 `GET /api/l3/capabilities`，其 `access` 三元组现为 `{read:"all", write:"proposal_only", upgrade:"owner_only"}`（`src/http/routes/l3/capabilities.ts:28`）。

## Decision

1. **不实现 `trusted_agent`，不实现三段 token。** ADR-0030 §5 的白名单直写面**经核算后否决**（不是"以后再说"）：录题产物是**判断内容**（答案键 + 证据锚点），其错误在 §5 的直写语义下**不可撤销**（论据 5），而闸门方案以**零新增信任级**达成同一可用性。三段 token 因此**没有待启用的白名单面**。
2. **录题面 owner-only → agent 可写，但只写 `status='pending'`。** `status` 与 `created_by` 由服务端从已解析的 Principal 认定（owner 路径 `'owner'`，agent bearer → `agentId`），**请求体不接受这两个字段**（strict 契约拒越权键）—— 与 ADR-0035 决策 8 的 `graded_by` 同一信任模型。
3. **只开 create 与 update-pending；删除永禁。** agent 不可删题/删卷（ADR-0030 §5 红线一字不动）；agent 只能改 `status='pending'` 的题，遇 `active` 一律 **409**（否则 agent 可静默改掉用户已采纳的题）。
4. **owner 采纳 = 晋级通道**：`POST /api/l3/questions/:id/accept`（owner-only，`pending → active`，幂等同键覆写）与 `POST /api/l3/questions/accept-batch`（≤200 条，**逐条判定、逐条返回结果**）。驳回复用现有 `status='rejected'`，**不新增状态值、不新增迁移**。
5. **papers 面**：agent 只能建 `pending` 卷，且**卷内题强制 pending**；卷的采纳 = 卷内题全部转 active。**不做** agent 改 `active` 卷。
6. **采纳前必须有可核对面**：待录列表（`GET /api/l3/questions?status=pending`）必须显示**答案键与证据锚点的原文片段**。采纳是一次**可核对的判断**，不是点一下信任 —— 看不见答案键的采纳等于盲签，闸门就白设了。
7. **处置 §5 与 ADR-0035 的冲突：评卷面维持现状**（普通 agent 可写 `grading_results`），§5「评卷需 trusted 开口」显式作废。理由是两类产物性质不同：**评卷是可改判的消耗品**（`UNIQUE(sheet_id,question_id)` 覆写 + `graded_by` 留痕，错了改判即可），**录题是不可撤销的判定**（一旦被作答即锁死，论据 5）。可改判的产物与不可改判的产物**不该用同一道闸门**，也不该用同一个信任级。
8. **capabilities 口径**：`access` 改为 `{read:"all", write:"proposal_only", upgrade:"owner_only"}` **不变**（诚实：录题不是 proposal），另加独立字段 `authoring: { agentCanCreate:"pending", agentCanEdit:"pending_only", agentCanDelete:false, accept:"owner_only" }`。枚举值**从常量导出**，禁止复制成第二套真源（ADR-0029 决策 8③ 先例）。
9. **测试必交矩阵**（缺一不得开放）：agent 建题 → `pending` 且 `created_by = agentId`；agent 请求体带 `status` → 400；agent 改 `active` 题 → 409；agent 删题 → 403；agent 写 submissions → 403（ADR-0030 §5 红线）；owner 采纳 → `active` 且读面立即可见；采纳非属主 / 非 pending 题 → 404 / 409；批量部分失败**逐条可见**（禁止整批静默回滚成"全败"）。
10. **显式不做**：agent 直写 active、agent 删题、agent 触 L1/L2/FSRS、agent 写 submissions、来源自动信任（论据 5 的闸门就是全部防线，**不叠加第二套机制**）。

## Tradeoffs

- **一次点击 vs 零点击**：pending 闸门给每批录题加一次 owner 采纳（批量 = 一次点击）。换来的是「错答案键」在**被作答之前**可拦。选它是因为该错误的代价**永久**，而拦截成本**一次性** —— 两类成本不对等时应当选重的那个。
- **复用 `l3_questions.status` vs 走 `l3_proposals`**：proposal 是通用暂存（`l3_proposal_items` = item_type + payload + status），但它的 confirm 路径按 item_type 写死服务代码，套题会引入**第二套题目校验**；而 `l3_questions` 已有 status 轴 + CHECK + `created_by` + 读面过滤，复用等于**零迁移**。代价：pending 题不进 proposal 审计视图（补偿：`created_by` + telemetry 可按 agentId 检索，ADR-0029 决策 5 已有该日志口径）。
- **否决 §5 vs 保留扩展位**：否决后未来若真出现「可信录题流水线」需求，重开 ADR 即可 —— schema（`status` 轴、`created_by`）与 token 格式（ADR-0030 §5 原文）都已留位，**无迁移债、无半吊子代码**。
- **agent 可改 pending vs 只能新建**：只准新建会让 agent 陷入「建了改不了」的死循环，实际会把用户逼回手录；风险由「只改 pending」收口，且被改的题从未被采纳过，错了只是白干。
- **评卷面维持 agent 可写 vs 收紧**：收紧会与 ADR-0035 已交付并验收的闭环冲突，且无实质收益（评卷可改判）。代价是信任模型里存在一处**有意的**不对称。

## Consequences

- **服务/仓储**：service 按 `Principal.role` 决定 `status` / `created_by`（agent → `pending` + agentId；owner → 不变）；HTTP 层 strict 拒越权键；新增两个 owner-only 采纳端点 + 一个待录读面。**题读面零改动**（本就过滤 `active`）。
- **授权**：`operations.ts` 五个录题面 minRole 调整 + 两个采纳面登记；`tests/http/authorization-registry.test.ts:117,124` 的 owner-write inventory 需新增 pending-only 语义断言（"可写"不等于"可写 active"）。
- **无迁移**：`status` / `created_by` 列与 CHECK 已在 0032 落地；`db:schema:drift` 预期无变化。
- **capabilities**：按决策 8 增 `authoring` 字段（契约变更，走 `api:openapi` 再生）。
- **MCP**：**不动**（ADR-0029：传输层不新增信任级；本决策无新工具面）。
- **前端**（P3-3 实施卡）：待录列表 + 批量采纳交互，采纳前显示答案键与证据原文（决策 6）。
- **保留待跟踪**：若 agent 录题量增长到人工核对成为瓶颈（判据：单批 >200 条，或核对耗时 > 录入耗时），重开 ADR-0030 §5 —— 届时的证据是量，不是偏好。

## 补记一 · 决策 5 的 papers 面修正（实施前回码发现，2026-09-26）

**修正 A（决策 5）**：决策 5 的「agent 只能建 `pending` 卷」**不成立**，改为「agent 建的卷立即 `active`，但**卷内题强制 `pending`**」。
**修正**：决策 5 的「agent 只能建 `pending` 卷」**不成立**，改为「agent 建的卷立即 `active`，但**卷内题强制 `pending`**」。

**原因**（`src/db/schema.ts:1320`）：`l3_papers.status` 的 CHECK 是 `draft | active | archived` —— **没有 `pending` 这个值**。纸面状态轴是**生命周期**轴（草稿/生效/归档），不是**评审**轴；硬加 `pending` 需要一次迁移，而「无迁移」是决策 9 之外全篇的隐含前提。

**为什么闸门只落在题上是对的，不是妥协**：

1. 闸门要防的东西是**判断内容**（答案键 + 证据锚点），它只存在于题行。纸只是容器。
2. 容器立即 `active` 但卷内题全 `pending` ⇒ 该卷在任何读面都**解析不到可做的题**（读面一律经 `findActiveQuestionsByIds` 过滤 `status='active'`），即「建了但还不可做」，语义正确。
3. 「卷的采纳 = 卷内题全部转 active」由**批量采纳按题 id**天然覆盖，无需纸级状态。

**连带必须补的一处缺陷**（否则闸门造出死胡同）：`openSheet` 的 paper 分支直接取 `payload.sections[].questionIds` **不筛 active**（`src/services/l3-sheets.service.ts:98`），而 file 分支走 `listActiveQuestionsForFile`（只含 active）—— 两分支口径不一致。agent 建的空卷开纸会得到一张**有题单快照但渲染为空**的题纸，用户看不到任何解释。故实施时把 paper 分支对齐为「只解析 active 题，且为空即 422 并说明可能待录」。

**修正 B（决策 2 的落地方式，与决策文本同向但更强）**：决策 2 要求「请求体不接受 `status`/`created_by`」。实施时四个录题 schema 一律 `.strict()`，而不是只对这两个键做 `z.never()`。理由是**面向 agent 的 API 里「静默剥离未知键」本身就是缺陷**：agent 把 `evidence` 拼成 `evidnece` 时，非 strict 契约会静默丢弃，于是产出一道**没有证据的题**且不报错 —— 而"证据缺失"恰恰是本闸门要拦的东西之一。

代价是一次**记录在案的 breaking change**（`POST /api/l3/papers`、`POST /api/l3/questions` 的 request `additionalProperties` 由宽松变禁止），已按 ADR-0035 §勘误 的口径**整体重锚** `openapi-breaking-approval.json`（`baseSha256`/`currentSha256`/`issues` 三元组 ≡ 相对 base 的实测集合；历史 study-notes 条目已不在实测集合内，按机制要求一并舍去）。`message` 字段参与字节级比对，故决策理由记在此处而非 approval 文件内。

## 补记二 · 与 ADR-0035 的口径冲突处置记录

本 ADR 决策 7 是对一处**此前未被记录的冲突**的处置，过程留档以免复发：

- 冲突形态：ADR-0030 §5（2026-09-16）把 trusted 白名单限定为「录题 + 评卷」两面；ADR-0035（2026-09-17，次日）把评卷写面注册为 minRole=agent。**后写的 ADR 事实上放宽了前者的限制，而未声明修订**。
- 处置：评卷面**维持** ADR-0035 的现状（普通 agent 可写），§5 该条作废。理由是两类产物性质不同（决策 7），不因"新 ADR 优先"而机械服从。
- 教训：**ADR 之间出现实现分歧时，写下一个 ADR 时必须显式声明它是否修订前一个**。本项目的 ADR 不可变（只允许声明式修订），所以"沉默的放宽"会永久留在文本里，后来者只能靠考古发现 —— 本条即为考古结果。
