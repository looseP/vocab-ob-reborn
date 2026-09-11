# 迁移 0027 / 0028（含 P0 修正与 0029）数据库集成验收记录（R3）

- **日期**：2026-09-11（2026-09-11 追加 P0 修正复跑，见 §12）
- **被测对象（P0 修正后最终版指纹）**：
  - `drizzle-release/0027_cold_eddie_brock.sql` — SHA256 `C41F6E9720A4B7B8CDDD7475791B1F67A7A2AD6BA7EDBDC649299312DF0C0B5E`（P0 修正：删除 partial UNIQUE 索引与 preflight 守卫）
  - `drizzle-release/0028_black_ironclad.sql` — SHA256 `3DA930866761DD5FA3CA00A5DEE19BE4394CF7A3394F16004C45FD85F558EDF1`（未变）
  - `drizzle-release/0029_zippy_misty_knight.sql` — SHA256 `9E46CC73E29B350D8AC49ED9361637D7110A17895E1A7C5C3EE693ECDBB0EE3C`（兜底 DROP INDEX）
  - journal = 30 条（0000…0029）
- **环境**：仓库既有 RLS 验收组合（`compose.rls-acceptance.yaml`，postgres:17-alpine，127.0.0.1:55433）+ scratch 库（`r3probe`/`r3pre` 首次验收；`p0before`/`p0upgrade`/`p0pre` P0 复跑）。
- **判定**：**8/8 项通过**（1 项按守卫规则不适用，见 §9）；P0 修正后按新语义复跑 #1/#2/#3/#4/#6/#8 全通过（§12）。未发现需要修复的代码缺陷。
- **范围声明**：本任务不改代码（P0 修正按主 agent 裁决实施，见 ADR-0017「修正」节）；所有探针脚本均为临时文件，已清理；验收组合已 `down`（含卷）。
- **语义变更提示**：§1 的 #3/#4 与 §5 描述的是 P0 修正**之前**的行为，已由 §12 取代——**方向不再设唯一约束，同键多 active 行合法共存**。

## 1. 判定表

| # | 验收项 | 判定 | 证据（命令 → 关键输出） |
|---|---|---|---|
| 1 | 空库可完整应用 0027/0028 | **PASS** | `rls:acceptance:up → roles:prepare → migrate → roles:converge → bootstrap` → `RLS acceptance migrations applied and verified (29 journal entries)`（P0 后 30，见 §12）；对象核对见 §2 |
| 2 | 幂等/重跑（ledger 级 + SQL 原文级） | **PASS** | `rls:acceptance:migrate` 重跑 exit 0；0027 原文 ×2、0028 原文 ×2 全部 exit 0，仅 `already exists, skipping` NOTICE（IF NOT EXISTS 路径） |
| 3 | 唯一索引语义（生效行去重、候选/退役共存） | **PASS**（已被 P0 修正取代，见 §12） | 4 行 = 2 active + 1 candidate + 1 retired；第二条 active 同键 → `duplicate key value violates unique constraint "word_l2_content_word_field_direction_active_unique"`。**P0 后语义：同键多 active 行合法共存，索引不存在** |
| 4 | preflight 守卫 fail-closed + 修数据后可重跑 | **PASS**（**该守卫已被 P0 修正删除**，见 §12） | 真实 `npm run db:migrate` 在 1 个重复 active 键上 exit 1，ledger 保持 27、无 `direction` 列/索引；诊断文本见 §5；**数据未被改动（active_dupes 仍为 1，无静默 dedup）**；退休旧行后重跑 exit 0 |
| 5 | 新三表 RLS（vocab_app，own-only） | **PASS** | actor B 对三表读取均 0 行；冒充 owner 写入被 RLS WITH CHECK 拒；跨 owner context → 23503；`l3_practice_attempts` DELETE → 42501；`has_table_privilege` = attempts_delete `f` / sessions_delete `f` / work_orders_update `t` |
| 6 | refresh_l2_cache direction 行为 + 顺序稳定 | **PASS** | 多方向词缓存 = `[{"c": 1, "direction": "通用"}, {"c": "kaoyan", "direction": "考研"}]`；重复调用逐字节相同；顺序按 `created_at, ordinality`；与 `verify-database-roles` 期望形状一致（§8 该脚本通过） |
| 7 | 哈希行为（与 R1 交叉验证） | **PASS** | 应用 0027+0028 后 7/7 键逐字节不变；跨形状重算：同条目集 pre-shape `5f38015e…` vs post-shape `d628b1c9…`（形状改变 hash **值**）；finalize 恰 1 行、L2 snapshot/due 推前；**L1 `needs_recheck` 保持 false、L1 due/snapshot 不变**；重复 finalize 同 hash = 0 行 |
| 8 | 角色/DB 套件 | **PASS** | `rls:acceptance:test` 5 passed；`rls:acceptance:test:l3` 6 passed；`test:db-roles` → `{"ok":true,…,"exactPrivileges":true,"l2SecurityFunctions":true,…}`；`test:db-release` → `Release database verification passed`（14 tables / 3 functions / 并发计数器）；`test:integration` 7 files / 54 tests passed |

## 2. 项 1 对象核对（空库应用后）

```
（P0 修正后 = 现行语义；括号内为修正前的首次验收结果）
ledger = 30（修正前 29）
word_l2_content.direction: text DEFAULT '通用'::text
word_l2_content 索引 = word_l2_content_pkey + idx_l2_content_source + idx_l2_content_word_field
  （修正前另有 partial UNIQUE word_l2_content_word_field_direction_active_unique；0029 负责删除）
l3_practice_attempts / l3_sessions / upgrade_work_orders: relrowsecurity = t
refresh_l2_cache 定义包含 direction（position = 538）
```

## 3. 项 2 幂等细节

- ledger 级：`rls:acceptance:migrate` 二次运行 → exit 0（迁移已记录，no-op）。
- SQL 级：迁移原文直接重复执行，覆盖路径：
  - `0027`（P0 后）：`ADD COLUMN IF NOT EXISTS`（×2 跳过）、`DROP CONSTRAINT IF EXISTS + ADD`（无 NOTICE，幂等）、
    `CREATE OR REPLACE FUNCTION`（×2 覆盖）；无索引/无守卫语句。
  - `0028`：`CREATE TABLE IF NOT EXISTS`（×3 跳过）、FK `DROP CONSTRAINT IF EXISTS + ADD`、
    索引 `IF NOT EXISTS`（×2 跳过）、`DROP POLICY IF EXISTS + CREATE POLICY`。
  - `0029`（P0 后）：`DROP INDEX IF EXISTS` ×2 → `index … does not exist, skipping`，exit 0。

## 4. 项 3 / 5 语义细节

- 行分布（同 `(word, field='collocation')`）：`all=4, active=2（通用+考研）, candidate=1, retired=1`
  → 候选行与退役行可与生效行共存，互不阻塞。
- RLS 探针（`SET ROLE vocab_app` + `request.jwt.claim.sub`）：
  - actor B 视角：`sessions_seen=0, work_orders_seen=0, attempts_seen=0`；
  - `R3-5-OK: spoofed-owner insert blocked by RLS WITH CHECK`；
  - `R3-5-OK: cross-owner context attempt blocked by composite owner FK (23503)`；
  - `R3-5-OK: vocab_app DELETE on l3_practice_attempts denied (42501)`（记录只增，无删除路径）。

## 5. 项 4 preflight 守卫（历史记录：守卫已被 P0 修正删除）

> 本节记录 P0 修正**之前**的 fail-closed 实证；该守卫已按主 agent 裁决删除（见 §12 与
> ADR-0017「修正」节）——它挡住的正是"同键多 active"这种**合法存量**，现改为放行。

- 前置：`r3pre` 应用至 0026，构造同 `(word, field)` 两条 active（0027 之前 append 语义的产物）。
- 旧版 `npm run db:migrate`（drizzle 路径）→ **exit 1**；随后核对：`ledger=27`、
  `direction` 列不存在、唯一索引不存在 → 迁移在事务内整体回滚，无半成品。
- 旧诊断文本（psql `--single-transaction` 复现，与 drizzle 事务语义一致）：

```
ERROR:  0027 preflight: 1 (word_id, field, direction) 键存在多条 active 行；
        请先退休旧行或合并内容再重跑（不自动 dedup，避免静默丢内容）
```

- 承诺核对：失败后 `active_dupes` 仍为 1 → **不静默 dedup**；人工退休旧行（`is_active=false, approved_at=now()`）
  后重跑 → `migrations applied successfully`，exit 0。
- **P0 修正后**：同样构造的存量库（含 2 条同键 active）直接 `npm run db:migrate` → exit 0，
  `active_rows` 仍为 2（未 dedup）、两行 backfill `通用`、无同键索引；refresh 聚合两条 →
  `[{"c": 1, "direction": "通用"}, {"c": 2, "direction": "通用"}]`。详见 §12。

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

## 11. 交接（CI）

- 提交前用 §头部 SHA256 指纹校验三份迁移未被再改动。
- 建议随提交携带：本记录 + `docs/design/l2-hash-direction-impact-and-decision.md`（R1）。
- CI 等效命令（在本机验收组合外可直接复用）：
  `rls:acceptance:up → roles:prepare → migrate → roles:converge → bootstrap →
  rls:acceptance:test → rls:acceptance:test:l3 → test:db-roles → test:db-release → test:integration`
  （`test:integration` 需补 `RLS_ACCEPTANCE_DATABASE_URL`；`test:capacity` 需专用容量库）。

## 12. P0 修正（2026-09-11）复跑记录

**修正内容**：0027 删除 partial UNIQUE 索引与 preflight 守卫（direction 只作维度）；新增 0029
兜底 `DROP INDEX IF EXISTS`；schema.ts / 快照 / 台账 / ADR-0017 / CONTEXT.md 同步。

| 复跑项 | 结果（原始输出摘要） |
|---|---|
| #1 空库应用 | `migrations applied and verified (30 journal entries)`；`word_l2_content` 索引 = pkey + `idx_l2_content_source` + `idx_l2_content_word_field`（**无同键唯一索引**） |
| #2 幂等 | ledger 重跑 30 条 exit 0；0027 原文 ×2 exit 0（`column … already exists, skipping`）；0029 原文 ×2 exit 0（`index … does not exist, skipping`） |
| #3 新语义 | 同键多 active 行合法共存（回归测试 (a)/(b) 连续两次 confirmDraft、append 采纳均成功；见下"回归测试"） |
| #4 新语义 | 0026 存量库 + 同键 2 条 active → 真实 `db:migrate` **exit 0**（旧守卫会 fail-closed）；行仍为 2（未 dedup）、两行 backfill `通用`、`dir_indexes=0`；refresh 聚合 `[{"c": 1, "direction": "通用"}, {"c": 2, "direction": "通用"}]` |
| #6 refresh 行为 | 无回归：条目带 direction、按 `created_at, ordinality` 稳定、重复调用逐字节相同（回归测试 (d)） |
| #8 套件 | `rls:acceptance:test` 5 passed；`:test:l3` 6 passed；`test:db-roles` `ok:true`；`test:db-release` passed（14 tables / 3 functions）；`test:integration` **8 files / 59 tests passed**（含新回归文件） |
| 漂移契约 | `db:schema:drift` OK —— **`REFRESH_L2_CACHE_DIRECTION_CONTRACT` 仍通过**（0027 函数体一字未改） |

**回归测试（先证伪、后证真）** —— `tests/l2-content.integration.test.ts`（5 例）：

- **修复前**（`p0before` = 旧版 0027 链路）：**4 failed / 1 passed**
  - (a) 连续两次 confirmDraft → `duplicate key value violates unique constraint
    "word_l2_content_word_field_direction_active_unique"`，detail `Key (word_id, field, direction)=(…, collocation, 通用) already exists.`
  - (b) append 采纳 → 同 23505（corpus, 通用）
  - (c) replace 采纳 → 通过（先退休兄弟行，不依赖索引缺失）
  - (d) 造"同 direction 两条 active"夹具 → 23505
  - (e) 索引存在性断言 → 失败（索引仍在）
- **修复后**（新链路 `vocab_rls_acceptance`）：**5 passed**
- **升级演练**（`p0upgrade` = 旧版 0027 已应用的库 → 真实 `db:migrate` 仅补 0029）：
  `migrations applied successfully`、ledger 30、`dir_indexes=0`，随后回归测试 **5 passed**。
- **(c) replace 语义**：候选激活、兄弟行转 retired（`is_active=false` 且 `approved_at` 非空，留档不删除）。

**未决提醒**：同键多 active 行"如何取舍/去重"属于读取层与后续服务决策（T05/T10），schema 不再用约束替用户决定。
