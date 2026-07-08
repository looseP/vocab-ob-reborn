# M4: NoteRepository.upsert 三语句非原子

## 问题现象

`NoteRepository.upsert` 执行 3 条语句（findByWord + INSERT ON CONFLICT + INSERT note_revisions）不在同一事务，revision 可能丢失。

## 根因分析

**文件**: `src/repositories/note.repository.ts` + `src/services/note.service.ts`

```
语句 1: SELECT notes WHERE ... (读旧值算 version)
语句 2: INSERT notes ON CONFLICT DO UPDATE (upsert)
语句 3: INSERT note_revisions (版本历史)
```

三步走 pool 的独立连接，各自自动提交。若语句 2 成功但语句 3 失败：
- note 内容已更新但 revision 丢失
- 版本历史不完整，无法回溯

并发两个相同 (user, word, wordbook) 的 upsert 会算出相同 version，ON CONFLICT 后一个覆盖前一个。

## 解决方案

`NoteService.upsertNote` 用 `withTransaction` 包裹整个流程：

```typescript
async upsertNote(params: UpsertNoteParams): Promise<UpsertNoteResult> {
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);  // tx 绑定
    const result = await repos.notes.upsert(userId, wordbookId, wordId, contentMd);
    return { ok: true, updatedAt: result.note.updated_at, version: result.note.version };
  });
}
```

同时 `note.repository.ts` 的 upsert SQL 改为 DB 端原子递增 version：
```sql
DO UPDATE SET
  content_md = EXCLUDED.content_md,
  version = CASE
    WHEN notes.content_md != EXCLUDED.content_md
    THEN notes.version + 1    -- ← DB 端原子递增，防竞态
    ELSE notes.version
  END
```

## 验证方式

- 单元测试验证 withTransaction 被调用
- 并发场景测试（两个并发 upsert，version 不冲突）

## 关联文件

- `src/services/note.service.ts`
- `src/repositories/note.repository.ts`
