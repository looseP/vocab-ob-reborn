# 迁移 0027 / 0028 数据库集成验收记录（R3）

- **日期**：2026-09-11
- **被测对象（最终版指纹）**：
  - `drizzle-release/0027_cold_eddie_brock.sql` — SHA256 `B64F9DD3A6455E1B78157ACD9D974D9FA4666E723B23BE8E257BC1E022B2300F`
  - `drizzle-release/0028_black_ironclad.sql` — SHA256 `3DA930866761DD5FA3CA00A5DEE19BE4394CF7A3394F16004C45FD85F558EDF1`
  - journal = 29 条（0000…0028）
- **环境**：仓库既有 RLS 验收组合（`compose.rls-acceptance.yaml`，postgres:17-alpine，127.0.0.1:55433）+ 两个 scratch 库（`r3probe` 全量迁移、`r3pre` 先至 0026 再前进）。
- **判定**：**8/8 项通过**（1 项按守卫规则不适用，见 §9）。未发现需要修复的代码缺陷。
- **范围声明**：本任务不改代码；所有探针脚本均为临时文件，已清理；验收组合已 `down`（含卷）。

## 1. 判定表

| # | 验收项 | 判定 | 证据（命令 → 关键输出） |
|---|---|---|---|
| 1 | 空库可完整应用 0027/0028 | **PASS** | `rls:acceptance:up → roles:prepare → migrate → roles:converge → bootstrap` → `RLS acceptance migrations applied and verified (29 journal entries)`；对象核对见 §2 |
| 2 | 幂等/重跑（ledger 级 + SQL 原文级） | **PASS** | `rls:acceptance:migrate` 重跑 exit 0（29 条）；0027 原文 ×2、0028 原文 ×2 全部 exit 0，仅 `already exists, skipping` NOTICE（IF NOT EXISTS 路径），0027 DO 守卫 0 重复静默通过 |
| 3 | 唯一索引语义（生效行去重、候选/退役共存） | **PASS** | 4 行 = 2 active + 1 candidate + 1 retired；第二条 active 同键 → `duplicate key value violates unique constraint "word_l2_content_word_field_direction_active_unique"` |
| 4 | preflight 守卫 fail-closed + 修数据后可重跑 | **PASS** | 真实 `npm run db:migrate` 在 1 个重复 active 键上 exit 1，ledger 保持 27、无 `direction` 列/索引；诊断文本见 §5；**数据未被改动（active_dupes 仍为 1，无静默 dedup）**；退休旧行后重跑 exit 0 |
| 5 | 新三表 RLS（vocab_app，own-only） | **PASS** | actor B 对三表读取均 0 行；冒充 owner 写入被 RLS WITH CHECK 拒；跨 owner context → 23503；`l3_practice_attempts` DELETE → 42501；`has_table_privilege` = attempts_delete `f` / sessions_delete `f` / work_orders_update `t` |
| 6 | refresh_l2_cache direction 行为 + 顺序稳定 | **PASS** | 多方向词缓存 = `[{"c": 1, "direction": "通用"}, {"c": "kaoyan", "direction": "考研"}]`；重复调用逐字节相同；顺序按 `created_at, ordinality`；与 `verify-database-roles` 期望形状一致（§8 该脚本通过） |
| 7 | 哈希行为（与 R1 交叉验证） | **PASS** | 应用 0027+0028 后 7/7 键逐字节不变；跨形状重算：同条目集 pre-shape `5f38015e…` vs post-shape `d628b1c9…`（形状改变 hash **值**）；finalize 恰 1 行、L2 snapshot/due 推前；**L1 `needs_recheck` 保持 false、L1 due/snapshot 不变**；重复 finalize 同 hash = 0 行 |
| 8 | 角色/DB 套件 | **PASS** | `rls:acceptance:test` 5 passed；`rls:acceptance:test:l3` 6 passed；`test:db-roles` → `{"ok":true,…,"exactPrivileges":true,"l2SecurityFunctions":true,…}`；`test:db-release` → `Release database verification passed`（14 tables / 3 functions / 并发计数器）；`test:integration` 7 files / 54 tests passed |

## 2. 项 1 对象核对（空库应用后）

```
ledger = 29
word_l2_content.direction: text DEFAULT '通用'::text
CREATE UNIQUE INDEX word_l2_content_word_field_direction_active_unique
  ON public.word_l2_content USING btree (word_id, field, direction) WHERE (is_active = true)
l3_practice_attempts / l3_sessions / upgrade_work_orders: relrowsecurity = t
refresh_l2_cache 定义包含 direction（position = 538）
```

## 3. 项 2 幂等细节

- ledger 级：`rls:acceptance:migrate` 二次运行 → `(29 journal entries)`，exit 0（迁移已记录，no-op）。
- SQL 级：把两份迁移原文直接执行各两次，覆盖路径：
  - `0027`：`ADD COLUMN IF NOT EXISTS`（×2 跳过）、`DROP CONSTRAINT IF EXISTS + ADD`（无 NOTICE，幂等）、
    `CREATE UNIQUE INDEX IF NOT EXISTS`（×2 跳过）、`CREATE OR REPLACE FUNCTION`（×2 覆盖）、
    **DO 守卫**（×2 均在 0 重复下通过，无异常）。
  - `0028`：`CREATE TABLE IF NOT EXISTS`（×3 跳过）、FK `DROP CONSTRAINT IF EXISTS + ADD`、
    索引 `IF NOT EXISTS`（×2 跳过）、`DROP POLICY IF EXISTS + CREATE POLICY`。

## 4. 项 3 / 5 语义细节

- 行分布（同 `(word, field='collocation')`）：`all=4, active=2（通用+考研）, candidate=1, retired=1`
  → 候选行与退役行可与生效行共存，互不阻塞。
- RLS 探针（`SET ROLE vocab_app` + `request.jwt.claim.sub`）：
  - actor B 视角：`sessions_seen=0, work_orders_seen=0, attempts_seen=0`；
  - `R3-5-OK: spoofed-owner insert blocked by RLS WITH CHECK`；
  - `R3-5-OK: cross-owner context attempt blocked by composite owner FK (23503)`；
  - `R3-5-OK: vocab_app DELETE on l3_practice_attempts denied (42501)`（记录只增，无删除路径）。

## 5. 项 4 preflight 守卫（fail-closed 实证）

- 前置：`r3pre` 应用至 0026，构造同 `(word, field)` 两条 active（0027 之前 append 语义的产物）。
- 真实 `npm run db:migrate`（drizzle 路径）→ **exit 1**；随后核对：`ledger=27`、
  `direction` 列不存在、唯一索引不存在 → 迁移在事务内整体回滚，无半成品。
- 诊断文本（psql `--single-transaction` 复现，与 drizzle 事务语义一致）：

```
ERROR:  0027 preflight: 1 (word_id, field, direction) 键存在多条 active 行；
        请先退休旧行或合并内容再重跑（不自动 dedup，避免静默丢内容）
```

- 承诺核对：失败后 `active_dupes` 仍为 1 → **不静默 dedup**；人工退休旧行（`is_active=false, approved_at=now()`）
  后重跑 → `migrations applied successfully`，exit 0。

## 6. 项 6 refresh_l2_cache 行为

- 夹具：同词 `collocation` 两条 active 行（`通用` created_at 2026-01-01 / `考研` 2026-01-04）。
- 结果：`[{"c": 1, "direction": "通用"}, {"c": "kaoyan", "direction": "考研"}]`；
  `byte_stable_across_calls = t`；`通用` 1 条、`考研` 1 条 → 每个 object 条目带自身行的 direction，
  顺序按 `created_at, ordinality` 稳定。
- 对照 `scripts/verify-database-roles.ts` 的期望形状（夹具全 `通用`，条目携带 `direction: "通用"`）：
  二者一致，且该校验脚本在最终版迁移上通过（§8）。

## 7. 项 7 哈希行为（回填 R1）

| 观察 | 值 |
|---|---|
| 应用 0027+0028 后的存量状态（7 键） | **全部不变**（缓存字节/hash/L2 snapshot/due/L1 标志/L1 due） |
| 应用侧 `computeL2Hash`：同条目集 pre-shape / post-shape | `5f38015e…` / `d628b1c9…` → **形状改变 hash 值**，确定性可复算 |
| 编辑后 refresh 的缓存 | `{"c": 2, "direction": "通用"}`、`{"text": "r3-edit", "direction": "考研"}` |
| 应用路径 `finalize_l2_content_hash`（用 TS 侧算出的 hash） | 恰 **1** 行更新；L2 snapshot 更新、`l2_due_at` 推前（内容确已变化） |
| L1 轨 | `needs_recheck = false`、`due_at` 不变、`content_hash_snapshot` 不变 |
| 同 hash 重复 finalize | **0 行**（无重复 recheck） |

结论与 R1 一致：direction 键使 hash **值** 在"缓存被重新物化"时改变，但该时点总是用户主动的
L2 内容编辑；不产生迁移时刻或读取时刻的 churn，也不触发 `needs_recheck`。

## 8. 项 8 套件输出摘要

```
rls:acceptance:test        → Test Files 1 passed / Tests 5 passed
rls:acceptance:test:l3     → Test Files 1 passed / Tests 6 passed
test:db-roles              → {"ok":true,"appRls":true,"workerRls":true,"exactPrivileges":true,
                              "functionExecuteAllowlist":true,"l2SecurityFunctions":true,"ownershipConverged":true}
test:db-release            → Release database verification passed（Tables 14 / Functions 3 / 并发门禁）
test:integration           → Test Files 7 passed / Tests 54 passed
```

操作提示（非缺陷）：`test:integration` 里的 `tests/db/transaction-rls.integration.test.ts` 需要
`RLS_ACCEPTANCE_DATABASE_URL`（受限验收 LOGIN）；未提供时该文件会以配置错误失败（其余 6 文件
49 测试已通过）。完整执行请照 `package.json` 的 `rls:acceptance:*` 变量集。

## 9. 未执行项

| 项 | 原因 |
|---|---|
| `test:capacity` | 该脚本守卫要求库名匹配 `_test|_drill|_capacity|vocab` 且 `CAPACITY_TEST_CONFIRM=<库名>`；验收库 `vocab_rls_acceptance` 不满足守卫（按设计拒绝在共享/验收库上跑容量压测），本任务未另建专用容量库。 |

## 10. 环境清理

- scratch 库 `r3probe` / `r3pre` 已 DROP；
- `npm run rls:acceptance:down` 已执行（容器 / 网络 / 数据卷移除，环境回到任务开始时的"未运行"状态）；
- 全部临时脚本（探针 SQL / 重算 TS / 过滤迁移集与临时 drizzle 配置）已删除；未修改任何仓库文件。

## 11. 交接（R2 / CI）

- R1 未改 0027/0028 本体，R3 未改任何文件 ⇒ R2 提交时无需重跑本记录；提交前可用 §头部
  的 SHA256 指纹校验两份迁移未被改动。
- 建议随提交携带：本记录 + `docs/design/l2-hash-direction-impact-and-decision.md`（R1）。
- CI 等效命令（在本机验收组合外可直接复用）：
  `rls:acceptance:up → roles:prepare → migrate → roles:converge → bootstrap →
  rls:acceptance:test → rls:acceptance:test:l3 → test:db-roles → test:db-release → test:integration`
  （`test:integration` 需补 `RLS_ACCEPTANCE_DATABASE_URL`；`test:capacity` 需专用容量库）。
