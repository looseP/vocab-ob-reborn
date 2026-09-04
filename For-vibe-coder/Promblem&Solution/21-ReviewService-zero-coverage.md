# T1: ReviewService 4 个核心方法零测试覆盖

## 问题现象

`ReviewService` 的 `submitAnswer`、`skip`、`suspend`、`undo` 四个核心方法 **0 行代码覆盖**，无任何测试调用过 ReviewService。

## 根因分析

**文件**: `tests/services.test.ts`

测试覆盖了 WordService、NoteService、WordbookService、StatsService，唯独没有 ReviewService。原因是 ReviewService 构造函数需要 `ReviewServiceDeps { fsrsAdapter, loadWeights }`，而测试文件没有提供 mock fsrsAdapter。

集成测试（`review-concurrency.test.ts`）的 7 个测试只测了 word count、findBySlug、findPublic、findSlugs、withTransaction(words.count)、getDashboardSummary——**没有任何一个测试调用 submitAnswer/skip/suspend/undo**。

## 后果

- H1 事务修复（submitAnswer 用 createRepositories(tx)）无测试证据
- skip/suspend/undo 的编排逻辑（幂等检查 → FOR UPDATE → 持久化）无验证
- ReviewService 是最复杂、最关键的服务，却是唯一零覆盖的服务文件

## 解决方案（待实施）

### 1. ReviewService 单元测试

提供 mock fsrsAdapter + mock loadWeights：

```typescript
const mockFsrsAdapter: FsrsAdapterFn = vi.fn(() => ({
  difficulty: 0.3, dueAt: "2026-01-08", logDueAt: "2026-01-08",
  elapsedDays: 7, scheduledDays: 7, retrievability: 0.9,
  stability: 1.5, state: "review", nextPayload: {},
}));

const mockLoadWeights = vi.fn(async () => null);

const service = new ReviewService({
  fsrsAdapter: mockFsrsAdapter,
  loadWeights: mockLoadWeights,
});
```

mock `withTransaction` 让它直接执行回调，mock `createRepositories` 返回 mock repos。

### 2. 集成测试

在真实 DB 上测试 submitAnswer/skip/suspend/undo 的事务原子性：
- 并发两个相同 idempotencyKey 的 submitAnswer，第二个返回 idempotent
- skip 后 skip_count 递增
- suspend 后 state 变 suspended
- undo 后 progress 恢复到 previous_snapshot

## 验证方式

- `review.service.ts` 覆盖率从 0% 提升到 ≥80%
- 集成测试新增 4 个用例

## 关联文件

- `tests/services.test.ts` (需新增 ReviewService 测试)
- `tests/review-concurrency.test.ts` (需新增集成测试)
- `src/services/review.service.ts`
