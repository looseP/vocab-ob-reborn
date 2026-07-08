# M3: timedQuery 死代码 + logger 文档谎言

## 问题现象

`timedQuery` 函数定义了但从未被调用，`logger.ts` 注释引用了不存在的 `LoggedRepository` 类。可观测性是虚假承诺——生产环境无慢查询检测。

## 根因分析

**文件**: `src/observability/timing.ts` + `src/repositories/base.ts`

```typescript
// timing.ts — 定义了但没人调用
export async function timedQuery<T>(operation, sqlPreview, fn) { ... }

// base.ts — query() 直接调用 executor.query，无计时包裹
protected async query<T>(text, params) {
  const result = await this.executor.query(text, params);  // ← 无 timedQuery
  return result.rows as T[];
}

// logger.ts — 注释引用幻影类
// "Slow query detection (>100ms) is handled by LoggedRepository wrapper"
//  ↑ LoggedRepository 在整个代码库中不存在！
```

## 后果

- 所有 DB 查询是黑盒：无慢查询告警、无错误归因到具体 SQL
- 文档与代码严重不符，误导读者以为可观测性已就绪

## 解决方案

在 `BaseRepository.query()` 和 `queryOne()` 内部用 `timedQuery` 包裹：

```typescript
protected async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return timedQuery(
    this.constructor.name,   // operation 名（类名）
    text,                     // SQL 前 200 字符用于日志
    async () => {
      const result = await this.executor.query(text, params);
      return result.rows as T[];
    },
  );
}
```

同时修复 logger.ts 注释，删除对不存在的 `LoggedRepository` 的引用。

## 验证方式

- `grep -rn "timedQuery" src/` 确认 base.ts 调用了它
- `grep -rn "LoggedRepository" src/` 确认无残留引用
- 设置 `LOG_LEVEL=debug` 运行测试，观察 stderr 有查询日志输出

## 关联文件

- `src/repositories/base.ts`
- `src/observability/timing.ts`
- `src/observability/logger.ts`
