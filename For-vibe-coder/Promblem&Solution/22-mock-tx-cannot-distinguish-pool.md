# T2: mockTx.query === pool.query 无法验证事务绑定

## 问题现象

H4 的 requireTx 测试用 `mockTx = { query: mock.pool.query }` 创建 mock tx，但 mockTx.query 与 mock.pool.query 是**同一个函数引用**，无法区分查询走的是 tx 还是 pool。

## 根因分析

**文件**: `tests/repositories.test.ts` + `tests/helpers/mock-db.ts`

```typescript
// 测试中
const mockTx = { query: mock.pool.query } as never;  // ← 同一个函数！
const txRepos = createRepositories(mockTx);

// BaseRepository
protected get executor(): Pool | PoolClient {
  return this.tx ?? getPool();  // tx 或 pool
}
protected async query(text, params) {
  return timedQuery(this.constructor.name, text, async () => {
    const result = await this.executor.query(text, params);  // ← 调用的是同一个函数
    return result.rows;
  });
}
```

无论 `executor` 返回 `this.tx`（mockTx）还是 `getPool()`（mock.pool），调用的都是 `mock.pool.query`——因为 `mockTx.query === mock.pool.query`。

## 后果

- "有 tx 时不抛错"的验证有效（requireTx 检查 `!this.tx`）
- "查询走 tx 而非 pool"的验证**无效**——如果有人把 `executor` 改成 `return getPool()`（忽略 tx），所有"有 tx"的测试仍会通过
- H4 的核心意图（事务方法必须在真实事务连接上执行）无法被这个 mock 策略验证

## 解决方案（待实施）

让 mockTx 使用**独立的 mock 函数**，与 pool 的 mock 区分：

```typescript
const txQueryFn = vi.fn(async (text, params) => {
  calls.push({ text, params });
  return { rows: nextRows, rowCount: nextRows.length };
});

const poolQueryFn = vi.fn(async (text, params) => {
  throw new Error("Should use tx, not pool!");  // ← pool 调用时抛错
});

const mockTx = { query: txQueryFn } as never;
const mockPool = { query: poolQueryFn, ... };

// 这样如果 executor 错误地返回 pool，测试会因 poolQueryFn 抛错而失败
```

## 验证方式

- 把 `executor` 改成 `return getPool()`（故意破坏 tx 绑定），测试应该失败
- 改回正确实现，测试通过

## 关联文件

- `tests/helpers/mock-db.ts`
- `tests/repositories.test.ts`
- `src/repositories/base.ts`
