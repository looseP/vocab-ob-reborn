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
- 实现提交：（提交后回填）
- 设计决策：规范化落在服务入口 + 仓库锁键（不动 zod schema，避免 OpenAPI 生成物扰动）；HTTP 层以真实 service 接线验证路径/body；不得用于正文/quote/optionKey。

## 2. F1 · 创建幂等与删除事务恢复（先红后绿）

- 修改（待执行）：`src/repositories/l3-study-notes.repository.ts`、`src/repositories/l3-study-topics.repository.ts`、`src/services/l3-study-notes.service.ts`、`src/services/l3-context.service.ts`、`src/services/l3-paper.service.ts`
- 红测试：待执行
- 实现提交：待执行
- 真库并发/交错证据：待执行
- 备注：create/createTopic 用 `ON CONFLICT (user_id, create_request_id) DO NOTHING RETURNING *` + 新语句回读；删除 FK 兜底用 SAVEPOINT（ROLLBACK TO / RELEASE）。

## 3. F2 · 详情一致快照（先红后绿）

- 修改（待执行）：`src/db/transaction.ts`、`src/services/l3-study-notes.service.ts`
- 红测试：待执行
- 实现提交：待执行
- 真库交错证据：待执行
- 备注：GET 详情增加显式 readSnapshot（REPEATABLE READ READ ONLY）；幂等复用路径锁行后组装。

## 4. F3 · 题目 active 规则（先红后绿）

- 修改（待执行）：`src/repositories/l3-study-references.repository.ts`、设计文件同步
- 红测试：待执行
- 实现提交：待执行
- 真库矩阵证据：待执行
- 备注：搜索/装载收敛 `status='active'`；旧引用 resolve=unavailable、keep 保留、禁止重新 capture。

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
