# H-NEW-2: NoteService.getOrCreateDefault 在事务外执行

## 问题现象

`NoteService.upsertNote` 的 `getOrCreateDefault`（写操作）在 `withTransaction` 之前执行，与后续 upsert 不在同一事务，回滚时留下孤立 wordbook。

## 根因分析

**文件**: `src/services/note.service.ts`

```typescript
async upsertNote(params: UpsertNoteParams): Promise<UpsertNoteResult> {
  const wordbookId = params.wordbookId
    ?? (await this.wordbooks.getOrCreateDefault(userId)).id;  // ← 事务外！
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);
    const result = await repos.notes.upsert(userId, wordbookId, wordId, contentMd);
    // ...
  });
}
```

`getOrCreateDefault` 在进入 `withTransaction` 之前执行，用的是构造函数注入的 `this.wordbooks`（非 tx 绑定）。如果默认 wordbook 是新建的，创建在独立 autocommit 事务里。

## 后果

1. 默认 wordbook 创建成功但随后的 upsert 事务回滚 → 留下孤立空 wordbook
2. `getOrCreateDefault` 内部可能有副作用（如结束旧 session），逃出事务边界
3. 与 `submitAnswer` 的 `loadWeights`（事务外只读，可接受）不同——`getOrCreateDefault` 是**写操作**

## 解决方案（待实施）

把 `getOrCreateDefault` 移进 `withTransaction` 回调内：
```typescript
async upsertNote(params: UpsertNoteParams): Promise<UpsertNoteResult> {
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);
    const wordbookId = params.wordbookId
      ?? (await repos.wordbooks.getOrCreateDefault(params.userId)).id;
    const result = await repos.notes.upsert(params.userId, wordbookId, params.wordId, params.contentMd);
    return { ok: true, updatedAt: result.note.updated_at, version: result.note.version };
  });
}
```

## 验证方式

- 集成测试：upsert 失败时不留下孤立 wordbook
- 测试验证 getOrCreateDefault 在事务内执行

## 关联文件

- `src/services/note.service.ts`
- `src/repositories/wordbook.repository.ts` (getOrCreateDefault)
