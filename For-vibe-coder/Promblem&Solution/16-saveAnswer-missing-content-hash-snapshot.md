# M-NEW-4: saveAnswer 漏更新 content_hash_snapshot

## 问题现象

`saveAnswer` 的 UPDATE 语句缺少 `content_hash_snapshot` 字段更新，v1 有此更新，v2 是相对 v1 的语义退步。

## 根因分析

**v1** (`app/api/review/answer/route.ts:144`):
```typescript
const updatePayload = {
  content_hash_snapshot: progress.content_hash,  // ← v1 刷新快照
  difficulty: scheduling.difficulty,
  // ...
};
```

**v2** (`src/repositories/review.repository.ts` saveAnswer):
```sql
UPDATE user_word_progress
SET difficulty = $1, due_at = $2, interval_days = $3,
    lapse_count = lapse_count + $4, last_rating = $5, ...
    -- ← 缺少 content_hash_snapshot = $N
WHERE id = $12
```

## 后果

答题后 progress 行的 `content_hash_snapshot` 不刷新为当前 word 的 content_hash：
- `findStaleCards` 和 `markStaleForRecheck` 依赖 `content_hash_snapshot` 与 `words.content_hash` 对比检测内容漂移
- 答完不刷新快照 → 快照保留旧值 → 下次 `findStaleCards` 仍检出陈旧（这条路径恰好还能工作）
- 但如果 word 内容在答之前已变更，答完后应刷新为"用户实际看到的内容对应的 hash"。v1 这么做了，v2 没做 → `needs_recheck` 机制行为偏差

## 解决方案（待实施）

saveAnswer 的 UPDATE 增加 `content_hash_snapshot`：

```sql
UPDATE user_word_progress
SET difficulty = $1, due_at = $2, ...,
    content_hash_snapshot = $N,  -- ← 新增
    updated_at = $M
WHERE id = $K
```

参数从 `progress.content_hash`（findProgressForUpdate 返回的 word 当前 hash）传入。

## 验证方式

- 集成测试：答题后 progress.content_hash_snapshot === word.content_hash
- 单元测试验证 SQL 含 content_hash_snapshot

## 关联文件

- `src/repositories/review.repository.ts` (saveAnswer)
- v1: `app/api/review/answer/route.ts`
