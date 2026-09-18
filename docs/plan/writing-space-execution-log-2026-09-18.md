# 作文子空间 v1 · 执行日志（2026-09-18 起）

> 滚动更新。每个任务按「失败测试 → 最小实现 → 定向验证 → review → 提交」闭环；证据（命令 + exit code + 产物路径）按任务记入。
> 设计真源：`writing-space-design-2026-09-18.md`（S）；任务真源：`writing-space-execution-plan-2026-09-18.md`（W0–W11）；契约冻结件：`docs/adr/writing-workspace.md`。

## 0 · 基线与环境（W0 记录）

### 接入基线

- `main@f03ffe3`（PR #121 合并：F-1 回看闭环 + 0037 `review_sheet_id` + 批次三①/小治批次均已入）；复核 `git rev-parse HEAD` = `git ls-remote origin refs/heads/main` = `f03ffe35…`（本地=远程）。
- 计划文档入库提交：`2b754a1`（三份 writing-space 计划 + README 精确 3 行索引；study-notes 条目/临时脚本未夹带）。
- 隔离 worktree：`D:\Temp\Myawesomeapp\vocab-ob'\wt-writing`（本地分支 `writing-v1`，父仓 `wt-main`）。
  - 沙箱说明：嵌套本地分支名（`feat/…`）在本环境不可落盘（已实证）→ 本地用扁平名 `writing-v1`；推送时以 `<sha>:refs/heads/feat/writing-space-v1` 创建远程分支（先例 PR #119/#120/#121）。
  - `node_modules` 以目录 junction 指向 `wt-main/node_modules`（未重装依赖）；worktree 内 vitest 冒烟通过（`tests/domain/l3-grading.test.ts` 10/10）。

### 运行时与地址（不含凭据）

| 项 | 值 |
|---|---|
| Node / npm | v22.22.2 / 10.9.7（符合 engines `>=22.22 <23` / `>=10.9 <11`） |
| dev PG | 127.0.0.1:5433（容器 `vocab-local-pg`；journal 38 条，尾部 `0037_strong_boomerang`） |
| RLS 验收栈 PG | 127.0.0.1:55433 |
| 独立写作测试库 | `vocab_writing_test`（127.0.0.1:5433 同实例独立库；W1 建立、迁移、写 RLS 证据） |
| 后端 / 前端 dev | 127.0.0.1:3000 / 127.0.0.1:5173（本线不改动） |

### 并行边界与协调（study-notes）

- study-notes 计划（Task00–11）与本线同改 `schema / operations / L3Page / baseline.md`；双方均声明「共享集成点单写者」。
- 本线纪律：`schema.ts / journal / snapshot / 角色脚本` 由 W1 单写；`operations.ts / server.ts / 生成 client` 由 W6 单写；`L3Page.tsx` 由 W7 单写。**迁移号不预占**：0037 已释放，0038 号在 W1 实际生成时按 journal 分配并记录于此。
- 提交纪律：逐文件点名暂存；绝不夹带 study-notes/临时脚本；`git add -A` 禁用。

### 接口冲突初核清单（W0；W1/W6 复核后回填）

- [ ] `sheetAnswerSchema`（strict，无 text）→ 必须新建 `writingDraftInputSchema`（不改旧 schema 语义）——W1。
- [ ] `openSheet` 输入**不**扩展 writing（新稿只由专用 POST 创建）——W3/W6。
- [ ] 响应契约 scope/venue union 增 `writing`；旧 open schema 不得自动接受 writing——W1/W6。
- [ ] 档案 `listArchive` SQL 显式限定 file/paper——W9（或 W1 视迁移而定）。
- [ ] 复合 FK 目标唯一性核对：`questions(id,user_id)` / `submissions(id,user_id)` 需存在 UNIQUE（019/0034 是否已建）——W1。
- [ ] 迁移计数断言 38 → 39（以实际生成为准）——W1。
- [ ] `l3ShellViewModel` / `L3PapersPage` / `HomePage` 入口与深链（section=writing 优先、纯 ?sheet 分流）——W7。

## 1 · 任务执行记录

### W0 · 基线、共享依赖与 ADR（2026-09-18）

- [x] 读三份权威材料 + CONTEXT.md + ADR-0023/0029/0030/0034/0035 要点 + 设计基线；AGENTS.md 全仓不存在（记录并跳过）。
- [x] git 复核（log/status/worktree list）；不读取/打印 .env 与 token。
- [x] 三份计划点名提交 `2b754a1`（README 用 blob 法精确暂存 3 行，study-notes 行保留未暂存）。
- [x] 隔离 worktree 建立并验证：三文档可读、0037 在迁移链、工作区干净。
- [x] 创建 `docs/adr/writing-workspace.md`（writing scope / 正文真源 / 反馈唯一性 / 提交即限定授权 / GET 只读 / 归档与删除策略 / F-1 兼容 URL 契约）。
- [x] `baseline.md` 增补 W1–W5 体验锚点。
- [x] 本日志建立。
- 提交：`docs: define writing workspace contracts`（待提交 → 见下）。

### W1 · Domain、DTO 与数据库增量（进行中）

- [ ] 失败测试（normalize/anchor/长度边界）先红后绿。
- [ ] schema 四列 + 两表 + 索引 + 复合 FK + CHECK；迁移生成（实际号：待定，不预占）。
- [ ] 角色 converge/verifier + 迁移计数断言。
- [ ] 独立库迁移 + RLS 真实证据（`vocab_writing_test`）。
- [ ] 提交：`feat(db): add writing task and feedback contracts`。

### W2–W11

-（按依赖推进，逐节回填）

## 2 · 门禁与证据台账

| 时间 | 命令 | exit code | 证据/产物 |
|---|---|---|---|
| 2026-09-18 | worktree 冒烟 `npx vitest run tests/domain/l3-grading.test.ts` | 0 | 10/10 passed（1.0s） |
| — | — | — | — |

## 3 · 遗留与待决策

-（滚动记录）
