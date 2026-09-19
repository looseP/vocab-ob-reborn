# 学习笔记 N1 后端合同补修 F1–F5 · 执行台账（2026-09-19）

> 范围：仅修 F1–F5 及直接关联回归；Task 07–11、N2、前端、导出、数据迁移均不在本批。
> 纪律：本台账**不预填通过**——每项仅在真实命令/证据产生后更新；skip、未执行、超时与进程异常分别记录。
> 执行仓库：`D:/Temp/vocab-ob-n1`（分支 `study-notes-n1-backend`；单执行者串行）。

## 0. 基线与依赖（执行时实测）

| 项 | 值 | 状态 |
|---|---|---|
| 审查 HEAD（本批起点） | `555ae1884097c5f526530bd542988aee2e13f2a7` | ✅ 实测（clone `git rev-parse HEAD`） |
| 依赖 base | `integration/l3-reliability-writing@b7dcea4e26b799b05a9b6312d9694908026c4e01`（PR #125 draft/OPEN） | ✅ 实测（`git ls-remote` + `gh pr view 125`） |
| 本批 PR | #126（draft、base=integration/l3-reliability-writing、head=study-notes-n1-backend@555ae18） | ✅ 实测（`gh pr view 126`） |
| clone 占用核对 | 无锁文件、无 node 进程、status 干净（上批痕迹止于 21:47 提交） | ✅ |
| 基线 fsck | `git fsck --full --no-reflogs` exit 0 | ✅ |
| 验收库（本批新建） | `vocab_study_notes_repair_accept` @127.0.0.1:5433（owner=vocab_migration；journal=40；5 张 N1 表 RLS=on） | ✅ 实测 |
| 受限角色 | `vocab_app`（rolsuper=f、rolbypassrls=f；`exactPrivileges:true`） | ✅ 实测（verify-database-roles exit 0） |
| 基线目标测试（12 文件） | 249/249 通过，exit 0 | ✅ 2026-09-19 22:22 |

## 1. F5 · 统一 UUID 身份（先红后绿）

- 修改（已实施）：`src/domain/l3-study-notes.ts`（+`normalizeStudyUuid`）、`src/services/l3-study-notes.service.ts`、`src/services/l3-study-reference.service.ts`、`src/repositories/l3-study-references.repository.ts`
- 红测试：`npx vitest run tests/domain/l3-study-notes.test.ts tests/services/l3-study-notes.test.ts tests/services/l3-study-reference.test.ts tests/repositories/l3-study-references.test.ts tests/http/l3-study-notes.test.ts --coverage.enabled=false` → **16 failed / 123 passed，exit 1**（日志 `D:/tmp/n1r-f5-red.log`；失败均为目标缺陷：大写目标未命中 Map→404、成员误走重复 INSERT、锁键/幂等键未规范、`normalizeStudyUuid` 未导出）
- 绿测试：同命令 → **139 passed，exit 0**（`D:/tmp/n1r-f5-green.log`）
- 真库证据：`npx vitest run --config vitest.integration.config.ts tests/l3-study-notes-repair.integration.test.ts`（新库 `vocab_study_notes_repair_accept`）→ **2/2，exit 0**（`D:/tmp/n1r-f5-integration.log`）：大写 UUID preview/capture/keep 同一身份、引用落库规范小写、幂等重试不新建（计数=1）、成员移动只重排不新增（行数=2、顺序 [n2,n1]）
- 实现提交：`2fd6b2d05137773ae332ac819cabcbb56ee3ba91`（`fix(notes): normalize UUID identity at study-note boundaries (F5)`，11 文件；提交后 fsck exit 0）
- 设计决策：规范化落在服务入口 + 仓库锁键（不动 zod schema，避免 OpenAPI 生成物扰动）；HTTP 层以真实 service 接线验证路径/body；不得用于正文/quote/optionKey。

## 2. F1 · 创建幂等与删除事务恢复（先红后绿）

- 修改（已实施）：`src/repositories/l3-study-notes.repository.ts`、`l3-study-topics.repository.ts`（+`createIfAbsent`：`ON CONFLICT (user_id, create_request_id) DO NOTHING RETURNING *`）；`src/services/l3-study-notes.service.ts`（create/createTopic 改走冲突-忽略 + 新语句回读比对输入 hash，创建事务保持 READ COMMITTED）；`src/services/l3-context.service.ts`、`l3-paper.service.ts`（DELETE 前 `SAVEPOINT study_note_delete`；FK 失败先 ROLLBACK TO/RELEASE 再查 blockers；无匹配 blocker 保持原错误语义，不伪造笔记阻塞）
- 红测试（单元）：`npx vitest run tests/repositories/l3-study-notes.test.ts tests/repositories/l3-study-topic.test.ts tests/services/l3-study-notes.test.ts tests/services/l3-context.test.ts tests/services/l3-paper.test.ts` → **13 failed / 138 passed，exit 1**（`D:/tmp/n1r-f1-red-unit.log`）
- 红测试（删除路径·临时还原修复捕获后已恢复）：单测 4 failed（`D:/tmp/n1r-f1-red-delete-unit.log`，失败原因均为 `current transaction is aborted`（25P02））；真库 2 failed（`D:/tmp/n1r-f1-red-delete-integration2.log`，两则删除交错均以 25P02 而非 ConflictError 失败）
- 红测试（真实 PG 首轮）：集成 **5 failed / 5 passed**（`D:/tmp/n1r-f1-red-integration.log`；含多条真实 25P02 证据）
- 绿测试：单元 **151/151 exit 0**（`D:/tmp/n1r-f1-green-unit.log`）；真库 **10/10 exit 0**（`D:/tmp/n1r-f1-green-integration.log`）；typecheck exit 0
- 真库交错证据：①来源删除——预检查（未提交引用不可见）后 DELETE 阻塞（transactionid 等待可观测）→ 引用提交 → FK RESTRICT → savepoint 恢复 → **409 含真实 blockers**，S/Q/引用完整；②题目删除 FK 后备（事务级故障测试，与自然串行测试分列记账）；③反向交错——删除先行时引用插入被 FK 阻止（实际错误码 23503），无悬空引用；④advisory 锁键大小写归一后 capture×删除串行（阻塞窗口可观测）。
- 实现提交：`bd8ce8ee0a0baaeada677a4754749701b85f4522`（`fix(notes): recover failed-transaction paths for create and delete (F1)`，12 文件；提交后 fsck exit 0）
- 备注：预检查注释已按实际查询修正（**计入子题引用**）；「无匹配 blocker 不伪造笔记阻塞」边界双端（context/paper）留证。

## 3. F2 · 详情一致快照（先红后绿）

- 修改（已实施）：`src/db/transaction.ts`（`TransactionOptions.readSnapshot` → `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`；默认仍为普通 BEGIN）；`src/services/l3-study-notes.service.ts`（`get()` 启用 readSnapshot；幂等复用两路径——已存在与冲突回读——先 `lock` 行再组装 DTO；createTopic 复用同样先锁行）
- 红测试（单元）：`npx vitest run tests/db/transaction.test.ts tests/services/l3-study-notes.test.ts` → **5 failed / 48 passed，exit 1**（`D:/tmp/n1r-f2-red-unit.log`：BEGIN 文本不符、未传 readSnapshot、复用未锁行）
- 红测试（真库）：F2 交错 → **1 failed / 1 passed**（`D:/tmp/n1r-f2-red-integration.log`；实证"旧正文拼新引用"：marker 集合 [1] ≠ 引用集合 [2]）
- 绿测试：单元 **53/53 exit 0**（`D:/tmp/n1r-f2-green-unit.log`）；真库 **12/12 exit 0**（`D:/tmp/n1r-f2-green-integration.log`）
- 真库交错证据：GET 读出 note 行后（实际仓储 SQL 后的可观测屏障）另一连接提交 v2（新正文/新引用/新归属）→ 响应完整属于旧版（version=2 全集）或新版（version=3 全集），marker 与引用集合一致；GET 零写（5 表计数不变）、跨 owner 404、重开读取一致、连接归还后普通写事务仍可写
- 实现提交：`536b5fcb2eb1c1c5045844d08a3319a2f12166d7`（`fix(notes): serve note details from one consistent snapshot (F2)`，6 文件；提交后 fsck exit 0）
- 备注：readSnapshot 仅供只读详情使用（写路径不启用）；冲突回读加锁不影响 F1 的输入 hash 比对语义。

## 4. F3 · 题目 active 规则（先红后绿）

- 修改（已实施）：`src/repositories/l3-study-references.repository.ts`（searchTargets question 分支与 loadTargets question 分支收敛 `status = 'active'`；模块注释同步）；`docs/plan/study-notes-design-2026-09-18.md` §3（题目可用性与 unavailable 消费说明同步）
- 红测试（单元）：`npx vitest run tests/repositories/l3-study-references.test.ts` → **2 failed / 14 passed，exit 1**（`D:/tmp/n1r-f3-red-unit.log`：两处 SQL 均无 active 条件）
- 红测试（真库）：F3 矩阵 → **2 failed**（`D:/tmp/n1r-f3-red-integration.log`：搜索含非 active、preview/capture 未收口）
- 绿测试：单元 **16/16 exit 0**；真库 **14/14 exit 0**（`D:/tmp/n1r-f3-green-unit.log`、`D:/tmp/n1r-f3-green-integration.log`）
- 真库矩阵证据：同 owner active/pending/rejected × question/stem_quote/option_quote；搜索只回 active（total=items 条件）、pending/rejected 预览 404、跨 owner 404；rejected capture 失败后正文/version/归属/引用整体不变；active→rejected 后 GET unavailable 保留旧摘录/capturedAt、keep 可保存、重新 capture 404、移除可行
- 实现提交：`80b5bcd1c3ae127fca3cecb941183caeefc931ec`（`fix(notes): restrict question reference targets to active status (F3)`，5 文件；提交后 fsck exit 0）
- 备注：状态更新路径——l3_questions 对 vocab_app 无 UPDATE 授权（grants 实测），测试经 admin（vocab_migration）直改 status 作为实际状态入口；本批不改全项目状态机制。

## 5. F4 · 引用搜索游标绑定过滤（先红后绿）

- 修改（已实施）：`src/repositories/l3-study-cursor.ts`（新增 `createdAt` 游标族；decode 校验 ISO 时间）；`src/services/l3-study-reference.service.ts`（search 指纹绑定 `["reference-targets", kind, 规范化q, 有效venue]`；改走 study 游标族；移除 l3-cursor 依赖）
- 红测试（单元）：`npx vitest run tests/repositories/l3-study-cursor.test.ts tests/services/l3-study-reference.test.ts` → **4 failed / 37 passed，exit 1**（`D:/tmp/n1r-f4-red-unit.log`：createdAt 族缺、旧格式游标被接受、换条件复用未被拒）
- 红测试（真库）：F4 → **1 failed**（`D:/tmp/n1r-f4-red-integration.log`：换 kind 复用旧游标被接受并执行——正是审查探针复现的缺陷）
- 绿测试：单元 **41/41 exit 0**；真库 **15/15 exit 0**；typecheck exit 0（`D:/tmp/n1r-f4-green-unit.log`、`D:/tmp/n1r-f4-green-integration.log`）
- 真库分页证据：57 目标（55+2）全同时间戳、limit=20 跨页消费游标——无遗漏/无重复（Set=57）、total 恒定 57 不随 cursor 变；换 kind/venue 复用 400、旧格式游标 400；q 首尾空白归一化一致；`100%`/`under_score`/`_` 字面量搜索（转义生效）
- 实现提交：`b7ea6afe4e73c016f382055277b07a6b74eb1dca`（`fix(notes): bind reference search cursors to their filters (F4)`，6 文件；提交后 fsck exit 0）
- 备注：limit 不参与指纹；source 忽略无效 venue（不制造虚假差异）；其他列表（updatedAt/position 族）的调用点继续拒绝 createdAt 游标。

## 6. 最终验收（已完成，2026-09-19）

### 6.1 回归与真库证据
- 定向回归（计划规定 12 文件）：**286/286 passed，exit 0**（`D:/tmp/n1r-final-targeted.log`；基线 249 → 本批 +37）
- 集成（既有 + 新增，同库 `vocab_study_notes_repair_accept`）：**49/49 passed，exit 0**（既有 34 + 新增 15；`D:/tmp/n1r-final-integration.log`）
- RLS 验收链：`npm run rls:acceptance:verify` → **exit 0**（prepare / migrate 40 条目 / converge / docker bootstrap / `transaction-rls` 5/5 / `l3-rls` 24/24；`D:/tmp/n1r-final-rls.log`）

### 6.2 工程门禁（base=b7dcea4e；`verify:engineering` 等值分步）

| 步骤 | 命令 | 退出码/结果 | 日志 |
|---|---|---|---|
| typecheck | `npm run typecheck` | 0 | n1r-final-engineering.log |
| arch | `npm run arch:check` | 0（402 模块 0 违规） | 同上 |
| 全量单测 + 覆盖率 | `vitest run --coverage` | **3601 passed / 6 skipped；产物完整（coverage-final.json 2.4MB、summary）；runner 收尾挂死（环境现象，含去 html + 直启二进制共 3 次复现）→ 不记 exit 0** | n1r-final-engineering.log / n1r-coverage-rerun3.log |
| 分层覆盖率 | `npm run coverage:layered`（COVERAGE_BASE_REF=b7dcea4e） | **0**：各层目标全 PASS（domain 98.17/95.04、service 95.09/83.85、repository 93.83/82.69、http 91.67/79.85）；**diff 覆盖 93.65% ≥85% PASS**（1906 变更行/1785 覆盖）；baseline ratchet PASS | n1r-coverage-layered.log |
| 测试收集 | `npm run test:collection` | 0（243/243/0） | n1r-collection.log |
| schema drift | `npm run db:schema:drift` | 0 | n1r-drift.log |
| API 治理 | `npm run api:governance`（base refs=b7dcea4e） | 0（openapi 再生成**无 diff**；client check 一致；contract 10/10；breaking 无；31/31；route complexity ratchet PASS） | n1r-api-gov.log |
| 前端构建 | `npm run frontend:build` | 0 | n1r-fb.log |
| runtime | `npm run runtime:verify` | 0 | n1r-rv.log |
| alerting | `npm run alerting:verify` | 0 | n1r-av.log |
| release 合同 | `release:acceptance:contract` / `secret-rotation:evidence:contract` / `release:workflow:verify` | 全 0 | n1r-rac/src/rwv.log |

> **未达 exit 0 的唯一命令**：`vitest run --coverage`（收尾阶段挂死——本机已知环境现象）。任务规则要求"修正执行环境/报告器后重跑，或明确留下未通过项"：本批已执行报告器修正重跑（去 html、直启二进制），挂死复现；测试全绿与新鲜产物完整（已驱动下游 `coverage:layered` 通过），但该命令本身**不记 exit0**；其余 12 步以等价分步执行且各自 exit 0。

### 6.3 独立只读复核（本批 diff 全量复审）
- 范围：`git diff 555ae18..HEAD -- src/`（953 行）+ tests/docs；重点＝失败事务查询 / GET 一致性 / actor·RLS 边界 / 锁键一致性 / keep 语义。
- 结论：**无阻塞项**。核验：①三处 FK 兜底已无失败事务内查询（SAVEPOINT 恢复先于重查）；创建路径 23505 失败查询已移除；②readSnapshot 仅 GET 启用，默认 BEGIN/回滚/连接归还不变；③RLS 未扩大（全部经 actor 事务）；④advisory 锁键两端同源；⑤keep 分支未受影响（原摘录/capturedAt 保留）。
- 范围外观察（未改动）：`l3-writing-task.service.ts`、`upgrade-work-order.service.ts` 存在同型「唯一冲突后于同一事务内重读」疑似模式——不属 F1–F5 范围，建议后续批次评估。

### 6.4 推送与 PR
- 推送与 #126 更新：见 §9（完成后回填）。

## 7. 未覆盖项与限制（实时更新）

- 本批不覆盖：Task 07–11（前端）、N2、导出闭环、自动整理、数据迁移；`GET /:noteId/export` 端点仍未交付（Task 10）。
- 环境限制：`vitest run --coverage` 收尾挂死（见 §6.2；不记 exit0）；`pg_stat_activity.query` 对非超管不可见（交错测试以 `pg_locks`/`pg_blocking_locks` 组合证据代替语句文本）。
- 范围外同型模式观察见 §6.3。
- CI：`ci.yml` 仅对 base=main 的 PR 触发；本依赖 PR 上仅 `writing-e2e` 运行。三项必需检查待 #125 合并并 retarget 后在新 head 执行（后续授权任务）。

## 8. Task 07–08 消费合同（本批增量）

- **UUID 身份**：所有合法 UUID（requestId/noteId/topicId/beforeNoteId/引用与目标 id）大小写不敏感——前端可原样透传服务端/用户输入；服务端响应 id 一律规范小写。
- **错误码**：无新增码。创建幂等：同键同输入 200 复用 / 异输入 409（不变）；删除 blocker 409 结构不变；FK 兜底无匹配 blocker 时保持原错误语义（不再出现 25P02）。
- **游标**：目标搜索（`GET /reference-targets`）游标为 **createdAt 族 + 过滤指纹**——换 kind / q（规范化后）/ 有效 venue 必须清空游标重新起翻（复用旧游标 → 400）；`limit` 可自由调整；笔记/专题/backlinks 游标族不变且互不通用。
- **失效引用**：目标非 active 与目标被直删同显 `unavailable`（保留旧摘录/capturedAt，可 keep 可移除，显式重 capture → 404）；搜索仅返回 active 目标。
- **详情一致性**：`GET /:noteId` 为单快照视图（body/version/venues/references 同属一次提交），前端可直接整包替换本地态。
