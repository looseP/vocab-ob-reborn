# M-NEW-3: createRepositories 循环依赖

## 问题现象

`createRepositories` 从 `@/index` 导入，而 `@/index` 又 re-export 了 services（services 依赖 createRepositories），形成循环依赖。

## 根因分析

```
依赖环：
  index.ts → services/review.service.ts → index.ts (createRepositories)
  index.ts → services/note.service.ts   → index.ts (createRepositories)
  index.ts → services/index.ts          → index.ts (createRepositories)
```

```typescript
// index.ts 顶部定义 createRepositories
export function createRepositories(tx?: PoolClient) { ... }

// index.ts 底部 re-export services
export { createServices } from "./services";

// services/review.service.ts 从 index 导入
import { createRepositories } from "../index";  // ← 循环！
```

## 当前为何能工作

`createRepositories` 是 `function` 声明（hoisted），且定义在 `index.ts` 文件顶部。ESM 的 live binding 让函数在模块求值后可被引用。但这依赖加载顺序的偶然正确性，是脆弱的。

## 后果

- 如果未来把 `createRepositories` 改成 `const` 箭头函数（不 hoist），启动时崩溃
- 打包器（esbuild/vitest）的循环处理在不同模式下行为可能不一
- 测试与生产行为可能漂移

## 解决方案（待实施）

把 `createRepositories` 抽到独立模块 `src/repositories/factory.ts`：

```typescript
// src/repositories/factory.ts
import type { PoolClient } from "pg";
import { WordRepository } from "./word.repository";
// ... 其他 repository

export function createRepositories(tx?: PoolClient) { ... }
```

Services 从 `factory.ts` 导入（不再从 `@/index`），`index.ts` 仅 re-export：
```typescript
// services/review.service.ts
import { createRepositories } from "../repositories/factory";

// index.ts
export { createRepositories } from "./repositories/factory";
```

## 验证方式

- `grep -rn "from.*index.*createRepositories" src/services/` 确认无循环导入
- typecheck + test 全绿

## 关联文件

- `src/index.ts`
- `src/services/review.service.ts`
- `src/services/note.service.ts`
- `src/services/index.ts`
