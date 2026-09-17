# L3 批次三①任务分解：agent 评卷执行面（2026-09-17）

- **设计真源**：[l3-grading-batch3-design-card-2026-09-17.md](./l3-grading-batch3-design-card-2026-09-17.md)（D15–D19，同学批准生效）
- **代码根**：`wt-main/`（main HEAD `2fe327c`，批次二+增补批已合并）
- **agent 形态**：无 MCP server——HTTP Bearer 身份 + operations 注册表（设计卡 §0）

## 纪律（承批次一/二，全量沿用）

- 先 ADR 后代码（T1 = ADR-0035 Accepted）；TDD；一任务一提交（conventional + 中文正文）。
- 门禁：typecheck / arch:check / test:unit / frontend:build / complexity:routes / api:client:check / db:schema:drift / rls:acceptance:test:l3。
- DDL：schema.ts 同步 + RLS 单条 FOR ALL + converge/verifier 双落点 + 迁移计数断言 **36→37** + 快照链唯一性。
- API：api:governance 六步；新路由直挂 `src/http/server.ts` + verify-route-complexity 登记；openapi 再生后重钉 currentSha256。⚠️ 勘误（2026-09-17 深测会审）：仅当变更集修改 approval 文件时才需整体重锚，常规再生无须重钉——见 ADR-0035 §勘误。
- **D8 红线修订**：answerIndex 唯一例外 = grading-context（sealed + agent 面）；做题模式任何响应仍绝不含答案/verdict/analysis。
- 前端响应 `Array.isArray` 防御；中文文案 + 设计 token；按钮 stopPropagation。

---

## B3①-T1 · ADR-0035 + 文档入库

| 项 | 内容 |
|---|---|
| 落点 | `docs/adr/0035-agent-grading-execution.md`（新）；同提交带入本任务表与设计卡 |
| 要点 | 设计卡 §8 必钉 8 条逐条落；Amends：ADR-0034（review 列从"契约就位"到执行化）、D8 例外声明；References：ADR-0029/0033/0034、导出 v2 双通道哲学 |
| 验收 | ADR Accepted；与后续实现零冲突 |

## B3①-T2 · 迁移 0036：`l3_grading_results`

| 项 | 内容 |
|---|---|
| 落点 | `src/db/schema.ts`、`drizzle-release/0036_*.sql`、converge/verifier 双落点 |
| 表 | 设计卡 §2 全列；**UNIQUE(sheet_id, question_id)**；FK 双 CASCADE；RLS own_all 单条 FOR ALL；vocab_app 四权；迁移计数 36→37 |
| 验收 | dev migrate 成功；drift/gates 全绿 |

## B3①-T3 · domain 契约

| 项 | 内容 |
|---|---|
| 落点 | `src/domain/l3-grading.ts`（新）、`src/domain/index.ts` 导出 |
| 契约 | `GRADING_VERDICTS`（correct/partial/wrong）；`ANNOTATION_REVIEW_VERDICTS`（sound/questionable/wrong——与批次二 review 列契约对齐复用）；`gradingSubmitInputSchema`（results 1–200，annotationReviews 嵌套）；题纸作用域题目集校验纯函数；**终态不回滚谓词**（confirmed 不降级） |
| 验收 | domain 层 vitest 全绿；零 IO 零出向 |

## B3①-T4 · repository + service

| 项 | 内容 |
|---|---|
| 落点 | `src/repositories/l3-grading.repository.ts`（新）、`src/services/l3-grading.service.ts`（新）、`l3-annotations.repository.ts`（review 白名单专用方法）、interfaces.ts |
| 读面 | `buildGradingContext`：题纸 + 题（含 answerIndex/解析）+ attempts + self_assessment + submitted 注记 + source 原文，单事务只读组装；仅 sealed（draft/discarded → 409） |
| 写面 | `submitGrading`（requireTx）：①results upsert（同键覆写 + graded_by 服务端注入）；②注记 review 写入**白名单专用 SQL**（仅 review/stage 两列，不复用公开 PATCH）；③sound→confirmed、questionable/wrong 保持、**已 confirmed 不降级**；questionId/annotationId 越集 → 422 |
| confirm | `confirmAnnotation`（owner）：submitted→confirmed；非 submitted → 409 |
| 验收 | repo/service 层用例：越集 422、409 两态、覆写幂等、流转矩阵、白名单 SQL 只触两列 |

## B3①-T5 · 路由 + 授权注册

| 项 | 内容 |
|---|---|
| 落点 | `src/http/routes/l3/grading.ts`（新，直挂 server.ts）、operations.ts、响应契约（注明"含答案，禁止接入做题模式前端"） |
| 端点 | `GET /api/l3/sheets/:id/grading-context`（owner/**agent**）；`POST /api/l3/sheets/:id/grading`（owner/**agent**，sessionMutation）；`POST /api/l3/annotations/:id/confirm`（owner/owner，sessionMutation） |
| 验收 | http 用例（角色门控 fail-closed/409/201 语义）；api 治理六步 + 复杂度登记 + openapi 再生 + currentSha256 重钉（⚠️ 勘误见 ADR-0035 §勘误：仅修改 approval 时才需重锚） |

## B3①-T6 · RLS 集成测试追加

| 项 | 内容 |
|---|---|
| 落点 | `tests/l3-rls.integration.test.ts` 追加（复用 55433 栈） |
| 用例 | actor A sealed 题纸 + grading_results upsert/读；actor B 不可读/越权写空转/WITH CHECK 拒插；review 写入不越权改 note（白名单 SQL 下 note 不变断言） |
| 验收 | rls:acceptance:test:l3 全绿（19 既有 + 新增零回归） |

## B3①-T7 · 前端解析模式展示

| 项 | 内容 |
|---|---|
| 落点 | `L3ExamPaper.tsx` / `L3QuestionAnalysis.tsx` / l3Client.ts（扩） |
| 展示 | 题卡 verdict 徽标（✓/✗/◐）+ analysis_md 折叠区（解析模式才渲染）；注记 review 对照（sound ✓/questionable ?/wrong ✗ + corrected_tags 差异 + comment）；submitted+有 review 注记挂「确认」钮（D18） |
| 引导 | sealed 且无 grading_results → 「待评卷」提示（引导找 agent 评卷）；**做题模式零变更**（verdict/analysis 不进做题视图） |
| 验收 | 组件测试（徽标/折叠/确认钮/待评卷提示）；中文文案 |

## B3①-T8 · 端到端实测 + 收官

| 项 | 内容 |
|---|---|
| 实测 | 同学/主 agent 以真实 agent token 走一遍：定格 → grading-context → submit_grading（含注记 review）→ 前端解析模式核对 → confirm/撤回处置 → 评析区沉淀 |
| 收官 | 全门禁；交付摘要（每任务一行 + 门禁输出 + 冒烟路径） |

---

## 端到端验收主线

1. 真实题纸定格（含 draft 注记 + flags + marks）→ sealed；
2. agent 身份 `GET grading-context`：answerIndex 在、submitted 注记在、历史 confirmed 注记**不在**（授权收口验证）；
3. `POST grading` 提交混合结果（correct/wrong/partial + sound/questionable 注记 review）→ 库内核对：results 落表、sound 注记 confirmed、questionable 保持 submitted；
4. 重复提交改判 → 同键覆写、graded_at 刷新、已 confirmed 不降级；
5. 前端：解析模式 verdict/分析/review 对照/确认钮；做题模式确认无 verdict 泄漏；
6. owner 对 questionable 注记走「确认」与「撤回改写」两条路各一次。
