# M1: getWordBySlug 抛匿名类（非 AppError）

## 问题现象

`WordService.getWordBySlug` 在词条不存在时抛出一个匿名 class（继承 Error 而非 AppError），导致 `errorToResponse` 无法正确映射到 404，返回 500。

## 根因分析

**文件**: `src/services/word.service.ts` (修复前)

```typescript
async getWordBySlug(slug: string) {
  const row = await this.words.findBySlug(slug);
  if (!row) {
    throw new (class extends Error {       // ← 匿名类，不是 AppError
      readonly httpStatus = 404;
      readonly code = "NOT_FOUND";
    })(`Word not found: ${slug}`);
  }
  return { word: new Word(row) };
}
```

`errorToResponse` 只检查 `instanceof AppError`：
```typescript
export function errorToResponse(error: unknown) {
  if (error instanceof AppError) { ... }  // ← 不命中匿名类
  return { status: 500, ... };            // ← 落入 500
}
```

## 后果

- 用户看到 500 Internal Server Error 而非 404 Not Found
- `httpStatus` 和 `code` 字段是死字段，永远不会被读取
- 单元测试 `rejects.toMatchObject({ httpStatus: 404 })` 误判为通过（只验证对象有字段，不验证 errorToResponse 映射）

## 解决方案

```typescript
import { NotFoundError } from "../errors";

async getWordBySlug(slug: string) {
  const row = await this.words.findBySlug(slug);
  if (!row) {
    throw new NotFoundError("Word", slug);  // ← AppError 子类，映射到 404
  }
  return { word: new Word(row) };
}
```

## 验证方式

- `errorToResponse(new NotFoundError("Word", "x")).status === 404`

## 关联文件

- `src/services/word.service.ts`
- `src/errors/index.ts` (NotFoundError, errorToResponse)
