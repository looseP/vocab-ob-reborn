# L3 批次三①设计卡：agent 评卷执行面（本地 agent 闭环）

- **日期**：2026-09-17
- **状态**：**待同学批准**（批准后外派，ADR-0035 由 T1 撰写）
- **上游**：[l3-sheet-attempts-annotations-design-card-2026-09-17.md](./l3-sheet-attempts-annotations-design-card-2026-09-17.md)（v2 定稿：题纸/attempts/草稿注记/评析区/导出 v2）、ADR-0034（评析区三层权限边界、review 列契约）
- **前置事实**：批次二 + 增补批已交付合并（main HEAD `2fe327c`）；评析区 HTTP 双身份已通（`GET/PUT /api/l3/questions/:id/assessment`，owner/agent）；注记 `review jsonb` 列与 zod 契约已就位（批次二 T9，无执行面）
- **agent 形态确认**：本项目无独立 MCP server——**agent = HTTP Bearer 身份**（`AGENT_API_TOKENS` env，`agentId:token`；[agent-tokens.ts](../src/config/agent-tokens.ts) fail-fast 解析；[operations.ts](../src/http/operations.ts) 注册表声明 owner/agent 最小角色，fail-closed 缺省 owner）。本地 agent 经 `Authorization: Bearer` 直调 HTTP API。本批所有"agent 工具面"= 在此机制上登记新端点，零新基建。

---

## 0. 本卡解决什么

批次二把"做题 → 定格 → 草稿注记升格"修通了，但评卷环是断的：sealed 题纸的产物（答案、痕迹、submitted 注记）躺在库里没有消费者，注记 review 列空转，"主张需要被检验"只有承诺没有执行。本批接通最后一公里：

**owner 定格 → 本地 agent 读评卷上下文 → agent 提交评卷 → verdict/review 落库 → owner 解析模式处置**。

范围明示：verdict 真源表、评卷读面（D8 唯一例外）、评卷写面（事务 + review 执行）、owner 处置通道、解析模式展示。**不做**：自动触发评卷（本地 agent 无守护进程，MVP 口头指令驱动）、外部 agent 回灌（红线）、评卷历史版本。

---

## 1. 闭环形状（本地 agent 场景）

```
owner 定格（sealed；草稿注记 draft→submitted）
  → 用户口头指示本地 agent 评卷（可附 sheetId；agent 亦可自查待评题纸）
  → agent【读】GET /api/l3/sheets/:id/grading-context
        = 题 + 原文 + answerIndex/解析 + 用户作答 + flags/marks + submitted 注记（提交即授权收口）
  → agent 分析（对答案判对错；对注记判 sound/questionable/wrong；解读 flags/marks 对照）
  → agent【写】POST /api/l3/sheets/:id/grading
        = 事务：grading_results upsert + 注记 review 段写入 + sound→confirmed 流转
  → agent【可选】PUT /api/l3/questions/:id/assessment（评卷精华沉淀评析区；面已存在，行为约定）
  → owner 解析模式：题卡 verdict 徽标 + agent 分析 + 注记 review 对照 → 处置（confirm / 撤回改写）
```

---

## 2. D15 · `l3_grading_results` 表（迁移 0036）

| 列 | 说明 |
|---|---|
| `id` uuid PK | |
| `user_id` uuid FK→profiles CASCADE | RLS 锚 |
| `sheet_id` uuid FK→l3_submissions CASCADE | 一次评卷挂一张题纸 |
| `question_id` uuid FK→l3_questions CASCADE | 题删随删 |
| `verdict` text CHECK('correct','partial','wrong') | 题级判定；partial 服务翻译/作文等主观题 |
| `analysis_md` text | 题级分析（≤20k，可空——纯判对错的裸 verdict 合法） |
| `graded_by` text NOT NULL | agentId 留痕（服务端从 bearer 认定，**不是调用方自述**） |
| `graded_at` timestamptz DEFAULT now() | |

- **UNIQUE(sheet_id, question_id)**：latest-wins 改判覆写（与评析区同一哲学——评卷是消耗品不是资产；重评 = 同键覆写 + graded_at 刷新）。
- RLS own_all 单条 FOR ALL；vocab_app 四权；converge/verifier 双落点；迁移计数断言 **36→37**。
- **verdict 唯一定位**：本表是题级判定唯一真源（ADR-0034 条 5 已定 attempts 无判定列）；注记级判定写注记 `review` 列（批次二已建），两轨不混。

## 3. D16 · 评卷上下文读面（D8 唯一显式例外）

`GET /api/l3/sheets/:id/grading-context` —— operations 注册 **agent 可读**（owner 亦可读，语义无害）。

- **仅 sealed 题纸**：draft → **409**（双重防护：防答案泄漏进做题过程；防 agent 介入未定格状态）。discarded → 409（作答事实已弃，无卷可评；其产物注记的检验走下一题纸或人工）。
- **响应内容**（一次取齐，免 agent 多跳）：
  - 题纸元信息（scope/作用域/sealed_at/seal_mode）；
  - 每题：题干 + 选项 + **answerIndex + 解析**（D8 例外）+ 用户作答（attempts）+ flags/optionFlags/marks（self_assessment）+ submitted 注记（含锚点/excerpt/note/option_tags——**提交即授权收口：仅此集合，历史正式注记群不开放**）；
  - 原文（source content，供锚点核对）。
- **D8 例外必须钉死**（ADR-0035）：answerIndex 禁令管"做题模式 owner 视图"；本端点是定格后 agent 专属面——路径独立、注册表显式登记、响应契约注明"含答案，禁止接入做题模式前端"。前端**永不**消费此端点。

## 4. D17 · 评卷写面（事务 + review 执行 + 流转）

`POST /api/l3/sheets/:id/grading` —— operations 注册 **agent 可写**（owner 技术上可写但无场景；最小角色登记 agent）。

**输入**：`{results: [{questionId, verdict, analysisMd?, annotationReviews?: [{annotationId, verdict: 'sound'|'questionable'|'wrong', correctedTags?, comment?}]}]}`（1–200 条；空数组 400）。

**事务内三件事**（`requireTx`）：

1. **grading_results upsert**：(sheet_id, question_id) 冲突覆写 + graded_by/graded_at 刷新；questionId 必须属于该题纸作用域的题目集（越集 422）。
2. **注记 review 段写入**：走 **service 专用方法**（SQL 白名单只许 `review` 列 + `stage` 流转两列，**不复用公开 PATCH**——"agent 永不写注记内容"从 ADR 契约降级为代码级保证）；annotationId 必须属于该题纸 submitted 集合（防跨题纸污染，越集 422）。
3. **stage 流转**：`review.verdict='sound'` → **自动 confirmed**；`questionable/wrong` → **保持 submitted**（等 owner 处置，D18）。

**幂等**：重复提交 = 同键覆写（latest-wins），review 段覆写，stage 已 confirmed 的不降级（sound 已升 confirmed 后，重评 questionable 不回退 stage，只更新 review——终态不回滚原则，ADR 钉死）。

## 5. D18 · owner 处置通道

submitted + 有 review 的注记，owner 两选：

- **`POST /api/l3/annotations/:id/confirm`**（新小端点，owner-only）：submitted→confirmed——"我看过 review，保持原样"；
- **撤回改写**（批次二已有通道）：submitted→draft 重挂题纸，改后随下次定格重新提交检验。

confirmed 后 owner 可编辑（§4.7 矩阵不变；采纳 corrected_tags 由 owner 手动落，agent 不代笔）。

## 6. D19 · 双通道哲学（ADR 钉死）

| 通道 | 读 | 写回 |
|---|---|---|
| **本地 agent**（本批） | grading-context（bearer） | submit_grading + 评析区 PUT（bearer） |
| **外部 agent** | 导出 v2 文件（withAnswers=1） | **无回灌**——用户粘贴精华进评析区 |

agent 评卷后写评析区摘要 = **行为约定**（写入 ADR/工具描述），不是新端点。评析区 HTTP 双身份批次二已通，本批零改动。

## 7. 前端展示（解析模式）

- 题卡 verdict 徽标（✓ 对 / ✗ 错 / ◐ 半对）+ agent 分析折叠区（analysis_md 渲染）；
- 注记 review 对照展示：sound ✓ / questionable ? / wrong ✗ + corrected_tags 差异 + comment；submitted+有 review 的注记挂「确认」钮（D18）；
- 题纸状态：sealed 且无 grading_results = 「待评卷」提示（引导用户找 agent 评卷）；
- **做题模式零变更**——verdict/analysis 只在解析模式渲染（D8 精神延伸至 verdict：做题中不显示判定）。

## 8. ADR-0035 必钉清单（T1 撰写）

1. verdict 真源 = l3_grading_results（题级）/ 注记 review 列（注记级），两轨不混；
2. D8 唯一例外：grading-context 含 answerIndex，仅 sealed + agent 面，前端永不消费（§3）；
3. review 写入走 service 白名单专用方法，不复用公开 PATCH（§4.2）；
4. sound→confirmed 自动；questionable/wrong 保持 submitted；已 confirmed 不降级（终态不回滚）（§4.3）；
5. 改判 latest-wins 同键覆写，无历史版本（§2）；
6. owner 处置双通道：confirm 端点 / 撤回改写（§5）；
7. 双通道哲学：外部 agent 无回灌（§6）；
8. graded_by 服务端认定（bearer agentId），非调用方自述。

## 9. 风险与陷阱提示（外派纪律）

- **grading-context 响应含答案**：响应契约注释 + 前端 import 禁令（arch:check 规则或约定注释）双保险；
- 事务内跨表写（results + annotations.review）必须 `requireTx` 单事务，部分失败整体回滚；
- RLS：新表单条 FOR ALL 惯例；service 层 grading-context 读面跨表组装全部 withActor(actorId=userId)；
- 复杂度棘轮：新路由文件登记基线；api:openapi 再生 + currentSha256 重钉；
- 测试重点：越集 422（questionId/annotationId 不属于该题纸）、draft 409、重复提交覆写、sound 流转、questionable 保持、已 confirmed 不降级、RLS 隔离。

---

## 附：悬置继承

同学 09-17「两点提醒」第 2 点仍悬置——若在本批开工前补述，T1 一并钉入 ADR-0035。
