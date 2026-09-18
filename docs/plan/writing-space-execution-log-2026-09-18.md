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

#### W2 · 写作任务、查找、分页与归档（2026-09-18 完成，`ba26a82`）

- 交付：`l3-writing.repository.ts`（任务域原语 + `lockTask`/`lockQuestion` 事务锁）+ `l3-writing-task.service.ts`（create 幂等/复用/内部题/首 draft/`draft=null` 复用语义；list keyset；rename/archive/restore）+ 单测 27/27。
- paper 面：`deleteQuestion` 增写作任务 409 blocker（owner 域，不泄露）；`listPracticeFiles` 双条件排除内部写作题（`file_key='writing:%'` **且** 存在任务关联行）。
- 偏离记录（已复核接受）：`interfaces.ts` 加 `IL3PaperRepository.listWritingTaskRefs`（加性 5 行，编译必需）；`tests/services/l3-paper.test.ts` 补 fake + 1 护栏用例。
- 独立复核：27+15+17 测试复跑全绿；typecheck 0 错。

#### W4 · 可靠保存控制器（2026-09-18 完成，`3d759e1`）

- 交付：`writingSaveController.ts`（单在途/输入序号/flush waiter/800ms 防抖/IME/1-2-4 退避/401·409·400·422 不重试/超时 load 恢复/dispose）+ `useWritingDraft.ts`（composition + beforeunload + 站内导航守卫）+ 单测 17/17。
- 独立复核：复跑 17/17；无 localStorage/IndexedDB；hook 签名已备 W7。

#### W5 · 定位反馈与 agent 边界（2026-09-18 完成，`<W5-SHA>`）

- 交付：`l3-writing-feedback.repository.ts`（一稿一条行锁/首写/版本 CAS）+ `l3-writing-feedback.service.ts`（getContext / getFeedback / putFeedback：task→sheet 锁序、hash 绑定校验、UTF-16 锚点逐字校验、64KiB 体积守卫、requestId 幂等重放不升版、expectedVersion 版本 CAS、last_editor 由 Principal 注入）+ 上下文/读取 DTO（domain 冻结层扩展）。
- generic 封堵：grading `getGradingContext`/`getGradingResults`/`submitGrading` 对 writing 稿一律 409 `WRITING_ENDPOINT_REQUIRED`（防两套反馈真源）。
- 验证：repo 5 + service 11 + grading 回归 16（含 3 守卫用例）；**并发集成 7/7**（新增「两 writer 相同 expectedVersion 只有一个成功 + 重放不升版 + 版本冲突 409」）；宽回归 175/175；typecheck 0 错。
- 待办：`toFeedbackRecord` 的 feedback 形状未做运行时收口（写入侧已由 zod 校验；读取侧信任库内数据，W6 响应契约再做输出校验）。

#### W3 · 稿件生命周期（2026-09-18 完成，`09a44f0`）

- 交付：`l3-writing-text.ts`（sha256 工具）+ `l3-writing-sheet.service.ts`（saveDraft CAS / submit 单事务物化+幂等重放 / createDraft copy·复用·409 / discard / getSheet 三态 / listRevisions feedbackState 派生）+ repo 11 个 sheet 域方法（`lockSheet`/`casSaveDraft`/`sealWritingSheet`/`discardWritingDraft`/`findMaxRevisionNo`/`listRevisions` 等）。
- 旁路封堵：通用 `patchAnswers` 加 `scope IN ('file','paper')`；通用 `patchSheet`/`sealSheet` 对 writing 稿 409 `WRITING_ENDPOINT_REQUIRED`；通用 `softDeleteAttempt` 加 `venue <> 'writing'`（写作正文清理走 W9 专用事务）；`listArchive` 限 file/paper。
- 作用域解析器：writing → 任务关联题只读解析（经 `findWritingTaskQuestionId` 只读助手，不触发创建）。
- 单测 21/21（CAS 冲突不覆盖 / 提交幂等同 attempt / 稿号 max+1 / 父稿 copy·复用·409 / 终态守卫 / GET 零写）；**并发集成 6/6（真实 PG 两连接屏障——slow-query 日志实证 FOR UPDATE 阻塞 207ms/217ms 至屏障提交）**；回归 250/250；typecheck 0 错。
- 过程修复：① 任务服务构造缺默认工厂（单测显式注入未暴露；集成构造即炸）→ 补 `defaultWritingReposFactory` 默认参数；② 导出 `toSheetDto`/`encodeCursor`/`decodeCursor` 供 W3/W6 复用（单一真源）。
- 说明：W3 实施者（外派）曾因推理配额 429 中断（无提交、无锁残留），主理人接手完成（残留 hash 工具与接口声明复核后留用）。

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
| 2026-09-18 | W2 独立复核：4 文件复跑 | 0 | 59/59（W4 17 + W2 27 + paper 15）；typecheck 0 |
| 2026-09-18 | W3 单测 + 回归（11 文件） | 0 | 250/250 |
| 2026-09-18 | W3 并发集成（vocab_writing_test 两连接屏障） | 0 | 6/6（D1/D2 屏障 slow-query 实证） |
| 2026-09-18 | W5 单测 + grading 回归 | 0 | 32/32（repo 5 + service 11 + grading 16 含 3 守卫） |
| 2026-09-18 | W5 并发集成（反馈） | 0 | 7/7（两 writer 同版本单胜 + 重放不升版） |
| 2026-09-18 | 提交链 | — | `2b754a1` → `44ab3f3` → `da1317c` → `3d759e1`(W4) → `ba26a82`(W2) → `09a44f0`(W3) → `<W5-SHA>`(W5) |

## 3 · 遗留与待决策

-（滚动记录）
