# H5: 核心操作缺失（skip/suspend/undo）

## 问题现象

v2 Repository + Service 只覆盖了 `submitAnswer` 主流程，完全缺失 skip/suspend/undo 三个核心复习操作，无法替代 v1。

## 根因分析

v1 在 `app/api/review/` 下有完整端点：
- `skip/route.ts` — 跳过当前卡片（skip_count + 1 + review_log）
- `suspend/route.ts` — 挂起卡片（state = suspended + review_log）
- `undo/route.ts` — 撤销最近一次评分（调用 undo_review_log RPC + 幂等日志）

v2 的 `ReviewRepository` 和 `ReviewService` 都没有实现这三个操作。

## 后果

- v2 只能答题，不能跳过/挂起/撤销，功能不完整
- Route 层迁移时这三个端点无对应 Service 方法

## 解决方案

### Repository 层新增方法

```typescript
// findProgressForSkip — SELECT FOR UPDATE 最小字段
async findProgressForSkip(progressId, userId): Promise<ProgressForAction | null>

// skipCard — UPDATE skip_count + INSERT review_log (action=skip)
async skipCard(progress, userId, sessionId, idempotencyKey): Promise<{reviewLogId}>

// findProgressForSuspend — SELECT FOR UPDATE 最小字段
async findProgressForSuspend(progressId, userId): Promise<ProgressForAction | null>

// suspendCard — UPDATE state=suspended + INSERT review_log (action=suspend)
async suspendCard(progress, userId, sessionId, idempotencyKey): Promise<{reviewLogId}>

// undoReviewLog — 调用 undo_review_log RPC + 插入幂等日志
async undoReviewLog(reviewLogId, userId, sessionId, idempotencyKey): Promise<UndoRpcResult>
```

### Service 层新增方法

```typescript
async skip(input: SkipReviewInput, userId: string): Promise<{ok, idempotent?}>
async suspend(input: SuspendReviewInput, userId: string): Promise<{ok, idempotent?}>
async undo(input: UndoReviewInput, userId: string): Promise<{ok, idempotent?}>
```

三个方法都用 `withTransaction(async (tx) => { const repos = createRepositories(tx); ... })` 模式，复用 `checkIdempotency` 做幂等检查。

## 验证方式

- 12 个单元测试覆盖 skip/suspend/undo 的 SQL 文本和参数
- 测试验证 advisory lock + FOR UPDATE + UPDATE + INSERT 的正确顺序
- 测试验证 undo RPC 成功/失败两种路径

## 对照 v1 的字段一致性

| 操作 | v1 插入 review_logs 的列 | v2 插入的列 | 一致 |
|---|---|---|---|
| skip | rating, state, metadata, progress_id, word_id, wordbook_id, user_id, session_id, reviewed_at, idempotency_key | 同 | ✅ |
| suspend | 同上，state='suspended' | 同 | ✅ |
| undo | 同上，metadata含undone_log_id | 同 | ✅ |

## 关联文件

- `src/repositories/review.repository.ts`
- `src/services/review.service.ts`
- `src/repositories/interfaces.ts`
