# H3: findDueCards 列名歧义

## 问题现象

`findDueCards` 在运行时报 `column reference "id" is ambiguous` 错误，功能完全不可用。

## 根因分析

**文件**: `src/repositories/review.repository.ts` (修复前)

```typescript
// 修复前 — 错误代码
const PROGRESS_COLUMNS = `id, user_id, word_id, ...`;

async findDueCards(...) {
  const rows = await this.query(
    `SELECT ${PROGRESS_COLUMNS.replace(/id, /, "id, ")},  // ← 无操作！replace 没生效
            w.id AS w_id, w.slug, w.title, w.lemma
     FROM user_word_progress uwp
     JOIN words w ON w.id = uwp.word_id
     WHERE uwp.user_id = $1 ...`,
    [...]
  );
}
```

`.replace(/id, /, "id, ")` 把 "id, " 替换成 "id, "（相同字符串），是**无操作**。结果 SELECT 出的是裸列名（无 `uwp.` 前缀），而 JOIN 的 `words` 表也有 `id` 列，PostgreSQL 无法确定 `id` 指向哪个表。

## 后果

- `findDueCards` 在真实 DB 上直接报错，复习队列功能不可用
- `findStaleCards`（单表无 JOIN）碰巧不触发，但风格不一致

## 解决方案

```typescript
// 修复后 — 预定义带前缀的常量
const PROGRESS_COLUMNS_PREFIXED = `
  uwp.id, uwp.user_id, uwp.word_id, uwp.wordbook_id, uwp.state,
  uwp.stability, uwp.difficulty, uwp.retrievability, uwp.desired_retention,
  uwp.due_at, uwp.last_reviewed_at, uwp.last_rating, uwp.review_count,
  uwp.lapse_count, uwp.again_count, uwp.hard_count, uwp.good_count,
  uwp.easy_count, uwp.interval_days, uwp.scheduler_payload,
  uwp.content_hash_snapshot, uwp.skip_count, uwp.created_at, uwp.updated_at
`;

// JOIN 查询用 PREFIXED 版
async findDueCards(...) {
  const rows = await this.query(
    `SELECT ${PROGRESS_COLUMNS_PREFIXED},
            w.id AS w_id, w.slug, w.title, w.lemma
     FROM user_word_progress uwp
     JOIN words w ON w.id = uwp.word_id ...`,
    [...]
  );
}

// 单表查询用裸列版（从 PREFIXED 去前缀生成）
const PROGRESS_COLUMNS = PROGRESS_COLUMNS_PREFIXED.replace(/uwp\./g, "");
```

## 验证方式

- 单元测试验证 SQL 含 `uwp.id`、`uwp.user_id` 等前缀
- 单元测试验证 `w.id AS w_id` 别名
- 集成测试在真实 DB 上执行 findDueCards 不报错

## 关联文件

- `src/repositories/review.repository.ts`
