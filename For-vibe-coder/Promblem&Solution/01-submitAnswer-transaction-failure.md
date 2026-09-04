# H1: submitAnswer 事务完全失效

## 问题现象

`ReviewService.submitAnswer` 声称在单个事务内执行（advisory lock → FOR UPDATE → UPDATE + INSERT），但实际上所有查询走各自的独立池连接，事务形同虚设。

## 根因分析

**文件**: `src/services/review.service.ts` (修复前)

```typescript
// 修复前 — 错误代码
async submitAnswer(input, factory: RepositoryFactory) {
  return withTransaction(async (tx) => {
    const repos = factory.create();  // ← BUG: factory 不持有 tx
    // ...
  });
}
```

`RepositoryFactory` 在 `createServices()` 中以 `new RepositoryFactory()`（无参）创建，其 `tx` 为 `undefined`。`factory.create()` 产出的 Repository 的 `executor` 回退到 `getPool()`（全局池），而非 `withTransaction` 借出的 `tx` 连接。

**实际执行的连接状态**:
- 连接 A (tx): `BEGIN` → 空事务 → `COMMIT`（什么都没做）
- 连接 B: `pg_advisory_xact_lock`（归还池后锁立即释放）
- 连接 C: `SELECT idempotency_key`（独立事务）
- 连接 D: `SELECT ... FOR UPDATE`（行锁归还池后释放）
- 连接 E: `UPDATE user_word_progress`（独立提交）
- 连接 F: `INSERT review_logs`（独立提交）

## 后果

- **幂等检查失效**: advisory lock 不持有，并发相同 key 可同时通过
- **行锁失效**: FOR UPDATE 锁不跨语句，并发答题造成 lost update
- **数据不一致**: UPDATE + INSERT 不在同一事务，INSERT 失败时 UPDATE 已提交
- **进度与日志不一致**: 破坏 FSRS 状态机与 undo 快照可恢复性

## 解决方案

```typescript
// 修复后 — 正确代码
async submitAnswer(input: SubmitAnswerInput) {
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);  // ← FIX: 用 tx 创建 repos
    // 后续所有 repos 调用共享同一 tx 连接
  });
}
```

同时删除了 `RepositoryFactory`（它是一个无法被正确使用的伪抽象），`submitAnswer` 不再接收 `factory` 参数。

## 验证方式

- `requireTx()` 在事务方法首行调用，确保 `this.tx` 非空
- 单元测试验证"无 tx 时抛 BusinessRuleError"
- 代码审查确认 `createRepositories(tx)` 在 `withTransaction` 回调内创建

## 关联文件

- `src/services/review.service.ts`
- `src/repositories/base.ts` (requireTx)
- `src/db/transaction.ts` (withTransaction)
