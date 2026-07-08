# I2: drizzle-kit pull 生成空字符串默认值语法错误

## 问题现象

`drizzle-kit pull` 反向生成 schema 时，空字符串默认值被错误生成为 `.default(')`（缺少闭合引号），导致 TypeScript 解析失败。

## 根因分析

**文件**: `src/db/schema.ts` (pull 生成)

```typescript
// drizzle-kit pull 生成的错误代码
contentMd: text("content_md").default(').notNull(),  // ← 未终止字符串
```

`notes.content_md` 的 DEFAULT '' 在 PG 里是空字符串，但 drizzle-kit 0.31.10 把它错误地生成为单引号 `')` 而非 `''')`。

影响 3 处：`notes.content_md`、`word_annotations.content`。

## 解决方案

手动修复生成的 schema.ts，把 `.default(')` 改为 `.default('')`：

```typescript
// 修复后
contentMd: text("content_md").default('').notNull(),
```

用 `replace_all` 一次性修复所有 3 处。

## 验证方式

- `tsc --noEmit` 全绿（无解析错误）
- `grep "default(')" src/db/schema.ts` 无匹配

## 注意

这是 drizzle-kit 的已知 bug。每次重新 `drizzle-kit pull` 后需要检查是否有此类问题。
