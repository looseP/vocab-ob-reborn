# ADR-001: V2 后端分层架构与领域边界

- **Status**: Accepted
- **Date**: 2026-07-06（Phase 0/1 建立），2026-07-07 复核
- **Phase**: Phase 0 → Phase 2B（持续生效）

## Context

V1 是一个 Next.js 全栈应用，业务逻辑、数据库访问、UI 揉在一起，且 `createRepositories`
存在循环依赖初始化顺序坑。V2 作为独立后端重建，必须从一开始就确立清晰的分层与依赖方向，
否则 review / L2 / LLM / 后续 L3 多 agent 并行开发会迅速退化为大泥球。

## Decision

### 分层与依赖方向（dependency-cruiser 强制）

```
http  ──►  services  ──►  repositories  ──►  db
            │                ▲
            ├──► llm          │
            ├──► fsrs         │
            └──► domain ◄─────┘  (domain 零出向，被各层引用)
errors / observability：零出向，任意层可引用
```

强制规则（`.dependency-cruiser.cjs`，violation = error）：

| 规则 | 含义 |
|------|------|
| `no-circular` | 任何循环依赖 = error（v1 createRepositories 坑的根因） |
| `db-no-outbound-to-business` | db 基础设施层不得反向依赖 repositories/services/domain |
| `domain-no-outbound` | domain 层零出向依赖（纯实体） |
| `errors-no-outbound` | errors 层零出向（纯错误类型） |
| `services-no-raw-db-access` | services 只能用 `withTransaction`，不得直接调 `db/sql\|connection\|client\|...` |
| `repositories-no-services` | repositories 不得反向依赖 services |
| `http-no-raw-db-access` | http 层必须经 service，不得直连 db/repositories |
| `http-no-llm-direct` | http 层不得直接调 LLM provider（LLM 是业务逻辑） |
| `no-orphans` | 孤立模块 = warn（可能死代码） |

### Repository factory 解循环

`src/repositories/factory.ts` 从 `src/index.ts` 抽出，避免
`index.ts → services → index.ts` 循环。`createRepositories(tx?)` 可绑定
`PoolClient`（事务内）或不绑定（只读）。

### 事务边界

所有写操作走 `withTransaction(async (tx) => { const repos = createRepositories(tx); ... })`。
Repository 方法内部 `requireTx()` 强制必须在事务上下文调用（H4 fix）。
一个 service 方法 = 一个事务，不跨方法持锁。

## Consequences

- ✅ 分层清晰，多 agent 可并行开发不同层
- ✅ arch:check 在 CI 中守住边界
- ⚠️ services 不能直接拿连接池——所有写都必须包进 withTransaction（小幅样板代码）
