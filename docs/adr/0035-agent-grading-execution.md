# ADR-0035: agent 评卷执行面（本地 HTTP agent 闭环 + 评卷结果真源）

- **Status**: Accepted
- **Date**: 2026-09-17
- **Amends**: ADR-0034（**仅声明修订，不修改原文**）——v2 条 3「review jsonb：agent 检验产物（批次三 agent 写，本批只留列与契约形状）」至此**执行化**：review 列与 stage 流转从契约就位变为可写执行面；并将「做题模式响应不含答案」红线（设计卡 D8）的**唯一显式例外**与边界钉死为本 ADR 决策 2。承接 ADR-0033 §5 被 ADR-0034 §4 所做的「提交即授权」部分修订，将其落为执行面事实
- **References**: ADR-0029（owner/agent 边界与授权注册表——本批新增 agent 写面第 2 开口：评卷提交；信任锚 agentId）、ADR-0033（注记锚点体系与「agent 永不写注记内容」）、ADR-0034（题纸/attempts/stage/review 形状）、ADR-0025（导出 v2「只出不进」——外部 agent 无回灌通道的结构依据）、设计卡《L3 批次三①：agent 评卷执行面》（2026-09-17，D15–D19）、任务表《L3 批次三①任务分解》（2026-09-17）

## Context

批次二把「做题 → 定格 → 草稿注记升格」修通了，但评卷环是断的：sealed 题纸的产物（答案、痕迹、submitted 注记）躺在库里没有消费者，注记 `review` 列空转，「主张需要被检验」（ADR-0034 §0 哲学 3）只有承诺没有执行。本 ADR 把评卷闭环的不可回退决策钉死：

**owner 定格 → 本地 agent 读评卷上下文 → agent 提交评卷 → verdict/review 落库 → owner 解析模式处置**。

**agent 形态定论**：本项目**无独立 MCP server 参与评卷**——agent = **HTTP Bearer 身份**（`AGENT_API_TOKENS` 的 `agentId:token` 映射，ADR-0029 决策 5 信任锚）+ `operations.ts` 注册表最小角色声明。本地 agent 以 `Authorization: Bearer` 直调 HTTP API；「agent 工具面」的增长 = 在注册表上登记新端点，**零新基建**。此形态是对 ADR-0029「MCP = 传输层、不新增信任级」的切实现实：MCP 桥非本闭环的必要组件，能力发现经既有 `/api/l3/capabilities`。

范围明示：verdict 真源表、评卷读面（D8 唯一例外）、评卷写面（事务 + review 执行）、owner 处置通道、解析模式读面。**不做**：自动触发评卷（本地 agent 无守护进程，MVP 口头指令驱动）、外部 agent 回灌（红线）、评卷历史版本、推荐引擎/标签聚合（批次三②③）。

## Decision

### 1. 评卷结果真源：`l3_grading_results`（迁移 0036，D15）

- 列：`id` / `user_id`（FK→profiles CASCADE，RLS 锚）/ `sheet_id`（FK→l3_submissions CASCADE）/ `question_id`（FK→l3_questions CASCADE）/ `verdict`（CHECK：correct|partial|wrong）/ `analysis_md`（≤20k 由契约层收口，可空——纯判对错的裸 verdict 合法）/ `graded_by`（**服务端认定**，见决策 8）/ `graded_at`。
- **UNIQUE(sheet_id, question_id)**：改判 = 同键覆写 + `graded_at` 刷新（latest-wins，与评析区同一哲学——评卷是消耗品不是资产）；**无历史版本**。partial 服务翻译/作文等主观题。
- **verdict 唯一定位（两轨不混）**：题级判定真源 = 本表；注记级判定真源 = 注记 `review` 列（两轨各归其位，ADR-0034 §2「attempt 无判定列」的双真相拆解在本批闭环）。

### 2. 评卷上下文读面：`GET /api/l3/sheets/:id/grading-context`（D8 唯一显式例外，D16）

- 注册 **agent 可读**（owner 亦可，语义无害）。**仅 sealed 题纸**：`draft` → 409（双重防护：防答案泄漏进做题过程；防 agent 介入未定格状态）；`discarded` → 409（作答事实已弃，无卷可评）。
- 响应一次取齐：题纸元信息（scope/scope_key/sealed_at/seal_mode）+ 每题（题干/选项/**answerIndex/解析** + 该题纸内最新 active attempt 的作答与主观快照 flags/optionFlags/marks + 该题纸 `stage='submitted'` 注记〈锚点/excerpt/note/option_tags〉）+ 原文（file=source；paper=去重后的多 source 集合）。
- **D8 例外的边界钉死**（做题模式 `answerIndex`/标准答案禁令的唯一例外）：本端点是**定格后**的 **agent 专属面**——路径独立、注册表显式登记、响应契约注明「含答案，禁止接入做题模式前端」；**前端永不消费此端点**。授权收口：注记集合 = 该题纸 `submitted`（历史正式注记群不开放，ADR-0034 §4「提交即授权」的执行化）。

### 3. 评卷写面：`POST /api/l3/sheets/:id/grading`（D17）

- 注册 **agent 可写**（owner 技术上可写但无场景；最小角色登记 agent）。输入 `{results: [{questionId, verdict, analysisMd?, annotationReviews?: [{annotationId, verdict: 'sound'|'questionable'|'wrong', correctedTags?, comment?}]}]}`（1–200 条；空数组 400）。
- **事务内三件事**（`requireTx` 单事务，部分失败整体回滚）：
  1. **results upsert**：`(sheet_id, question_id)` 冲突覆写 + graded_by/graded_at 刷新；questionId 越出该题纸作用域题目集 → **422**；
  2. **注记 review 写入走 service 白名单专用 SQL**——只许 `review` 列（+ `stage` 流转）+ `updated_at`，**不复用公开 PATCH**（「agent 永不写注记内容」从契约降级为代码级保证）；annotationId 不属于该题纸的已提交注记（submitted/confirmed 集合）→ **422**；
  3. **stage 流转**：`review.verdict='sound'` → 自动 `confirmed`；`questionable`/`wrong` → 保持 `submitted`（等 owner 处置）；**已 confirmed 不降级**（终态不回滚——重评只更新 review，stage 不动）。
- **幂等**：重复提交 = 同键覆写（latest-wins），review 段覆写，stage 按上述矩阵单向。

### 4. owner 处置通道：`POST /api/l3/annotations/:id/confirm`（D18）

- **owner-only**：`submitted → confirmed`（「我看过 review，保持原样」）；非 submitted → **409**。第二条通道是**撤回改写**（批次二既有 `POST /api/l3/question-annotations/:id/withdraw`）：submitted → draft 重挂题纸，改后随下次定格重新提交检验。
- confirmed 后 owner 可编辑（ADR-0034 条 7 矩阵不变；采纳 `corrected_tags` 由 owner 手动落，agent 不代笔）。

### 5. 解析模式读面：`GET /api/l3/sheets/:id/grading`（owner 读，前端数据源）

- **owner-only** 读面（与 getL3Sheet/export 同族）：返回该题纸 `grading_results` 行集合（question_id / verdict / analysis_md / graded_by / graded_at；无行为空数组——「待评卷」提示的数据源）。**不含 answerIndex**，与决策 2 的 agent 面严格分离；这是解析模式前端（verdict 徽标 + 分析渲染 + 处置入口）的唯一新数据通道，**前端只消费此面**。
- 边界：verdict/analysis 只在**解析模式**（定格后 frontend reveal）渲染；做题模式零变更（D8 精神延伸至 verdict：做题中不显示判定）。

### 6. 双通道哲学（D19）：外部 agent 无回灌

| 通道 | 读 | 写回 |
|---|---|---|
| **本地 agent**（本 ADR） | grading-context（bearer） | submit_grading + 评析区 PUT（bearer） |
| **外部 agent** | 导出 v2 文件（withAnswers=1） | **无回灌**——用户粘贴精华进评析区 |

agent 评卷后写评析区摘要 = **行为约定**（写入本 ADR 与工具描述），不是新端点；评析区 HTTP 双身份批次二已通（ADR-0029 Amendment），本批零改动。

### 7. ADR-0034 §8 必钉清单逐条落点

| # | 必钉条 | 落点 |
|---|---|---|
| 1 | verdict 真源（题级表 / 注记级 review 列，两轨不混） | 决策 1 |
| 2 | D8 唯一例外：grading-context 仅 sealed + agent 面，前端永不消费 | 决策 2 |
| 3 | review 写入走 service 白名单专用方法，不复用公开 PATCH | 决策 3.2 |
| 4 | sound→confirmed 自动；questionable/wrong 保持 submitted；已 confirmed 不降级 | 决策 3.3 |
| 5 | 改判 latest-wins 同键覆写，无历史版本 | 决策 1 |
| 6 | owner 处置双通道：confirm 端点 / 撤回改写 | 决策 4 |
| 7 | 双通道哲学：外部 agent 无回灌 | 决策 6 |
| 8 | graded_by 服务端认定（bearer agentId），非调用方自述 | 决策 3.1（引擎见 §输入） |

### 8. graded_by 服务端认定（钉死）

`graded_by` 由服务端从**已解析的 Principal** 认定：agent bearer → `agentId`（ADR-0029 决策 5，`AGENT_API_TOKENS` 映射）；owner 路径 → `'owner'`。请求体**不携带**任何 graded_by/agentId 字段（strict 契约拒绝越权键）——与 `proposal.provenance.agentId` 同一信任模型。

## Tradeoffs

- **新表 vs 复用 attempts.self_assessment**：attempt 是**不可变作答事实**（当场自评属用户认知状态），agent 判定是**可改判的外部意见**；写进 attempt 会让「改判=改历史事实」直接腐化双真相。新表代价是第二个读 join，收益是真源正交、改判不碰作答链。
- **UNIQUE 同键覆写 vs 历史版本表**：评卷是消耗品（改判 = 修正意见），历史版本带来「哪一版算数」的消费复杂度且无场景（单 owner 本机）；代价是改判不可回溯，由 `graded_at` 刷新 + 前端「最新一次」语义兜底。
- **grading-context 一次取齐 vs 多跳**：本地面向 agent 的载荷含长文（source 原文 + 解析），响应体可达数百 KB；收益是 agent 单次调用即可完成全卷评卷（免多跳组合状态），代价是响应偏大（本地 127.0.0.1 + bodyLimit 1 MiB 内可接受；超限的词级展开留后续）。
- **D8 例外 vs 绝对禁令**：做题模式零泄漏必须绝对，但评卷需要答案——例外用「路径独立 + 注册表显式登记 + 仅 sealed + 前端禁用 + 响应契约注明」五重边界收口，而非把整条禁令降级为「区分用途」。代价是未来任何「给前端看答案」的需求都必须再走一次 ADR，收益是禁令的默认态保持 fail-closed。
- **owner 读面（决策 5）新增 vs 扩 getL3Sheet**：扩题纸详情会让做题数据流（draft 恢复/派生渲染）与评卷数据流耦合进同一响应（做题模式响应形状对 verdict 敏感）；独立端点保持「做题模式零变更」的字面成立，代价是前端在 sealed 后多发一次请求（低频，可接受）。

## Consequences

- 迁移 0036：`l3_grading_results`（UNIQUE(sheet_id,question_id) + 三 FK CASCADE + RLS own_all 单条 FOR ALL + vocab_app 四权 + converge/verifier 双落点 + 迁移计数断言 36→37）。
- domain：`GRADING_VERDICTS` / `gradingSubmitInputSchema`（strict；results 1–200、批内 questionId/annotationId 去重 fail-closed）/ 作用域越集校验纯函数 / `nextAnnotationStage`（终态不回滚谓词）；复用批次二契约 `ANNOTATION_REVIEW_VERDICTS`。
- repository/service：`L3GradingRepository`（read by sheet / 批量 upsert）+ 注记白名单方法（只触 review/stage/updated_at）+ `L3GradingService`（buildGradingContext 只读组装 / submitGrading requireTx / confirmAnnotation）。
- http：3 个新端点（注册表 + 授权注册表 D5/D6/F1 分类）+ 独立薄路由 `routes/l3/grading.ts` 直挂 server.ts + 复杂度棘轮 bootstrap 登记 + openapi 再生与 currentSha256 重钉。
- 前端：题卡 verdict 徽标（✓/✗/◐）+ agent 分析折叠区 + 注记 review 对照（sound/questionable/wrong + corrected_tags + comment）+ submitted+review 注记「确认」钮 + sealed 无结果「待评卷」提示；做题模式一字不动。
- 批次三保留：外部 agent 回灌（不做）、自动触发评卷（不做）、评卷历史版本（不做）、推荐引擎/标签聚合面板（批次三②③）。

## 勘误 · 2026-09-17（批次三①深测会审 P3-1 裁定）

Consequences 中「openapi 再生与 currentSha256 重钉」（任务表与设计卡同述句同此）为**措辞偏差**，与 `scripts/verify-openapi-breaking.ts` 实际机制不符。机制真相（`applyBreakingApproval`；早退分支已有测试锁定，`tests/scripts/verify-openapi-breaking.test.ts:323-336`）：

- approval 文件相对 base **未变更即早退**——既不校验哈希、也不提供豁免（未修改的 approval 不会继续豁免后续 breaking）；
- 仅当变更集**修改**了 `openapi-breaking-approval.json` 时才强制激活校验，且须**整体重锚三元组**：`baseSha256` ≡ sha256(openapi@PR base)、`currentSha256` ≡ sha256(openapi@HEAD)、`issues` ≡ 相对 base 的实测 breaking 集合（保留任何未在 diff 中的历史条目即拒——2026-09-17 三场景控制实验实测）；
- 「每次再生都重钉」在机制语义下不可持续：重锚天然以「某次 base/HEAD 对」为有效期，下一批再生即再漂移；且 7e1fd39（锚点语义定稿）之后 18 个 openapi 变更提交零重钉、门禁全绿，即为惯例背书。

**本批裁定**：B3① 未修改 approval（2fe327c→60586c1 实测零 breaking，外派与本地方双渠道复核），无重钉动作、任何门禁行为不受影响。**自本勘误起，「重钉」口径统一为：仅当变更集修改 approval 文件时才需重锚；常规 openapi 再生无须处理。**
