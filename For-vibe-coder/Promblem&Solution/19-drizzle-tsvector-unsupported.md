# I3: Drizzle 不原生支持 tsvector 类型

## 问题现象

`drizzle-kit pull` 把 `words.search_vector`（tsvector 生成列）标记为 `unknown("search_vector")`，附带 TODO 注释。

## 根因分析

**文件**: `src/db/schema.ts` (pull 生成)

```typescript
// drizzle-kit pull 生成的代码
searchVector: unknown("search_vector").generatedAlwaysAs(sql`to_tsvector(...)`),
```

Drizzle ORM 不原生支持 PostgreSQL 的 `tsvector` 类型，pull 时 fallback 到 `unknown()`。虽然 `unknown` 能工作（该列是 GENERATED ALWAYS AS，不需要写入），但类型不精确。

## 解决方案

用 `customType` 定义 tsvector 类型：

```typescript
import { customType } from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType() { return "tsvector"; },
});

// schema.ts 中替换
searchVector: tsvector("search_vector").generatedAlwaysAs(sql`to_tsvector(...)`),
```

## 验证方式

- `tsc --noEmit` 全绿
- Drizzle 查询不报类型错误

## 注意

该列是 `GENERATED ALWAYS AS ... STORED`，不需要也不允许手动写入，所以类型精度影响有限。customType 只是让类型签名更干净。
