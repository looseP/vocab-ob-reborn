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
