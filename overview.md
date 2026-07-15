# P1a.2 四数据库角色加固 — 阶段概览

## 本轮完成

- 四个真实 PostgreSQL LOGIN 的 bootstrap/verifier 已加固：数据库、三个受管 schema、relation、routine、type ownership 收敛到 `vocab_migration`；app/worker 使用精确当前权限 allowlist，backup 是唯一只读 `BYPASSRLS` 例外。
- 封闭 routine `PUBLIC EXECUTE`、双向 role membership、历史/default ACL 与 cleanup 错误传播缺口；备份恢复验收覆盖 catalog、RLS、ACL、extension、sequence、migration history 和恢复后四 LOGIN。
- 隔离 PostgreSQL 17 编排器使用随机 Compose project、loopback 高端口、fresh volume 与 project-scoped teardown。
- 修复 cwd-sensitive L3 测试与 alerting lock 单文件清理；补充 repository 错误分支测试，分层覆盖率恢复为全 PASS。
- 生产 Compose 已补齐 `prepare → migrate → converge → services` 治理链；统一 PostgreSQL TLS 覆盖 runtime、治理、迁移和备份工具；L2 canonical hash 由 migration-owned RPC 原子持久化，并以 transaction-local actor + 目标词学习进度绑定授权。

## 当前已通过证据

- `verify:engineering` 全链 PASS；Vitest 主体 88 files / 1203 tests 全部通过。
- 分层覆盖率：domain branches 89.06%，service 76.76%，repository 75.05%；baseline gate 与最终目标均 PASS。
- TypeScript typecheck PASS。
- dependency-cruiser：167 modules / 540 dependencies / 0 violations。
- schema drift PASS（含 owner RLS 与安全函数静态合同）。
- release workflow contract PASS。
- cwd/alerting 聚焦回归：3 files / 89 tests PASS。
- `git diff --check` PASS。

## 未完成 / 阻断

- `SECURITY DEFINER` L2 cache/hash RPC 已补无 actor、错误 actor、伪造 hash、非 eligible word、跨目标和 paused/null/same-hash 排除的真实 PostgreSQL 验收逻辑；但 Docker 未启动，尚未取得运行时通过证据。
- dump/restore 的 libpq TLS 已改为受控 `DB_SSLMODE`/`DB_SSLROOTCERT`，不继承 ambient `PG*`；node-postgres 与 Drizzle 同步消费严格 CA 配置。
- Docker Desktop `desktop-linux` engine 仍不可连接，因此 PostgreSQL 17 的 prepare → migrate → converge → real LOGIN → 安全函数 → dump/restore 尚未真实执行。
- diff coverage 根因已修复：只统计 Istanbul statement/branch/function range 所定义的可执行变更行；整个 governed source 文件缺失 coverage 时仍 fail closed；同一行所有适用 range 必须全部命中。85% 阈值和 baseline 未变，当前结果 98.91% PASS。
- 仍需独立终审、push 和创建独立 PR；不会自动合并。
