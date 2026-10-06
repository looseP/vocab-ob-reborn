# ADR-0042: 迁移链治理 —— journal 严格递增 / 快照链 / 账本真源 / 新迁移幂等

- **Status**: Accepted
- **Date**: 2026-10-06
- **References**: ADR-0004 §6（工程纪律与零新依赖）、`docs/design/迁移链治理-执行计划-2026-10-06.md`（本决策的施工口径）、`1d08668`（0047–0050 迁移链修复：when 撞车 + 快照缺终态 + 机器守卫）、`scripts/reconcile-migration-ledger.ts`、`scripts/verify-schema-drift.ts`
- **上游**: 0047–0049 的 journal `when` 与 0046 撞车，导致「已到 0046」的增量库静默跳过三条迁移，且 RLS 验收的完成判据过弱（`migrationCount < 1`）长期没有暴露它

## Context

drizzle 迁移器判定「该不该应用一条迁移」只读一次账本：

```
select id, hash, created_at from vocab_migrations.__v2_release_migrations order by created_at desc limit 1
```

随后对每条 journal 条目做**严格小于**比较（`lastDbMigration.created_at < entry.when`）。
（`node_modules/drizzle-orm/pg-core/dialect.cjs`；hash 只写不读，是整文件 sha256。）

由此产生三条结构性事实：

- `when` 撞车的条目在增量库上**永远跳过**且不报错 —— 这正是 0047–0049 事故；
- 判据只有 `max(created_at)`，**行数不参与判定** —— 账本缺行、schema 却已到位时，迁移器会把非幂等的 SQL 重放一遍（0049 在 dev 库就会报 `column already exists` 并整事务中止，0050 也落不了）；
- 存量迁移大多是 drizzle-kit 生成的**线性一次性** SQL（裸 `ADD COLUMN` / `CREATE INDEX` / `CREATE TABLE`），「指望重放已应用迁移来自愈」在本仓库不成立。

## Decision

1. **账本是唯一真源**：`vocab_migrations.__v2_release_migrations` 决定「什么已应用」，**不指望重放已应用迁移来自愈**——存量 SQL 非幂等是线性设计的既定事实，修库走账本，不走 SQL 重放。
2. **journal `when` 严格递增 + 字段齐备**：`_journal.json` 每条目必须携带 `version` / `breakpoints`，`when` 严格大于前一条。已由 `verify-schema-drift` 的 `analyzeMigrationJournal` 机器守卫（`1d08668` 落地）。
3. **快照链必须闭合到最新**：`meta/` 快照必须覆盖末条 journal 条目，否则 `db:generate` 会把已应用迁移重放成一条全新伪迁移。已由同文件 `verifyGenerateIsNoOp` 机器守卫（在一次性沙箱里跑 `drizzle-kit generate`，非 no-op 即 fail）。
4. **新迁移（`MIGRATION_IDEMPOTENCY_CUTOVER_IDX = 51` 起）一律手写 + DDL 幂等**：`drizzle-kit generate` 只用于产快照与校验；若用它产迁移，入库前必须人工改写为幂等（`ADD COLUMN IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` + `ADD` / `DROP POLICY IF EXISTS` + `CREATE` / `DROP TRIGGER IF EXISTS` + `CREATE`）。机器化：`verify-schema-drift` 的 `analyzeMigrationIdempotency` 逐 `--> statement-breakpoint` 语句 lint，命中即 fail；数据回填等无法机械幂等化的语句用紧邻的 `-- @idempotency-waive: <理由>` 豁免。**cutover 之前（≤0050）的迁移是历史，不参与 lint。**
5. **账本缺行 → 对账，不改已发 SQL**：schema 被 `db:push` / 手工改过的库，用 `scripts/reconcile-migration-ledger.ts` 对账——`report` 逐条列出 `applied (exact when)` / `applied (different when)` / `missing`，`adopt --to <tag|idx> [--write]` 为缺失条目生成带 `WHERE NOT EXISTS` 守卫的 INSERT（默认 dry-run）。**禁止**回头修改已发迁移的 `.sql` / tag / 文件名 / journal 顺序来让重放变幂等。
6. **RLS 验收的完成判据 = 账本行数与 journal 条目数一致**：`run-rls-acceptance-migrations` 除既有 `auth.uid()` / `relrowsecurity` 检查外，断言 `migrationCount === entries.length` **且** `max(created_at) === max(entry.when)`——静默跳迁移的双保险，已机器化。

## Consequences

- ✅ 账本缺行的库有明确自愈路径（对账工具），不需要打开「改已发迁移」的先例。
- ✅ 静默跳迁移从此有两条独立机器判据（journal 严格递增守卫 + 验收行数/最大值断言）。
- ✅ 新迁移保持可重跑，与仓库既有的手写幂等线（0021/0023/0024/0028/0047/0050）一致。
- ⚠️ 幂等 lint 只管 cutover 之后的迁移；≤0050 的存量非幂等 SQL 原样保留（这是 D1 的明确定稿，不是遗漏）。
- ⚠️ 对账 `adopt` 只补账本行，**不校验 schema 实际形状**——它修的是「账本落后于 schema」，不是「schema 与账本不符」；后者需要人工判断（见 `adopt-release-baseline.ts` 的前置表检查先例）。
- ⚠️ waiver 是人工判断的出口，不提供自动识别；`-- @idempotency-waive:` 必须带理由，review 时逐条看。
