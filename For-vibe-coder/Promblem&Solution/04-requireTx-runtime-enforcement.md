# H4: 事务方法无运行时强制

## 问题现象

`checkIdempotency`、`findProgressForUpdate`、`saveAnswer` 等方法注释声称"must be called inside a transaction"，但没有任何运行时检测。在事务外调用时 advisory lock 立即释放、FOR UPDATE 锁不跨语句、UPDATE+INSERT 不原子。

## 根因分析

**文件**: `src/repositories/base.ts` (修复前)

```typescript
// 修复前 — tx 是可选的，无强制
export abstract class BaseRepository {
  constructor(protected readonly tx?: PoolClient) {}

  protected get executor(): Pool | PoolClient {
    return this.tx ?? getPool();  // 无 tx 时静默回退到 pool
  }

  // 没有 requireTx() 方法
}
```

事务方法没有调用任何断言，即使 `this.tx` 为 undefined 也照常执行（走 pool 的独立连接）。

## 后果

- `checkIdempotency` 在事务外调用 → advisory lock 在语句结束就释放，TOCTOU 竞态恢复
- `findProgressForUpdate` 在事务外调用 → FOR UPDATE 行锁立即释放
- `saveAnswer` 在事务外调用 → UPDATE 已提交但 INSERT 失败时无法回滚

## 解决方案

```typescript
// 修复后 — 增加 requireTx() 运行时断言
export abstract class BaseRepository {
  constructor(protected readonly tx?: PoolClient) {}

  protected requireTx(): PoolClient {
    if (!this.tx) {
      throw new BusinessRuleError(
        `${this.constructor.name} method requires an active transaction — ` +
        `use createRepositories(tx) inside withTransaction()`
      );
    }
    return this.tx;
  }
}

// 每个事务方法首行调用
async checkIdempotency(idempotencyKey: string) {
  this.requireTx();  // ← 无 tx 时立即抛错
  // ...
}
```

## 验证方式

- 8 个事务方法全部首行调用 `requireTx()`
- 单元测试验证"无 tx 时抛 BusinessRuleError"（4 个测试）
- 单元测试验证"有 tx 时不抛错"

## 覆盖的事务方法

| 方法 | requireTx | 说明 |
|---|---|---|
| checkIdempotency | ✅ | advisory lock |
| findProgressForUpdate | ✅ | SELECT FOR UPDATE |
| findProgressForSkip | ✅ | SELECT FOR UPDATE |
| findProgressForSuspend | ✅ | SELECT FOR UPDATE |
| saveAnswer | ✅ | UPDATE + INSERT |
| skipCard | ✅ | UPDATE + INSERT |
| suspendCard | ✅ | UPDATE + INSERT |
| undoReviewLog | ✅ | RPC + INSERT |

## 关联文件

- `src/repositories/base.ts`
- `src/repositories/review.repository.ts`
- `src/errors/index.ts` (BusinessRuleError)
