# L3 批次二任务分解：题纸 × 作答历史题中心化 × 草稿注记升格（2026-09-17）

- **设计真源**：[l3-sheet-attempts-annotations-design-card-2026-09-17.md](./l3-sheet-attempts-annotations-design-card-2026-09-17.md)（D7–D12 定稿，2026-09-17 同学确认）
- **上游总分解**：[l3-venue-wave-tasks-2026-09-16.md](./l3-venue-wave-tasks-2026-09-16.md)（本批 = 其 V2-T6 + V3-T1/T2 owner 侧 + 09-17 设计卡新增；agent 评卷执行面留批次三）
- **代码根**：`wt-main/`（HEAD `bfec259`，0033 已迁移，批次一 10 Task 已验收）

## 纪律（每任务通用）

- 先 ADR 后代码（T1 = ADR-0034 Accepted，Amends ADR-0030/0033）；中文文案 + 设计 token 起步，不新增英文工程文案。
- 门禁：typecheck / arch:check / test:unit（分层覆盖 + diff ≥85%）/ frontend:build / complexity:routes；API 变更走 api:governance 六步；DDL 走 schema.ts 同步 + RLS + converge/verifier 双落点 + drift + 快照链唯一性。
- 复杂度棘轮：新路由文件须在 `scripts/verify-route-complexity.ts` 登记基线；domain 纯函数零出向。
- 提交：conventional commits + 中文正文，一任务一提交（先例 `6b4d5f2`）。

## 工程先例与陷阱（批次一实测教训，必须遵守）

1. RLS policy 单条 `FOR ALL`（37 张表统一惯例）；RLS 下 `SELECT…FOR UPDATE` 要求行同时通过 SELECT + UPDATE policy（0024 行锁陷阱）——题纸状态守卫会用到。
2. 新路由**直挂 `src/http/server.ts`**（`l3/index.ts` 组合器受棘轮冻结；papers/spaces/annotations 先例），并同步登记复杂度基线。
3. zod 4：`z.record` 语义变化 → strict 显式键；PATCH 形状**纯 optional 无 default**（`.partial()` 会保留 default 误清空未提交列）。
4. 批量查询列名核对（`question_id = ANY(...)`，非 `id`——6665a77 实测 bug）。
5. 前端对 API 响应 items/entry/option 一律 `Array.isArray` 归一防御。
6. `db:generate` 前确认快照链 id/prevId 无重复（0033 前的 collision 教训）。
7. 授权双落点：converge 会 REVOKE 重建 ACL，verifier 期望清单三处同步；迁移计数权威断言同步 **34 → 35**。
8. `api:openapi` 再生成后须重钉 `openapi-breaking-approval.json` 的 currentSha256。
9. answerIndex / 标准答案字段绝不出现在做题模式任何 API 响应（spec D8）；卡内交互按钮 `stopPropagation`，高亮纯 mark 无 onClick。
10. 迁移里 GRANT 语句按 0032/0033 惯例只写注释说明，实际 GRANT 走 converge（见 0032 文件头注释先例）。

---

## B2-T1 · ADR-0034 + 文档入库

| 项 | 内容 |
|---|---|
| 落点 | `docs/adr/0034-sheet-attempt-annotation-stages.md`（新）；同提交带入本任务表与设计卡（当前未跟踪） |
| 要点 | Amends ADR-0030（作答侧引用哲学：无冻结副本）/ ADR-0033 §5（提交即授权）；钉死设计卡 §7 六条清单 + stage/status 正交划分 + `scope_key` 设计 + 定格后 `submissions.answers` 清空（attempts 是唯一作答真源，拆双真相） |
| 验收 | ADR Accepted；docs 提交入库；后续任务实现与其零冲突 |

## B2-T2 · 迁移 0034：题纸 + attempts + 注记扩列

| 项 | 内容 |
|---|---|
| 落点 | `src/db/schema.ts`、`drizzle-release/0034_*.sql`、`scripts/bootstrap-database-roles.ts`、`scripts/verify-database-roles.ts` |
| `l3_submissions`（题纸） | `user_id`/`scope CHECK('file','paper')`/`scope_key text NOT NULL`（`file:<source_id>:<question_type>` 或 `paper:<paper_id>`，规避组合列 NULL 不去重陷阱）/`source_id?`+`question_type?`/`paper_id?`/`status CHECK('draft','sealed','discarded')`/`answers jsonb DEFAULT '{}'`（仅 draft 期有效，定格清空）/`seal_mode CHECK('full','incremental','summary')?`/`summary text`/时间戳；**部分唯一索引 `(user_id, scope_key) WHERE status='draft'`**（一作用域一张在写题纸）；question FK 校验归属（file→source 属主、paper→paper 属主） |
| `l3_question_attempts` | `user_id`/`question_id FK→l3_questions ON DELETE CASCADE`/`sheet_id uuid? FK→l3_submissions ON DELETE SET NULL`/`venue CHECK('file','paper')`/`answer jsonb NOT NULL`/`self_assessment jsonb`（当场自评快照）/`status CHECK('active','deleted')` 默认 active/`deleted_at timestamptz?`/`created_at`；索引 `(user_id, question_id, created_at)`、`(sheet_id)`；**无判定列**（verdict 真源 = l3_grading_results，批次三） |
| `l3_question_annotations` 扩列 | `stage text NOT NULL DEFAULT 'confirmed' CHECK('draft','submitted','confirmed')`（ADD COLUMN DEFAULT 存量自动回填 confirmed）/`sheet_id uuid? FK→l3_submissions ON DELETE SET NULL`/`review jsonb`（`{verdict:'sound'|'questionable'|'wrong', corrected_tags?, comment?}`，批次三 agent 写） |
| RLS/GRANT | 三表 own_all 单条 FOR ALL；vocab_app 四权（状态守卫行锁需 UPDATE）；converge + verifier 期望清单双落点；迁移计数断言 34→35；`db:schema:drift` 过 |
| 验收 | dev 库 migrate 成功；快照链 id 唯一；drift/gates 全绿 |

## B2-T3 · domain 契约：状态机 + 定格 + 覆盖度

| 项 | 内容 |
|---|---|
| 落点 | `src/domain/l3-sheets.ts`（新）、`src/domain/l3-annotations.ts`（扩）、`src/domain/index.ts` 导出 |
| 题纸状态机 | `canPatchSheet(status)`（仅 draft）、`sheetStatusAfterSeal(mode)`（full→sealed；incremental/summary→discarded）、seal 输入形状（mode + summary? + 未答题计数软确认标志）纯函数 |
| attempt 契约 | create/列表 zod；`answer` 为题型无关 jsonb 对象（V2-T5「存储与交互解耦」既定）；self_assessment 形状宽松 |
| 注记 stage | `ANNOTATION_STAGES`、流转谓词（draft→submitted 仅随定格；→confirmed 由 owner 确认/agent 检验通过，本批只留 confirmed 端点形状）；`stage` 与既有 `status`（软删）正交 |
| 覆盖度视图 | `annotationCoverage(annotations, optionKeys)` → 「A✓ B✓ C— D—」形状纯函数（只呈现不催） |
| 验收 | vitest domain 层新用例全绿；零 IO 零出向（arch:check） |

## B2-T4 · repository：题纸守卫 + 物化 + 历史链

| 项 | 内容 |
|---|---|
| 落点 | `src/repositories/l3-sheets.repository.ts`（新）、`l3-annotations.repository.ts`（扩）、`src/repositories/interfaces.ts` |
| 题纸 | `findDraftByScopeKey`（幂等开纸）、`openSheet`（冲突复用返回既有行）、`patchAnswers`（**条件 UPDATE `WHERE status='draft'`**，竞态安全）、`sealSheet`（状态流转 + 定格时间）、`getSheet` |
| attempts | `insertAttempts`（批量）、`listForQuestions`（题历史链，过滤 deleted，`question_id = ANY`）、`softDeleteAttempt`（status+deleted_at）、`listBySheet`（结果页派生源）、`countAnsweredBySheet`（定格前未答题计数） |
| 注记扩 | `listDraftBySheet`（升格候选）、`promoteBySheet`（draft→submitted 批量 UPDATE，条件 stage='draft' AND sheet_id）、`insertSummaryAnnotation`（mode=summary 的无锚点总结条，挂作用域代表题=有序第一题，stage='submitted'） |
| 验收 | repo 层单测：状态守卫 409 语义、竞态条件 UPDATE、软删过滤、批量列名核对（先例 4） |

## B2-T5 · service + 7 端点（owner-only）

| 项 | 内容 |
|---|---|
| 落点 | `src/services/l3-sheets.service.ts`（新）、`src/http/routes/l3/sheets.ts`（新，直挂 `server.ts`）、`src/schemas/http/index.ts`、`src/http/operations.ts`、响应契约 `src/http/l3-sheet-response-contract.ts`（新） |
| 端点 | `POST /api/l3/sheets`（开纸：scope 键，幂等 200/新建 201）；`GET /api/l3/sheets/:id`（draft 含 answers；sealed 逐题明细**从 attempts 派生**，不读 answers）；`PATCH /api/l3/sheets/:id`（逐题 merge：`answers: Record<questionId, answer\|null>`，null 清除；非 draft → **409**）；`POST /api/l3/sheets/:id/seal`（定格，见下）；`GET /api/l3/attempts?questionIds=`（批量徽标聚合，1–200）；`DELETE /api/l3/attempts/:id`（软删 204，再删 404） |
| seal 事务（`requireTx`） | 输入 `{mode, summary?}`；full：物化已作答 attempts（未答不落）+ 注记 draft→submitted + sheet→sealed + **answers 清空**；incremental：注记全升格 + sheet→discarded；summary：建总结条 + sheet→discarded；响应含未答题计数（paper 软确认数据源）；题归属校验借道 paperRepo（404 语义同批次一） |
| 鉴权 | operations 注册表 owner/owner（sessionMutation；GET 走 none 缓存策略同批次一）；`:id` 不做 uuid 预校验 |
| 验收 | http 层用例：开纸幂等/merge/PATCH 409/三档定格/软删 404/批量上限；api:governance 六步 + 复杂度登记 + OpenAPI 客户端再生 + currentSha256 重钉 |

## B2-T6 · RLS 集成测试追加

| 项 | 内容 |
|---|---|
| 落点 | `tests/l3-rls.integration.test.ts`（追加用例；复用 55433 栈与 ACTOR_A/B 夹具） |
| 用例 | ①actor A 开纸/作答/物化 attempts + draft 注记；②actor B 读不到对方题纸/attempts/草稿注记；③B 越权 PATCH/软删空转；④B 伪插 WITH CHECK 拒绝；⑤sealed 后 UPDATE answers 空转（状态谓词在 SQL 条件内） |
| 验收 | `rls:acceptance:test:l3` 全绿（既有 11 用例零回归 + 新用例） |

## B2-T7 · 前端：数据层 + 题纸栏 + 定格档位

| 项 | 内容 |
|---|---|
| 落点 | `src/frontend/api/l3Client.ts`（扩）、`src/frontend/components/l3/L3ExamPaper.tsx` |
| 数据层 | openSheet/getSheet/patchSheet/sealSheet/listAttempts/deleteAttempt；响应形状 `Array.isArray` 防御（先例 5） |
| 题纸栏 | 卷面顶部细条：状态徽标（草稿·保存中/已保存 HH:mm）+ 作用域名；进卷自动开纸（幂等）；作答防抖 800ms 逐题 merge PATCH |
| 定格 | 底部「定格」按钮 → 档位确认 modal（三档 radio 中文说明：完整记录/增量条目/只留总结 + 未答题提示 + summary 文本框按档显示）→ seal → 成功 toast + 即判入口提示（sealed 响应含已判定统计时引导切解析模式） |
| draft 注记样式 | 虚线描边区分正式注记（设计卡 §4.5）；draft 仅本题纸上下文渲染 |
| 验收 | 组件测试：防抖 merge 时序、档位表单校验、sealed 后输入禁用；中文文案；窄屏不溢出 |

## B2-T8 · 前端：历史徽标 + modal 预览 + 派生渲染

| 项 | 内容 |
|---|---|
| 落点 | `L3QuestionAnalysis.tsx`（徽标+覆盖度）、新 `L3AttemptHistoryModal.tsx`、`L3ExamPaper.tsx`（装配） |
| 徽标 | 题卡头部「做过 N 次 · 最近 ✓/✗」（listAttempts 批量；两 venue 同显）；点击开 modal |
| modal | 题干 + attempts 时间线（时间/venue/答案摘要/自评）+ 注记摘要 + 「去题型空间打开此文」深链（`?venue=<type>&file=<key>`）+ 单条历史删除（confirm + 软删） |
| 派生渲染 | sealed 题纸详情从 attempts 渲染逐题明细；已删条目显示「作答记录已清理」占位（内容不展示，尊重删除意图）；统计口径不变（软删行仍在库，同源现算） |
| 覆盖度 | 题卡子区「A✓ B✓ C— D—」（纯函数消费） |
| 验收 | 组件测试 + 手动冒烟（modal 不打断做题流；深链可达） |

## B2-T9 · agent 面契约（只定契约，执行留批次三）

| 项 | 内容 |
|---|---|
| 落点 | `src/domain/l3-sheets.ts`（review zod）、`src/http/operations.ts` / MCP capabilities 注册语义、ADR-0034 对应段 |
| 要点 | 评卷产物 `annotation_reviews[]` 段契约（verdict/corrected_tags/comment——对齐 T2 review 列）；提交即授权语义登记：agent 可读范围 = 该题纸 `stage='submitted'` 草稿注记，按题纸作用域收口；**agent 永不写注记内容**（note/锚点/原判标签不可篡改），只写 review |
| 验收 | 契约 zod + 注册表登记 + 单测；无 agent 写端点（批次三） |

## B2-T10 · 冻结导出 + 收官门禁

| 项 | 内容 |
|---|---|
| 落点 | `src/services/l3-sheet-export.service.ts`（新）、`sheets.ts` 加 `GET /:id/export`（Content-Disposition） |
| 要点 | Markdown 冻结档案：文章 + 题面 + 答案（attempts）+ 草稿注记（锚点 `==高亮==`）+ 评审 + 统计；`exportSchemaVersion` 起步 1；manifest 结构化日志留痕（ADR-0025 模式）；**只出不进**（无导入）；owner-only |
| 收官 | 全量门禁：typecheck / arch:check / test:unit / frontend:build / complexity:routes / api:client:check / db:schema:drift / rls:acceptance:test:l3 |
| 验收 | 导出产物 agent 可读（Markdown）；openapi 再生 + currentSha256 重钉；交付摘要（每任务一行 + 门禁输出 + 冒烟路径） |

---

## 增补批（T11–T14，设计卡 v2 · 2026-09-17 同学裁决）

前置：T1–T10 已交付；ADR-0034 已存在——T11 含 **ADR-0034 修订**（追加设计卡 v2 增补必钉 7–12 条款，不动已实施部分）。

### B2-T11 · 旗标契约 + 注记 stage 守卫与撤回

| 项 | 内容 |
|---|---|
| 落点 | `src/domain/l3-sheets.ts`（answers 契约）、`src/domain/l3-annotations.ts`（stage 谓词）、`l3-annotations.service.ts`、`routes/l3/annotations.ts`（撤回端点）、`l3-sheets.service.ts`（seal 物化扩展）；ADR-0034 修订同提交 |
| answers 契约 | `sheetAnswerSchema` strict 显式键 `{choice?, flags?: {doubt?, recheck?}, optionFlags?: string[], marks?: [{scope:'passage'\|'stem', start, end}]}`；PATCH 仍纯 optional 无 default；marks 同 scope+start+end 去重 |
| stage 守卫 | 注记 PATCH：draft 可编辑；**submitted → 409**（提示走撤回）；confirmed owner 可编辑（`review` 段只读） |
| 撤回端点 | `POST /api/l3/annotations/:id/withdraw`：入参 `{sheetId}`（当前上下文题纸，无则幂等开纸），submitted→draft + 重挂该题纸，下次定格随新题纸重新升格；operations 注册 owner/owner |
| seal 扩展 | full 档物化 `self_assessment = {flags, optionFlags, marks}`（当场主观状态快照）；软确认加"N 题待复查"计数 |
| 前端 | 题卡头部旗钮（待复查）+ 存疑钮；选项行尾悬停存疑钮；定格确认 modal 加待复查计数 |
| 验收 | domain/http 用例（409 语义/撤回重挂/物化形状/去重）；api:governance 六步 |

### B2-T12 · 内容标记 marks（零迁移）

| 项 | 内容 |
|---|---|
| 落点 | `L3ExamPaper.tsx`（文栏第三分支 + 题干划词）、`examPassageSpans.ts`（marks 通道）、sealed 结果页还原 |
| 交互 | 文栏浮动条加「标记重点」分支（与建原文分析/圈词并列，走题号选择器）；题干区划词捕获 `scope='stem'`（题号天然已知，跳过选择器）；点已有高亮 → 取消标记 |
| 渲染 | 纯底色高亮，无角标无徽标无 cursor-pointer（划词铁律）；不进覆盖度视图；sealed 结果页从 `self_assessment.marks` 还原 |
| 验收 | 组件测试（划选/去重/取消/还原）；分片纯函数 marks 通道用例 |

### B2-T13 · 评析区（迁移 0035 + agent 首个写端点）

| 项 | 内容 |
|---|---|
| 落点 | 迁移 0035 `l3_question_assessments`、`src/domain/l3-assessments.ts`（新）、repository/service/route（新文件直挂 server.ts + 棘轮登记）、operations.ts |
| 表 | `(user_id, question_id)` UNIQUE；`question_id` FK→l3_questions CASCADE；`content_md`（≤20k）；`last_editor CHECK('owner','agent')`；RLS own_all 单条 FOR ALL；vocab_app 四权双落点；迁移计数断言 35→36 |
| 端点 | `GET /api/l3/questions/:id/assessment`（无则空态）；`PUT` upsert `{contentMd}`，`last_editor` 按 actor 身份；归属 404 语义 |
| 权限登记 | owner 读写 + **agent 读写（首个 agent 写端点，ADR-0029 修订同提交）**；注记内容、attempts 不可写红线不变 |
| 前端 | 题卡「评析」子区：textarea 编辑 + 只读预览切换（不引 Markdown 编辑器依赖）；挂题不挂题纸 |
| 验收 | RLS 集成追加（actor B 不可读/越权写空转）；service 用例（upsert 幂等/last_editor 覆写） |

### B2-T14 · 导出 v2 收官

| 项 | 内容 |
|---|---|
| 落点 | `l3-sheet-export.service.ts`（v2 模板）、路由（状态分流 + withAnswers）、前端题纸栏「导出」弹层 |
| 模板 v2 | 页眉（`exportSchemaVersion=2` + sha256 + 状态/时间线）→ 原文（marks `==高亮==` + 注记锚点编号）→ 题面 → 作答与痕迹（choice/flags/marks/自评）→ 注记清单（stage+review）→ **评析段** → 统计（sealed）→ 尾部 ` ```json ` 全量块 |
| 分流 | draft：answers 实时读，默认 withAnswers=0，页眉"草稿快照+导出时刻"；sealed：attempts 派生，默认 1；discarded → 409 |
| 前端 | 导出按钮 + 选项弹层（withAnswers 开关）+ 复制全文（吸收 V3-T6 极简形态） |
| 验收 | 三状态导出用例 + sha256 稳定 + json 块可解析 + 中文文案；全门禁收官 |

### 增补批验收主线（收官手工走一遍）

1. 做题中划题干关键词 + 原文重点 → 防抖保存 → 刷新还原；
2. 题卡打「待复查」+ 选项「存疑」→ 定格软确认出现计数 → full 档定格 → sealed 结果页 marks/flags 还原；
3. 注记 submitted 后 PATCH → 409；撤回 → 变 draft 重挂新题纸 → 下次定格重新 submitted；
4. 评析区：owner 写一条 → agent 身份 PUT 覆写 → `last_editor='agent'` 留痕；
5. draft 中途导出（默认不含答案）→ 模拟粘贴外部 agent；sealed 导出（含答案+评析）→ 尾部 json 块可解析。

---

## 端到端验收主线（收官手工走一遍）

1. **file venue**：打开 Text 1 → 题纸自动开（draft）→ 作答防抖保存 → 划线建草稿注记（虚线样式）→ 定格「完整记录」→ attempts 物化 + 注记升 submitted → 题卡徽标「做过 1 次」→ modal 预览历史 → 删一条 attempt → 题历史消失 / 结果页占位 / 统计不变。
2. **paper venue**：整卷作答 → 交卷软确认（未答题计数）→ sealed → 卷级统计 + 逐题明细派生渲染；sealed 后 PATCH → 409。
3. **竞态**：双标签同刷一卷 merge 不互踩；sealed 竞态写空转。
4. **隔离**：RLS 集成用例（T6）全绿。
5. **导出**：sealed 题纸导出 Markdown，锚点高亮与统计齐全。

## 冒烟环境（交付摘要附）

- 后端 `npm run dev`（3000）；前端 `npm run frontend:dev`（5173，最新代码）；dev 库已迁移 0034 后生效。
- Token：`local-owner-api-token-only-0001`；路径：题型空间选文件 / 我的试卷开卷。
