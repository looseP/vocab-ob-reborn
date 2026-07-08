# M7: ReviewCard 构造时传假 word 数据

## 问题现象

`ReviewService.submitAnswer` 构造 `ReviewCard` 时，word 的 slug/title/lemma 全传空串，下游拿到空数据。

## 根因分析

**文件**: `src/services/review.service.ts` (修复前)

```typescript
const card = new ReviewCardEntity(
  progress,
  { id: progress.word_id, slug: "", title: "", lemma: "" },  // ← 假数据
);
```

`findProgressForUpdate` 的 SQL 没有 JOIN words 表取这些字段，所以无法填真值。

## 后果

- `card.wordRef.slug` 返回空串
- 任何依赖 slug/title/lemma 的下游逻辑拿到空数据
- 领域实体的不变量被破坏（ReviewCard 应该总是持有真实 word 数据）

## 解决方案

`findProgressForUpdate` 的 SQL JOIN words 表取 slug/title/lemma：

```sql
SELECT uwp.*, w.content_hash,
       w.slug AS word_slug, w.title AS word_title, w.lemma AS word_lemma
FROM user_word_progress uwp
JOIN words w ON w.id = uwp.word_id
WHERE uwp.id = $1 FOR UPDATE
```

`ProgressWithContentHash` 接口增加字段：
```typescript
export interface ProgressWithContentHash extends UserWordProgressRow {
  content_hash: string;
  word_slug: string;
  word_title: string;
  word_lemma: string;
}
```

Service 用真实数据构造：
```typescript
const card = new ReviewCardEntity(
  progress,
  { id: progress.word_id, slug: progress.word_slug,
    title: progress.word_title, lemma: progress.word_lemma },
);
```

## 验证方式

- 单元测试验证 SQL 含 `word_slug`、`word_title`、`word_lemma`
- 单元测试验证 ReviewCard 拿到真实 word 数据

## 关联文件

- `src/repositories/review.repository.ts` (findProgressForUpdate)
- `src/repositories/interfaces.ts` (ProgressWithContentHash)
- `src/services/review.service.ts`
