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

### 接口冲突初核清单（W0；W1 回填）

- [x] `sheetAnswerSchema`（strict，无 text）→ 新建 `writingDraftInputSchema`（旧 schema 语义未动）——W1 完成。
- [x] `openSheet` 输入**不**扩展 writing：`SHEET_INTERACTIVE_SCOPES` 显式收窄 + 契约测试守卫——W1 完成（专用 POST 属 W3/W6）。
- [x] 响应契约 scope/venue union：`SHEET_SCOPES` 存储枚举含 writing 自动覆盖；open schema 已显式收窄——W1 完成。
- [ ] 档案 `listArchive` SQL 显式限定 file/paper——**排期 W3**（l3-sheets.repository 该轮统一动）。
- [x] 复合 FK 目标唯一性：`questions(id,user_id)`/`submissions(id,user_id)` UNIQUE 均已存在（0030/0034），复合 FK 直接可用——W1 验证。
- [x] 迁移计数断言 38 → **39**（0038 实际生成）——W1 完成。
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

### W1 · Domain、DTO 与数据库增量（2026-09-18 完成）

- [x] 失败测试先红后绿：`tests/domain/l3-writing.test.ts`（19 例：CRLF 归一保空格 / 空稿可存不可交判据 / 20001 拒 / 反馈 priority 重复拒 / 中文 emoji UTF-16 锚点 / 任务创建互斥与上限）。
- [x] `src/domain/l3-writing.ts` 冻结：枚举（kind/direction/seed/contentStatus/sheetStatus）、上限常量、`normalizeWritingText`/`hasWritingContent`/`countEnglishWords`/`validateFeedbackAnchors`/`collectFeedbackAnchors`、`writingFeedbackSchema`（S§5 逐字段 + strict）、`writingDraftInputSchema`（**专用文本契约，不复用 sheetAnswerSchema**）、`writingSubmitInputSchema`/`writingDraftCreateInputSchema`/`writingTaskCreateInputSchema`/`writingTaskRenameInputSchema`/`writingFeedbackPutInputSchema`、W1 输出 DTO 全量（单一真源）。
- [x] `src/domain/l3-sheets.ts` 扩展：`SHEET_SCOPES` 存储枚举加 `writing`；新增 `SHEET_INTERACTIVE_SCOPES`（file/paper）——通用开纸/落卷**不接受** writing；`buildSheetScopeKey` 增 writing 构造；契约测试同步（含拒绝守卫）。
- [x] `src/domain/index.ts`：writing 类型转发 + `L3SubmissionRow` 四元数据列；`src/repositories/l3-writing.types.ts` 两表行类型。
- [x] `src/db/schema.ts`：**迁移 0038**（journal 实际分配，tag `0038_empty_blink`）——两新表（l3_writing_tasks 引用式题面 + 幂等键；l3_writing_feedback 一稿一条）+ submissions 四列 + 三 CHECK（scope 形状/写作元数据/稿号语义）+ 双 RESTRICT 复合 FK + 稿号唯一；attempts venue 扩 writing + writing 专用部分唯一索引 `(sheet_id) WHERE venue='writing'`；RLS own_all 两表 + 既有表不变。
- [x] 库与角色：dev(5433/vocab) 与独立验收库 **`vocab_writing_test`**(5433) 双双 migrate 至 0038；converge 落授权（tasks 三权 / feedback 四权）；**verifier exactPrivileges=true（两库）**；`db:schema:drift` 两库 OK。
- [x] RLS 真实证据：`tests/writing-rls.integration.test.ts` **10/10**（A/B 读隔离与 UPDATE 空转、冒名 WITH CHECK 拒、伪造 question/task/sheet 关系复合 FK 拒、双 draft 唯一、同稿号唯一、一稿一 attempt、旧 file/paper 回归、CHECK 族、正向对照）。
- [x] `typecheck` 0 错误；`arch:check` 无违规（363 模块）；迁移计数断言 39（9/9）。
- [x] 说明：`src/db/relations.ts`/`src/db/types.ts` 无 l3 条目（l3 表从未建 drizzle relations 条目）——保持先例不新增。
- 提交：`feat(db): add writing task and feedback contracts`（下方 commit 记录）。

### W2–W11

-（按依赖推进，逐节回填）

## 2 · 门禁与证据台账

| 时间 | 命令 | exit code | 证据/产物 |
|---|---|---|---|
| 2026-09-18 | worktree 冒烟 `npx vitest run tests/domain/l3-grading.test.ts` | 0 | 10/10 passed（1.0s） |
| 2026-09-18 | `npx vitest run tests/domain/l3-writing.test.ts`（先红后绿） | 0 | 19/19 passed |
| 2026-09-18 | 定向批次（domain + 6 个 L3 契约文件） | 0 | 19 文件 / 368 tests passed |
| 2026-09-18 | RLS 集成 `tests/writing-rls.integration.test.ts`（vocab_writing_test） | 0 | 10/10 passed（281ms） |
| 2026-09-18 | `npm run typecheck` | 0 | 0 errors |
| 2026-09-18 | `npm run arch:check` | 0 | 363 模块无违规 |
| 2026-09-18 | `db:schema:drift`（dev + 测试库双跑） | 0 | OK ×2（RLS policy/契约一致） |
| 2026-09-18 | `vitest run tests/scripts/verify-existing-volume-role-upgrade.test.ts` | 0 | 9/9（计数 39） |
| 2026-09-18 | dev/测试库 converge + verifier | 0 | `exactPrivileges=true` ×2 |

## 3 · 遗留与待决策

-（滚动记录）
