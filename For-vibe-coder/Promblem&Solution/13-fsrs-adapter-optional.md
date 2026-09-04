# M6: FSRS adapter 默认 stub 运行期才炸

## 问题现象

`createServices()` 的 `fsrsAdapter` 是可选参数，默认值是运行时抛错的 stub。配置错误延迟到生产才暴露，且报成 500。

## 根因分析

**文件**: `src/services/index.ts` (修复前)

```typescript
export interface ServiceDeps {
  fsrsAdapter?: FsrsAdapterFn;  // ← 可选
}

export function createServices(deps: ServiceDeps = {}) {
  const fsrsAdapter: FsrsAdapterFn = deps.fsrsAdapter ?? (() => {
    throw new Error("FSRS adapter not configured");  // ← 运行期才炸
  });
  // ...
}
```

## 后果

1. **延迟失败**：服务能正常构造，bug 在第一次真实复习时才炸
2. **错误码误导**：`Error` 不是 `AppError`，`errorToResponse` 映射成 500 INTERNAL
3. **信息丢失**：errorToResponse 吞掉 message，运维看不到 "FSRS adapter not configured"

## 解决方案

`fsrsAdapter` 改为**必填**（去掉 `?`），TS 编译期强制注入：

```typescript
export interface ServiceDeps {
  fsrsAdapter: FsrsAdapterFn;  // ← 必填，TS 编译期拦截
  loadWeights?: (wordbookId: string) => Promise<number[] | null>;
}

export function createServices(deps: ServiceDeps) {
  // 如果调用方忘了传 fsrsAdapter，TS 编译报错
  // 不再需要默认 stub
}
```

## 验证方式

- `tsc --noEmit` 在 `createServices({})` 不传 fsrsAdapter 时报错
- typecheck 全绿

## 关联文件

- `src/services/index.ts`
- `src/services/review.service.ts` (ReviewServiceDeps)
