# 作文与试卷台整合修复 · 执行日志（2026-09-18）

> 基线提交锚：`ccc6fb4c90f45c6e13f0d581298bb617a79baac2`（作文 v1 合并基座；执行前已实测本地=远程 main）。
> 实施位置：worktree `D:/Temp/Myawesomeapp/vocab-ob'/wt-practice`，分支 `writing-practice-v1`。

## I0 · 现场与行为基线（完成，`e74e749`）

### 基座与隔离
- 执行前核对：本地 `main` = 远程 `main` = `ccc6fb4c`（`git ls-remote` 实测，未假定未推进）。
- 隔离 worktree 自 `ccc6fb4c` 签出；`node_modules` 走 junction → wt-main（vitest/typecheck 可用）。
- **携入**：`writing-practice-integration-repair-2026-09-18.md`、`writing-practice-integration-start-prompt-2026-09-18.md`（逐文件确认，mv 入 worktree）。
- **未携（原位保留）**：`docs/plan/README.md`（他线改动）、study-notes 三文档、`scripts/tmp-*` 六件——wt-main 工作区零触碰。

### 文件所有权（单集成者串行；本轮不派其他执行者改共享面）
- 共享集成文件（我，独占串行）：`src/frontend/pages/L3Page.tsx`、`src/frontend/components/l3/L3PapersPage.tsx`、`src/frontend/components/l3/L3ExamPaper.tsx`、`src/http/operations.ts`、`src/schemas/http/index.ts`、`scripts/verify-route-complexity.ts`、`docs/api/openapi*` 与生成物。
- 服务端链路：`src/domain/l3-writing.ts`、`src/repositories/l3-writing.repository.ts`、`src/services/l3-writing-task.service.ts`、`src/http/routes/l3/writing-tasks.ts`、`src/http/l3-writing-response-contract.ts`。
- 前端新增/扩展：新增 `src/frontend/components/writing/WritingQuestionEntry.tsx`；扩展 `src/frontend/viewModels/writingNavigation.ts`；`src/frontend/api/writingClient.ts`（加读面方法）。
- 保护对象：`wt-writing`（作文 v1 交付 worktree）与 wt-main 他线产物只读。

### 专用验收环境（与用户体验环境严格隔离）
- **库：`vocab_practice_accept`**（5433，`OWNER vocab_migration`）：全量迁移 **39/39**；converge ok；verifier **`exactPrivileges:true`**（全子项 true）。
- **端口：3100**（实测空闲，预留）——供本线开发/验收与最终体验地址。
- 🔴 只读隔离确认：**3099（PID 9348 运行中，用户体验中）**、**`vocab_writing_test`**、**3001/live 库**、5433 其余库——全程**只读、零触碰**（不停止/不重置/不清理/不跑破坏性 setup）。
- 合成数据计划：I5/e2e 前经 owner API 注入（小作文/大作文题 + 含作文题试卷，落本验收库）。

### 四入口分支现状（只读盘点，含行号）
| 分支 | 位置 | 现状 |
|---|---|---|
| fileKey 浏览（题型空间） | `L3PapersPage.tsx` browse 分支（L310 组装 / L362 传 `practiceEssayFor`） | ✅ 已有「在作文空间练习」→ `practiceEssay(questionId, direction)`（L318：createTask → 跳工作区） |
| source 文件（题型空间） | 同页 `kind:"sheet"`（L304）→ `<L3ExamPaper>`（L347） | ❌ 无作文入口 |
| 整卷草稿（我的试卷） | `<L3ExamPaper>`（L517 / L874 两处表面） | ❌ 无专项入口与「不计入本次试卷作答」标识 |
| 整卷回看（`?sheet=` / 题纸档案） | 回看模式（L218-233）、ArchiveTab（L716+） | ❌ 同上 |

- 补充事实：`L3ExamPaper` 内已有 essay 题**普通作答**输入（L1772 / L1806）——本轮**不合并**其与写作稿（保持独立作答语义），仅加/补专项入口。
- 复用语义依据：`createTask` 按 owner+question+kind+direction 复用活跃任务；无草稿时返回 `draft=null`、**不自动另建稿**（I3 入口矩阵的读面依赖）。

### 预期用户路径（验收主线，I5 真环境覆盖）
试卷台 → 题型空间（fileKey/source）或整卷（草稿/回看）→ 小作文/大作文题 → 入口操作（开始写作/继续写作/查看本稿/查看写作记录/重试）→ 作文专用工作区（来源条 + 返回原题 + 全部作文）→ 提交/反馈/第二稿 → **返回原题同题纸同位置** → 原题进度回显更新。一级「作文」= 汇总 + 自由练习（无来源不伪造来源）。

### 本轮提交计划（每项独立提交）
| 项 | 内容 | 提交信息（拟） |
|---|---|---|
| I0 | 本日志 + 两份计划 | `docs(plan): establish writing-practice integration baseline (I0)` |
| I1 | origin 解析/构造（版本化、严格 schema）+ F5/换稿/对照保留 + 返回工具；先红后绿 + 接入 | `feat(writing): carry origin context through workspace navigation` |
| I2 | 按题批量进度读面（GET question-summaries；owner-only；零写；1–100 去重）+ 全链同步与 governance | `feat(writing): add batch question progress summaries` |
| I3 | 共享入口组件 + fileKey/source/整卷草稿/整卷回看四分支接入 + 保存屏障核实 | `feat(writing): surface writing entries across paper surfaces` |
| I4 | 工作区来源闭环（来源条/返回原题/文案）+ 多卷同题用例 | `feat(writing): close the origin loop inside the writing workspace` |
| I5 | 真环境 e2e（writing-origin.spec）+ CI 计数接线 + 门禁 + draft PR + 体验地址 | `test(e2e): verify writing origin journeys` |

### 与用户体验环境的隔离承诺（全程）
- 不连接/不写 `vocab_writing_test`、不调用 3099 任何写接口、不动 3001/live；
- 全部测试与 e2e 只使用 `vocab_practice_accept` + 端口 3100 + 合成数据（`practice:` 前缀标识）。

## A · 导航与进度契约（2026-09-19）

### A1 / I1 · 来源身份与精确返回（契约完成，`ed8d3bb`）

- **契约**（`src/frontend/viewModels/writingNavigation.ts`）：
  - `origin` 参数 v1：`base64url(JSON)` 单参数；判别联合 **file/paper**；file 需 `fileKey|sourceId` 至少其一；paper 需 `paperId`；`questionId` + 题型（short_essay/long_essay）；可选**进入时原 sheetId**；限长 1024、逐键白名单、UUID/枚举严格校验；非 base64url 字符（含 `http(s)://`、`javascript:`、`/`、`:`）直接拒绝。
  - `parseWritingSearch` 增 `origin` / `originInvalid`（非法仅降级来源提示，不破坏其余参数）；`buildWritingUrl` 可选携带 origin——**无 origin 时与旧 URL 完全一致**。
  - 返回原题：`buildWritingOriginReturnUrl` 生成 `/l3?venue|paper&question=<qid>[&file=<fileKey|sourceId>][&resumeSheet=<sid>]`（source 复用 `file=` 契约，见下方修正）；原 sheet 由消费方按 ID 读面（draft → 可编辑恢复 / sealed → 只读；**不经 openSheet**）。
- **关系校验读面分析（A1 决策）**：复用既有 owner 读即满足——`task.questionId`（getTask 已含）/ file 归属（`practice-files/detail` questions）/ paper 归属（`papers/:id` payload.sections）/ 原 sheet（`fetchSheet` by id）。**A1 无需新增服务端读面**。
- **验证**：`tests/frontend/writing-navigation.test.ts` **19/19**（旧 URL 兼容、四型往返、超长/字符/结构/UUID/外站拒绝、换稿与对照保留、多来源不同返回位置）；定向回归 **36/36**（含写作工作区与试卷台组件）；typecheck 0 错。
- 提交：`ed8d3bb`（导航契约 + 测试）。

#### A1 完成口径修正（2026-09-19 验收点 1–3）

- **A1 只计**：origin 编解码、返回 URL 构造、兼容性测试。**原 sheet 恢复 / 来源关系实际验证 / 页面换稿保留 origin 未计完成**——须在 B/C 实际接线并以页面级测试/真环境验证后才记。
- **source 返回参数决策（验收点 2：复用既有 `file=` 契约）**：builder 改为 `file=<fileKey ?? sourceId>` 单参数（不再输出 `source=`）；依据：`L3PapersPage.tsx`（A2 时点 L337-338）FilesTab 的 `file` 参数**本就同时匹配 `source_id` 与 `file_key`**。页面级测试须证明返回打开正确文件与题目（不得只断言 URL 含某字符串）。
- **关系验证义务（验收点 3：B/C 接线时实际执行）**：`task.questionId = origin.questionId`；question 属于指定文件/试卷；`resumeSheet` 的 scope（paper/source）、题型与来源一致；**同 owner 错误组合必须拒绝恢复且零新增题纸**。

### A2 / I2 · 按题批量只读摘要（完成，`b3c24a6`）

- **端点**：`GET /api/l3/writing/tasks/question-summaries?questionId=…&kind=whole|paragraph|free&direction=通用|考研|雅思`（owner-only 只读；新薄路由 `src/http/routes/l3/writing-summaries.ts`（35 行）先于 `writing-tasks.ts` 挂载；`operations.ts` 注册 `listL3WritingQuestionSummaries`，scope `none`）。
- **契约（strict）**：query `questionId: uuid[]`（原始 ≤100，去重后再查）；响应 `{ items: [{ questionId, tasks: WritingQuestionTaskSummary[] }] }`——逐题必返条目、无匹配=空数组；`taskId/taskStatus/draftSheetId/latestSubmittedSheetId/latestRevisionNo/revisionCount/feedbackState/contentStatus`（**draft 与最新 sealed 分开；feedbackState/contentStatus 仅指最新已提交稿**；清理后 `unavailable`，不转显旧反馈）；多匹配返回列表**不代挑**。生成物已同步（`docs/api/openapi.json` + `generated/openapi.ts`）。
- **repo 单条集合查询（防 JOIN 放大）**：`t.question_id = ANY($2::uuid[])` + LATERAL 三段（d：活跃草稿 ≤1 行；s：最新 sealed 按 revision_no/created_at/id DESC ≤1 行；rc：sealed+discarded 标量计数）+ `f.sheet_id = s.id`（反馈仅对应最新已提交稿，一稿一条）+ active attempt 标量（清理态）。**一稿一行。**
- **零写证据**：repo 测试断言**仅 1 次查询**且 SQL 文本 `not.toContain("INSERT")`/`"UPDATE"`；service 测试断言写方法零调用 + 任务计数不变；HTTP 测试断言校验失败**不触达服务**、静态路径不被 `/tasks/:taskId` 吞（缺参数 400）。跨 owner：repo owner 谓词（$1=userId）+ service owner 原样下传 + HTTP agent 403。
- **验证**：定向批次 **139/139**（7 文件：repo / service-task / service-sheet / http / client / navigation / authorization-registry；其中 A2 新增 repo 2、service 3、http 3、client 2）；typecheck **0**；`api:governance` **全绿**（openapi 含 `question-summaries`；client:check 匹配；contract 10/10；breaking OK（base=`ccc6fb4c`）；breaking:contract 31/31；复杂度棘轮通过）。注册表 owner 读名单 +1。
- **失败/多任务决策表（读面口径；前端处置于 B/C 实施）**：

| 场景 | 读面行为 | 前端处置（B/C） |
|---|---|---|
| 无匹配 | `tasks=[]` | 「开始写作」 |
| 唯一活跃草稿 | `draftSheetId≠null` | 「继续写作」→ 工作区 |
| 无草稿、有最新 sealed | `latestSubmittedSheetId≠null` | 「查看本稿」→ 只读 |
| 多活跃匹配 | tasks 全量返回 | 记录选择（不代挑） |
| 仅归档 | `taskStatus=archived` 透传 | 记录选择/归档标识 |
| 查询失败 | HTTP 非 200 | 客户端 INVALID_RESPONSE/错误态，**不归一空** |

- 提交：`b3c24a6`。**未声称用户闭环完成**——闭环在 B/C 接线后验证。
