# M2: getDb() 不随 resetPool() 重置

## 问题现象

`getDb()` 缓存了 Drizzle 实例（`_db`），但 `resetPool()` 只清 `_pool` 不清 `_db`。测试/多环境切换时拿到失效的 Drizzle 实例（持有已 end() 的 pool）。

## 根因分析

**文件**: `src/db/client.ts` + `src/db/connection.ts`

```typescript
// client.ts — 缓存 _db
let _db: DrizzleDB | null = null;
export function getDb() {
  if (!_db) {
    _db = drizzle({ client: getPool(), schema });  // 持有 pool 快照
  }
  return _db;
}

// connection.ts — resetPool 只清 _pool
export async function resetPool() {
  _pool = null;      // 清 pool
  await oldPool.end();
  // ← 没有清 _db！
}
```

**触发场景**（集成测试）：
1. 首次 `getDb()` → `_db` 持有 pool P1
2. `resetPool()` → P1.end()
3. 再次 `getDb()` → `_db` 仍非 null → 返回持有已关闭 P1 的实例
4. 查询 → 操作已关闭 pool → 报错

## 解决方案

```typescript
// client.ts — 新增 resetDb() 同时清 _db 和 _pool
export async function resetDb(): Promise<void> {
  _db = null;        // 清 Drizzle 实例
  await resetPool();  // 清 pg.Pool
}

// 集成测试 afterAll 改用 resetDb()
afterAll(async () => {
  await resetDb();  // ← 替代 resetPool()
});
```

## 验证方式

- 集成测试 afterAll 用 `resetDb()` 而非 `resetPool()`
- 集成测试全绿（7 个测试，真实 DB）

## 关联文件

- `src/db/client.ts`
- `src/db/connection.ts`
- `tests/review-concurrency.test.ts`
