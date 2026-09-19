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
- 实现提交：（回填）
- 备注：预检查注释已按实际查询修正（**计入子题引用**）；「无匹配 blocker 不伪造笔记阻塞」边界双端（context/paper）留证。

## 3. F2 · 详情一致快照（先红后绿）

- 修改（已实施）：`src/db/transaction.ts`（`TransactionOptions.readSnapshot` → `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`；默认仍为普通 BEGIN）；`src/services/l3-study-notes.service.ts`（`get()` 启用 readSnapshot；幂等复用两路径——已存在与冲突回读——先 `lock` 行再组装 DTO；createTopic 复用同样先锁行）
- 红测试（单元）：`npx vitest run tests/db/transaction.test.ts tests/services/l3-study-notes.test.ts` → **5 failed / 48 passed，exit 1**（`D:/tmp/n1r-f2-red-unit.log`：BEGIN 文本不符、未传 readSnapshot、复用未锁行）
- 红测试（真库）：F2 交错 → **1 failed / 1 passed**（`D:/tmp/n1r-f2-red-integration.log`；实证"旧正文拼新引用"：marker 集合 [1] ≠ 引用集合 [2]）
- 绿测试：单元 **53/53 exit 0**（`D:/tmp/n1r-f2-green-unit.log`）；真库 **12/12 exit 0**（`D:/tmp/n1r-f2-green-integration.log`）
- 真库交错证据：GET 读出 note 行后（实际仓储 SQL 后的可观测屏障）另一连接提交 v2（新正文/新引用/新归属）→ 响应完整属于旧版（version=2 全集）或新版（version=3 全集），marker 与引用集合一致；GET 零写（5 表计数不变）、跨 owner 404、重开读取一致、连接归还后普通写事务仍可写
- 实现提交：（回填）
- 备注：readSnapshot 仅供只读详情使用（写路径不启用）；冲突回读加锁不影响 F1 的输入 hash 比对语义。

## 4. F3 · 题目 active 规则（先红后绿）

- 修改（已实施）：`src/repositories/l3-study-references.repository.ts`（searchTargets question 分支与 loadTargets question 分支收敛 `status = 'active'`；模块注释同步）；`docs/plan/study-notes-design-2026-09-18.md` §3（题目可用性与 unavailable 消费说明同步）
- 红测试（单元）：`npx vitest run tests/repositories/l3-study-references.test.ts` → **2 failed / 14 passed，exit 1**（`D:/tmp/n1r-f3-red-unit.log`：两处 SQL 均无 active 条件）
- 红测试（真库）：F3 矩阵 → **2 failed**（`D:/tmp/n1r-f3-red-integration.log`：搜索含非 active、preview/capture 未收口）
- 绿测试：单元 **16/16 exit 0**；真库 **14/14 exit 0**（`D:/tmp/n1r-f3-green-unit.log`、`D:/tmp/n1r-f3-green-integration.log`）
- 真库矩阵证据：同 owner active/pending/rejected × question/stem_quote/option_quote；搜索只回 active（total=items 条件）、pending/rejected 预览 404、跨 owner 404；rejected capture 失败后正文/version/归属/引用整体不变；active→rejected 后 GET unavailable 保留旧摘录/capturedAt、keep 可保存、重新 capture 404、移除可行
- 实现提交：（回填）
- 备注：状态更新路径——l3_questions 对 vocab_app 无 UPDATE 授权（grants 实测），测试经 admin（vocab_migration）直改 status 作为实际状态入口；本批不改全项目状态机制。

## 5. F4 · 引用搜索游标绑定过滤（先红后绿）

- 修改（待执行）：`src/repositories/l3-study-cursor.ts`、`src/services/l3-study-reference.service.ts`
- 红测试：待执行
- 实现提交：待执行
- 真库分页证据：待执行
- 备注：游标族=createdAt，指纹绑定 kind/规范化 q/有效 venue；拒绝旧不绑定游标与其他列表游标。

## 6. 最终验收（待执行）

- 定向回归、既有+新增集成、RLS 验收、`npm run verify:engineering`（base=b7dcea4e）：待执行
- 独立只读复核：待执行
- 推送与 PR #126 更新：待执行

## 7. 未覆盖项与限制（实时更新）

- 待记录。
