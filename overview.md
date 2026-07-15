# P1a.2 四数据库角色加固 — 阶段概览

## 本轮完成

- 四个真实 PostgreSQL LOGIN 的 bootstrap/verifier 已加固：数据库、三个受管 schema、relation、routine、type ownership 收敛到 `vocab_migration`；app/worker 使用精确当前权限 allowlist，backup 是唯一只读 `BYPASSRLS` 例外。
- 封闭 routine `PUBLIC EXECUTE`、双向 role membership、历史/default ACL 与 cleanup 错误传播缺口；备份恢复验收覆盖 catalog、RLS、ACL、extension、sequence、migration history 和恢复后四 LOGIN。
- 隔离 PostgreSQL 17 编排器使用随机 Compose project、loopback 高端口、fresh volume 与 project-scoped teardown。
- 修复 cwd-sensitive L3 测试与 alerting lock 单文件清理；补充 repository 错误分支测试，分层覆盖率恢复为全 PASS。
- 生产 Compose 的 `prepare → migrate → converge → services` 治理链、统一 PostgreSQL TLS 配置以及 L2 canonical hash 持久化正在最终安全收敛。

## 当前已通过证据

- `npm run test:unit`：88 files / 1200 tests 全部通过。
- 分层覆盖率：domain branches 89.06%，service 76.76%，repository 75.05%；baseline gate 与最终目标均 PASS。
- TypeScript typecheck PASS。
- dependency-cruiser：165 modules / 537 dependencies / 0 violations。
- schema drift PASS（含 owner RLS 与安全函数静态合同）。
- release workflow contract PASS。
- cwd/alerting 聚焦回归：3 files / 89 tests PASS。
- `git diff --check` PASS。

## 未完成 / 阻断

- `SECURITY DEFINER` L2 cache/hash RPC 的无 actor、伪造 hash、非 eligible word 和跨 owner 输入边界仍在独立审计与真实验收加固，不能只凭静态合同判定安全。
- dump/restore 的 libpq TLS 仍需与 `DB_SSLMODE=verify-full` 统一，避免治理脚本严格而 `pg_dump`/`pg_restore` 退回默认 TLS 模式。
- Docker Desktop `desktop-linux` engine 仍不可连接，因此 PostgreSQL 17 的 prepare → migrate → converge → real LOGIN → dump/restore 尚未真实执行。
- 仍需完成全量 `verify:engineering`、整理剩余提交、push 和创建独立 PR；不会自动合并。
