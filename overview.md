# P1a.2 四数据库角色加固 — 阶段概览

## 本轮完成

- 四个真实 PostgreSQL LOGIN 的 bootstrap/verifier 已加固：数据库、三个受管 schema、relation、routine、type ownership 收敛到 `vocab_migration`；app/worker 使用精确当前权限 allowlist，backup 是唯一只读 `BYPASSRLS` 例外。
- 封闭 routine `PUBLIC EXECUTE`、双向 role membership、历史/default ACL 与 cleanup 错误传播缺口；备份恢复验收覆盖 catalog、RLS、ACL、extension、sequence、migration history 和恢复后四 LOGIN。
- 隔离 PostgreSQL 17 编排器使用随机 Compose project、loopback 高端口、fresh volume 与 project-scoped teardown。
- 修复 cwd-sensitive L3 测试与 alerting lock 单文件清理；补充 repository 错误分支测试，分层覆盖率恢复为全 PASS。
- 生产 Compose 已补齐 `prepare → migrate → converge → services` 治理链；统一 PostgreSQL TLS 覆盖 runtime、治理、迁移和备份工具；L2 canonical hash 由 migration-owned RPC 原子持久化，并以 transaction-local actor + 目标词学习进度绑定授权。

## 当前已通过证据

- `verify:engineering` 全链 PASS；Vitest 主体 88 files / 1217 tests 全部通过。
- 分层覆盖率：domain branches 89.06%，service 76.76%，repository 75.05%；baseline gate 与最终目标均 PASS。
- TypeScript typecheck PASS。
- dependency-cruiser：167 modules / 540 dependencies / 0 violations。
- schema drift PASS（含 owner RLS 与安全函数静态合同）。
- release workflow contract PASS。
- PostgreSQL 17 真实验收 PASS：fresh project/volume 上完成 `prepare → migrate → converge`，验证四个真实 LOGIN、exact privileges、零双向 membership、ownership、RLS 与 L2 安全函数 actor 正负路径。
- PostgreSQL 17 容器内 `pg_dump → pg_restore` PASS；database/schema/object/routine/ACL/RLS/sequence/extension/migration history 精确对账，恢复后四 LOGIN 行为复验通过，随机恢复库及 Compose 资源完整清理。
- 验收加固聚焦回归：3 files / 54 tests PASS；`git diff --check` PASS。
- diff coverage 仅统计 Istanbul statement/branch/function range 所定义的可执行变更行，且同一行所有适用 range 必须全部命中；缺失 coverage 文件仍 fail closed。85% 阈值和 baseline 未变，当前 98.91% PASS。
- 独立终审结论：无 P0/P1，可提交并创建独立 PR。

## 未完成 / 阻断

- 代码、工程门禁和 PostgreSQL 17 实机验收均已闭环；剩余流程项仅为提交、push、创建独立 PR 并等待远端 required checks。
- 不自动合并；Windows single-host 完整应用 smoke 仍是单独后续任务，不以本次数据库角色验收替代。
