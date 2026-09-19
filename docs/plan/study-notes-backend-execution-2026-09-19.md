# 学习笔记 N1 后端合同批次 · 执行台账（2026-09-19）

> 范围：Task 00–06（基线准备＋后端合同批次），**不开发前端产品界面**（Task 07–11 不在本批）。
> 纪律：本台账**不预填通过**——每项仅在真实命令/证据产生后更新；skip、未执行、超时和进程异常分别记录，
> 不得计为通过；未覆盖项集中列于 §8。

## 1. 基线与依赖（已实测核验）

| 项 | 值 |
|---|---|
| 功能分支 | `study-notes-n1-backend`（不含斜杠） |
| 工作区 | 独立 clone `D:/Temp/vocab-ob-n1`（从 GitHub 远端 clone；与旧共享仓库元数据解耦） |
| 实际 base | `b7dcea4e26b799b05a9b6312d9694908026c4e01`（`origin/integration/l3-reliability-writing`） |
| 依赖 PR | **#125**（state=OPEN、**draft**、未合并；mergeable=CLEAN）。本批按其做依赖 PR 处理 |
| 相邻 PR | #123（writing-practice-v1，draft）、#124（reliability-batch，draft）均未合并 |
| 三件套来源 | 交接分支 `local-closeout-2026-09-19@d1f032055cbec45f0e54985c766a292458a21dd5`；提取后 blob 校验：design=`4450386…`、exec-plan=`9ba91d7…`、start-prompt=`a209d5a…`（与交接提交字节一致） |
| 迁移起点 | 历史 `0000–0038` 已随整合应用（39 个）；本批新迁移号以实际 `db:generate` 结果为准（预期 0039） |
| 工具版本 | Node v22.22.2、npm 10.9.7（各自经 `--version` 实测）；PostgreSQL 17（容器 `vocab-local-pg`，127.0.0.1:5433） |
| 门禁比较基线 | `COVERAGE_BASE_REF` / `API_CONTRACT_BASE_REF` / `ROUTE_COMPLEXITY_BASE_REF` 取实际集成 base `b7dcea4e…`（**不得指向 HEAD**） |

### 1.1 旧工作区只读事实

- `wt-integration` HEAD=`b7dcea4e`（clean）；`wt-main` 在 `local-closeout-2026-09-19@d1f0320`（含 6 个未跟踪 tmp 文件，未动）。
- 本批未切换上述工作区分支、未修改其内容。

## 2. 测试环境与保护措施

| 项 | 值 |
|---|---|
| 专用验收库 | `vocab_study_notes_accept`（5433；`CREATE DATABASE … TEMPLATE vocab_e2e_origin` 克隆；39 迁移 + E2E 固定 fixture：owner `playwright-owner@vocab.test` 5 题 1 卷） |
| 隔离声明 | 与个人学习库 `vocab`、`vocab_practice_accept`、`vocab_practice_accept_restore`、`vocab_writing_test` 完全隔离；上述库全程未连接、未修改 |
| 受限 app 角色 | `vocab_app`（rolsuper=f、rolbypassrls=f，实测）；真实 RLS 证据以其连接产生 |
| fixture 纪律 | 专属 fixture owner（随机 UUID，见 `tests/helpers/study-notes-db.ts`）；清理限定本任务记录；不 truncate 业务表 |
| 凭据纪律 | 连接串/密码/token 不入库、不入台账、不进输出 |

## 3. Task 00：校准与台账

- [x] 三件套校准（执行校准批注：基线、F-1/作文状态、迁移编号、执行工作区路径）——本提交
- [x] 台账建立（本文件）
- [x] 起始门禁基线（`npm run typecheck` exit 0；`npm run arch:check` exit 0，391 模块 0 违规）
- 记录：三件套 diff 以"执行校准"批注方式修订，不改历史叙述、不扩大功能合同。

## 4. Task 01–06 记录（逐项）

> 状态口径：`待执行` → `进行中` → `完成（证据见下）`；任何绿必须是真实命令输出。

### Task 01 · domain 类型、输入与引用合同
- 状态：待执行
- 提交：—
- 证据：—

### Task 02 · 数据库、迁移与角色
- 状态：完成（证据见下）
- 提交：见 §7 提交链（本批第 3 提交）
- 迁移：`drizzle-release/0039_redundant_imperial_guard.sql`（`db:generate` 实际产出；编号未预占）
- 证据：
  - 迁移契约测试 `tests/scripts/l3-study-notes-migration.test.ts` 10/10 绿（发现式定位迁移；复合 FK/RESTRICT/RLS/CHECK/journal/schema 同步断言）
  - 专用库 `vocab_study_notes_accept`：迁移应用 39→40；`bootstrap-database-roles converge` ok；`verify-database-roles` `exactPrivileges:true`（含 5 新表逐项权限）
  - 集成测试 `tests/l3-study-notes.integration.test.ts` **17/17**（受限角色 RLS 读隔离/冒名拒绝；复合 owner FK ×3；CHECK 矩阵；五 kind 落库；删除保护含子题级联链截断与非误杀回归）；测试后 5 表 0 行残留（fixture 清理限定本任务 owner）
  - `npm run db:schema:drift` OK（新表 RLS 契约逐条比对）
  - 变异证明：drift 新契约检查移除 → `verify-schema-drift.test.ts` 1 failed；恢复 → 15/15
  - 权限快查：`vocab_backup` 对新表 SELECT=t（备份可见性）；`vocab_app` SELECT=t / DELETE=f（无硬删路径）

### Task 03 · 仓储与并发保存
- 状态：完成（证据见下）
- 提交：见 §7 提交链（本批第 4 提交）
- 新增：`src/repositories/l3-study-notes.repository.ts`、`l3-study-topics.repository.ts`、`l3-study-references.repository.ts`、`l3-study-cursor.ts`；接线 `interfaces.ts`/`factory.ts`
- 证据：
  - 单测 47/47（`tests/repositories/l3-study-{notes,topic,references,cursor}.test.ts`：SQL 形态/参数顺序/q 转义/keyset/requireTx/unnest 批插/jsonb_to_recordset）
  - 集成 21/21（新增并发与规模组：同版本并发一胜一冲突且**版本只推进一次**（pg_locks 绑定 c2 PID 观测到达路径，非 sleep）；capture FOR SHARE 期间源删除阻塞、提交后释放；121 笔记跨页无重复无遗漏（total=121 不随翻页变）；55 专题跨页 + 成员重排 0..n-1）
  - **真实 bug 修复（集成先行抓获）**：`list` 曾把游标参数并入 count 查询（"bind supplies 5 parameters but requires 3"）→ 修复为 count 先行 + 参数快照；单测补精确参数断言防回归
  - 相对原设计的必要调整：`studyTopics` 接口补 `insertMember`/`deleteMember`/`countMembers`（执行计划接口清单遗漏落入路径；`replaceMemberPositions` 仅覆盖"移动"）——已记录
- 契约细节：cursor=base64url(JSON{sortKind,lastSort,id,filter})，filter 为过滤指纹（16 hex sha256 截断）；backlinks 默认不含归档（repo 提供 `includeArchived` 开关，HTTP 层 N1 不暴露）

### Task 04 · 引用解析与删除保护
- 状态：完成（证据见下）
- 提交：见 §7 提交链（本批第 5 提交）
- 新增：`src/services/l3-study-reference.service.ts`（capture/resolve/preview；服务端快照与 hash 生成）
- 修改：`src/errors/index.ts`（`isForeignKeyViolation` 导出）、`l3-context.service.ts`（source 删除：study notes blocker + FK 兜底）、`l3-paper.service.ts`（question 删除：同款 advisory 锁 + blocker + FK 兜底）
- 证据：
  - 单测 12/12（五 kind 快照/hash 口径、quote 严格校验"只接受服务端原文"、他人目标 404、选项不存在 422、resolve current/changed/unavailable、preview 只读且零 lock/replace）
  - 既有面回归适配：`l3-context.test.ts`/`l3-paper.test.ts` 各 +1 守卫用例（study notes blocker 409 + 锁先行断言）→ 三文件 79/79
  - 集成 25/25（新增 4 用例：source/question 删除 409 可读 blocker（标题/引用数/归档笔记也算）且清引用后按原合同可删；**并发交错 A**：capture 持 FOR SHARE 插入未提交时删除阻塞（pg_locks 绑定 PID 观测），提交后删除触发 FK RESTRICT 23503，无悬空引用；**并发交错 B**：删除先行时引用插入 FK 阻止（23503），无悬空）
  - 相对原设计的调整：本轮不做 `L3Bookshelf.tsx` 前端提示（本批不含前端；blocker 已进 409 `meta.blockers.studyNotes` + `resolution` 提示位，UI 接入属前端批次）——见 §8
  - 边界说明：question 删除以 `pg_advisory_xact_lock(l3_question:<id>)` 与 capture 串行（l3_questions 无 UPDATE 授权不能行锁——实测 permission denied，沿 l3-writing 先例）；source 删除靠既有 FOR UPDATE 行锁 + FK 兜底，无需额外 advisory

### Task 05 · 笔记与专题 service 原子编排
- 状态：完成（证据见下）
- 提交：见 §7 提交链（本批第 6 提交）
- 新增：`src/services/l3-study-notes.service.ts`（create/list/get/save + createTopic/listTopics/saveTopic/moveTopicMember/removeTopicMember；规范化 hash、幂等三步、CAS、归属 blocker、引用 keep/capture、快照限额）
- 修改：`src/services/index.ts`（`studyNotes`/`studyReferences` 注册）、`src/services/l3-study-reference.service.ts`（补 `search`/`backlinks` 编排）、三个仓储补编排所需方法（`findByCreateRequestId`/`listVenues(ForNotes)`/`findReferenceOwners`/`bumpVersion`/`countMembersForTopics`；`replaceForNote` 增 `captured_at` 传参以保 keep 时间）、`src/errors/index.ts`（`isUniqueViolation`）
- 证据：
  - 单测 24/24（幂等重试不二次推进、同 requestId 异 payload 409、旧版本 409 仅 currentVersion、404 先于版本、marker 422、keep 保留原摘录与原 capturedAt、capture 先 lockTargets、被他笔记占用的引用 id 409、快照 >2MiB 422、成员锁序 topic→note、移动插位、空操作版本递增、500 上限、归档 409、cursor 指纹绑定）
  - 集成 31/31（全链：create→save（capture stem_quote）→get（current）→原文改写→changed 且旧摘录/旧 offset 原样；幂等与版本真库复验；专题成员真库（计数/跨题型/归档）；**归属↔成员不变量双向**；note 行锁互斥（pg_locks 绑定 PID）；search/backlinks 真库闭环）
  - 相对原设计的必要调整：执行计划接口清单未列 `findByCreateRequestId`/`bumpVersion` 等方法（幂等与成员操作必需）——已按设计 §6/§7 语义补齐并在 §8 记录
  - 锁序实现：moveTopicMember 取 `topic → note` 双锁（防「移除归属 vs 加入专题」竞态破坏成员不变量）；save 锁 note 后只普通读成员

### Task 06 · HTTP 与 API 治理
- 状态：完成（证据见下）
- 提交：见 §7 提交链（本批第 7 提交）
- 新增：`src/http/l3-study-note-response-contract.ts`；三薄路由 `src/http/routes/l3/study-notes.ts`（4 路由）、`study-topics.ts`（5 路由）、`study-references.ts`（3 路由）
- 修改：`src/http/server.ts`（references 组先挂——固定路径防吞）、`src/http/operations.ts`（12 操作全 owner-only）、`src/schemas/http/index.ts`（body re-export + 4 query 契约）、`scripts/verify-route-complexity.ts`（三新文件 bootstrap 限额）、`tests/http/authorization-registry.test.ts`（写面 7 + 读面 5 登记）、domain/服务（search/backlinks DTO camelCase 映射、preview `{preview}` 包装）
- 证据：
  - HTTP 测试 `tests/http/l3-study-notes.test.ts` 10/10 + 响应合同 8/8；**全量 HTTP 组 521/521**（注册表驱动的 401/403/CSRF 全量行自动覆盖新 12 端点）
  - OpenAPI：8 路径 / 12 操作登记；`api:client:check` 通过；`api:contract` 10/10；`api:breaking`（base=b7dcea4e）"未发现 breaking change"
  - 路由复杂度：bootstrap 分支 + 默认分支双通过；**变异证明**（study-notes 限额 65→40 → `50 lines > 40 (bootstrap)` 红）
  - 既有删除端点（source/question）的 409/404 错误行为回归：service 单测 + 真库集成双层断言（HTTP 响应形状未变）
  - 固定路径优先：`/study-notes/reference-targets` 不被 `/:noteId` 捕获（HTTP 测试断言）
- 相对原设计的调整：本批**不交付**手写 `src/frontend/api/studyNotesClient.ts` 与其测试（属前端产品面，Task 07 范围；生成客户端 `src/frontend/api/generated/openapi.ts` 已同步）——见 §8

## 5. 验收矩阵（15 项，mock 与真实 PG 分别留证）

| # | 场景 | mock | 真实PG | 证据 |
|---|---|---|---|---|
| 1 | 两 owner 互不可读写；受限角色 RLS 生效 | — | — | — |
| 2 | agent 无法使用新读写端点 | — | — | — |
| 3 | 同版本并发保存一胜一冲突 | — | — | — |
| 4 | 成功落库丢响应后重试不重复写 | — | — | — |
| 5 | 同 requestId 不同载荷被拒 | — | — | — |
| 6 | 引用校验失败时正文/归属/引用整体回滚 | — | — | — |
| 7 | marker 不一致/重复 ID/非法字段/越界被拒 | — | — | — |
| 8 | emoji/非 ASCII UTF-16 锚点正确 | — | — | — |
| 9 | 原文变化 → changed、旧摘录保留、不误重定位 | — | — | — |
| 10 | 被引用题目/来源（含子题）删除被阻止 | — | — | — |
| 11 | 引用创建与源删除并发不产生悬空 | — | — | — |
| 12 | 专题排序/成员/题型约束/版本冲突 | — | — | — |
| 13 | 121+121+55 跨页完整访问 | — | — | — |
| 14 | GET/预览/搜索/反向引用零写 | — | — | — |
| 15 | 未被引用对象删除仍按原合同 | — | — | — |

> 并发窗口以 deferred 屏障/可观测数据库屏障构造；pg_locks 观察须绑定被测连接 PID 与阻塞事务；
> 不以固定 sleep 宣称覆盖并发窗口。

## 6. 工程门禁（本批适用）

| 门禁 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| typecheck | `npm run typecheck` | — | 待执行 |
| arch | `npm run arch:check` | — | 待执行 |
| 单测（全量） | `npx vitest run --coverage --maxWorkers=1` | — | 待执行 |
| 分层覆盖 | `npm run coverage:layered` | — | 待执行 |
| 测试收集 | `npm run test:collection` | — | 待执行 |
| schema drift | `npm run db:schema:drift` | — | 待执行 |
| API 治理 | `npm run api:governance` | — | 待执行 |
| 集成（专用库） | `vitest --config vitest.integration.config.ts …` | — | 待执行 |

## 7. 提交与 PR

| 项 | 值 |
|---|---|
| 提交链 | 待执行（逐任务提交，精确暂存） |
| 推送 | 待执行（不强推、不推 main） |
| PR | 待执行（base=`integration/l3-reliability-writing`，draft，注明依赖 #125） |

## 8. 未覆盖项与已知风险（实时更新）

- （初始）本批不覆盖：Task 07–11（前端编辑器/专题界面/侧栏/导出闭环/浏览器验收）；历史评卷、作文稿次、feedback 引用（N2）；agent 自动整理。
- 本机 Playwright 收尾间歇挂死为已知环境现象（前批已定性）；本批以组件/集成/HTTP 层与 CI 为准。
- HUSKY=0 沿前批临时隔离（钩子根因未定论）；等价检查（typecheck/测试）均照常执行。

## 9. 下一步消费者信息（Task 07–08 可消费）

- DTO、错误码、保存/幂等语义：见 `src/domain/l3-study-notes.ts` 与 OpenAPI 生成物（完成后补写精确引用）。
- fixture 位置：`tests/helpers/study-notes.ts`（纯 fixture）、`tests/helpers/study-notes-db.ts`（DB fixture）。
