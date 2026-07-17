# P1a.2 四数据库角色加固 — PR #54 最终收口概览

## 本轮完成

- 将 CI Engineering、Browser E2E、release verify、migration rehearsal、默认 local Compose、生产 Compose 和 monthly recovery drill 统一为 `prepare → migrate as vocab_migration → converge → runtime/test`，并以 fail-closed 合同冻结真实步骤、身份和顺序。
- 四个真实 PostgreSQL LOGIN 已收敛：`vocab_app`、`vocab_worker`、`vocab_migration` 均为 `NOBYPASSRLS`；`vocab_backup` 是唯一只读 `BYPASSRLS` 例外；双向 role membership、database/schema/object/routine/default ACL 和 ownership 均精确对账。
- 修复历史本地数据卷升级：prepare 在迁移前接管旧管理员对象，relation ownership 按 table-before-sequence 收敛；旧卷演练动态读取权威 migration journal，验证 sentinel 数据保留。
- 正式发布入口升级为六阶段 `pull → prepare → migration → converge → rollout → smoke`，任一治理阶段失败均阻断 rollout；发布 evidence 和运维文档同步更新。
- E2E runtime 与 fixture 身份分离：Web 仅接收严格环境白名单和 app URL，global setup 使用 dedicated admin，宿主数据库 URL、`NODE_OPTIONS` 等不再泄漏给 Web 子进程。
- monthly recovery drill 分离 source/drill 五身份：backup 使用 `vocab_backup`，restore 使用 `vocab_migration`，写入型 release verification 使用 drill admin，恢复后再次 converge 并复验四个真实 LOGIN。
- 最终终审发现并修复 `postgres-backup.ts` 的真实恢复阻断：`pg_restore` 现在显式接收 `--dbname`，并校验 `PG_RESTORE_JOBS` 为正整数；新增回归测试，避免静态 YAML 合同掩盖不可执行的恢复命令。

## 最新本地证据（2026-07-17）

- `verify:engineering` 全链 PASS：90 files / 1278 tests 全部通过。
- dependency-cruiser：167 modules / 540 dependencies / 0 violations；TypeScript、schema drift、API governance、frontend build、runtime、alerting、release/secret-rotation/workflow contracts 全部 PASS。
- 分层覆盖率 baseline 与最终目标均 PASS：domain branches 89.06%，service 76.76%，repository 75.05%；diff coverage 98.91% PASS，85% 阈值未降低。
- PostgreSQL 17 fresh 四角色验收 PASS：真实 LOGIN、dedicated superuser admin、RLS、exact privileges、零双向 membership、L2 安全函数、ownership 及容器内 `pg_dump → pg_restore` 精确对账全部通过。
- PostgreSQL 17 旧卷升级验收 PASS：历史数据保留、权威 migration count 13、ownership 收敛；fresh/旧卷随机容器、网络和数据卷均完整清理。
- restricted RLS LOGIN 验收 PASS：修复精确 database ACL 收敛后 test-only `vocab_rls_acceptance` 缺 `CONNECT` 的问题；该身份仅获显式 CONNECT，无 CREATE/TEMPORARY，且无双向 role membership。独立验收入口统一为 `healthy → prepare → migrate as vocab_migration → converge → bootstrap → test`，真实 PostgreSQL 17 验收 5/5 通过并完整清理资源。
- `git diff --check` PASS；shared index 为空，没有其他代理 staged 内容。

## PR 状态与未完成项

- PR：<https://github.com/looseP/vocab-ob-reborn/pull/54>，分支 `feat/p1a2-production-database-roles`。
- 首轮 CI run `29436332211` 的两个 required checks 均真实失败：Browser E2E 和 Engineering clean-volume Compose 在角色尚未 prepare 时迁移，触发 `role "vocab_migration" does not exist`。本轮已修复这些入口，但远端仍停留在旧 HEAD `183921a`，尚未获得新 HEAD 的 CI 证据。
- 提交推送后必须等待 `Engineering Gate + Migration Rehearsal` 与 `Browser E2E (Playwright)` 对新 HEAD 双绿；双绿前不得宣称 PR 可合并。
- 不自动合并。Windows single-host 完整应用 smoke 仍是后续独立任务，需要私有环境变量和五个 immutable image digests，不能由本次数据库专项验收替代。
