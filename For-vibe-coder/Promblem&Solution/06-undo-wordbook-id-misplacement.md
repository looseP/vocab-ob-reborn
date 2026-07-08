# H-NEW-1: undoReviewLog 把 progress_id 当 wordbook_id 传入

## 问题现象

`undoReviewLog` 的幂等日志 INSERT 中，`wordbook_id` 列被填成了 `progress_id`，导致外键约束违反，整个 undo 事务回滚。

## 根因分析

**文件**: `src/repositories/review.repository.ts` (第一轮修复引入)

```typescript
// undoReviewLog 的 idempotency log INSERT
await this.query(
  `INSERT INTO review_logs (
     user_id, word_id, wordbook_id, progress_id, session_id, ...
   ) VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, ...)`,
  [
    userId,
    rpcRow.out_word_id,
    rpcRow.out_progress_id,  // ← BUG: 这是 progress_id 不是 wordbook_id！
    rpcRow.out_progress_id,  // progress_id
    sessionId,
    ...
  ],
);
```

参数 `$3`（wordbook_id 位置）传的是 `rpcRow.out_progress_id`，而 `undo_review_log` RPC 不返回 `wordbook_id`。代码注释自承问题：`// wordbook_id — we don't have it from RPC; will need progress lookup`，但这个 lookup 从未实现。

## 后果

- `review_logs.wordbook_id` 是 `NOT NULL` + 外键指向 `wordbooks(id)`
- 传入一个 progress_id UUID 几乎不可能匹配任何 wordbook → 外键约束违反
- 整个 undo 事务（含已成功的 RPC undo）回滚 → **undo 功能在带 idempotencyKey 的路径下基本不可用**

## v1 如何处理

v1 (`app/api/review/undo/route.ts:232-264`) 在 RPC 成功后专门 fetch 了 restored progress 行：
```typescript
const { progress: restoredProgress } = await fetchRestoredProgress(tx, result.out_progress_id);
// 然后用 restoredProgress!.wordbook_id 填入 INSERT
```

## 解决方案（待实施）

在 INSERT 前查询 progress 行获取真实 wordbook_id：
```typescript
const progressRow = await this.queryOne<{ wordbook_id: string }>(
  `SELECT wordbook_id FROM user_word_progress WHERE id = $1`,
  [rpcRow.out_progress_id],
);
const wordbookId = progressRow?.wordbook_id;
```

或让 `undo_review_log` RPC 增加 `out_wordbook_id` 返回值。

## 验证方式

- 集成测试：undo 操作在真实 DB 上成功执行
- 测试验证 review_logs.wordbook_id 与 user_word_progress.wordbook_id 一致

## 关联文件

- `src/repositories/review.repository.ts` (undoReviewLog 方法)
- v1: `app/api/review/undo/route.ts` (参考实现)
