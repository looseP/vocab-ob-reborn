# H2: counterField 动态列名无白名单（SQL 注入面）

## 问题现象

`ReviewRepository.saveAnswer` 用字符串拼接构造动态列名，无白名单校验。

## 根因分析

**文件**: `src/repositories/review.repository.ts` (修复前)

```typescript
// 修复前 — 危险代码
const counterField = `${input.rating}_count`;  // ← 直接拼接
await this.query(
  `UPDATE user_word_progress SET ... ${counterField} = ${counterField} + 1 ...`,
  [...]
);
```

`input.rating` 类型是 `ReviewRating`（`"again"|"hard"|"good"|"easy"`），TypeScript 编译期会阻止非法值。但 Repository 是运行时边界——如果调用方做 `as ReviewRating` 强转、或 JSON 反序列化绕过类型检查，任意字符串会被拼进 SQL 列名位置。

## 后果

- 如果 rating 形如 `"x; DROP TABLE users; --"`，直接 SQL 注入
- 如果 rating 是非法列名，PG 报 `column does not exist`（UPDATE 回滚）

## 解决方案

```typescript
// 修复后 — 白名单映射
const RATING_COUNTER_MAP: Record<ReviewRating, string> = {
  again: "again_count",
  hard: "hard_count",
  good: "good_count",
  easy: "easy_count",
};

// 使用前校验
const counterField = RATING_COUNTER_MAP[input.rating];
if (!counterField) {
  throw new ValidationError(`Invalid rating: ${input.rating}`, "rating");
}
// counterField 来自白名单常量，非用户输入，安全拼接
```

## 验证方式

- 单元测试传 `rating: "malicious; DROP TABLE" as any`，验证抛 `ValidationError`
- 单元测试传合法 rating `"again"`，验证 SQL 含 `again_count = again_count + 1`

## 关联文件

- `src/repositories/review.repository.ts`
- `src/errors/index.ts` (ValidationError)
