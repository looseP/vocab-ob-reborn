# ADR-004: V2 目的、技术栈、工程模式与设计哲学（含 L3 前瞻）

- **Status**: Accepted
- **Date**: 2026-07-07（Phase 2B 后复核汇总）
- **Phase**: Phase 0 → Phase 2B，并向 L3 / Phase 2C 前瞻
- **References**: ADR-001 / ADR-002 / ADR-003

## Context

Phase 0/1/2A/2B 已完成，271 测试全过，arch:check 零违规。后续 L3 与 Phase 2C 将由
多 agent 并行开发。本 ADR 汇总 V2 的根本目的、技术栈选型、贯穿全代码库的工程模式、
关键 tradeoff、以及不可妥协的设计哲学——作为并行 agent 的统一上下文，避免上下文丢失
导致架构漂移。

---

## 1. PURPOSE — V2 是什么

V2 是 vocab-ob 的**独立后端**，从 V1（Next.js 全栈）中剥离重建。它承载：

- **review**：FSRS 间隔重复调度（L1 速刷 + L2 持久化双轨）
- **L2 transition**：L1 稳定后晋升 L2 的单向继承
- **LLM**：L2 内容扩展（搭配/语料/同反义）的两阶段 draft→confirm 闭环
- **后续 L3**：agent 自生长知识链（向 Phase 2C / L3 演进）

V2 不含 UI。它对外只暴露 HTTP JSON API，供 V1（或任何前端）调用。
独立后端的意义：业务逻辑可独立演进、独立测试、不被 Next.js 渲染层耦合。

---

## 2. STACK — 技术栈

| 类别 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript（ESM） | 类型安全 + 生态 |
| HTTP 框架 | Hono | 轻量、Web 标准、路由/中间件清晰 |
| ORM / SQL | Drizzle ORM + pg | 类型安全 SQL，无魔法；`drizzle-kit` 管 migration |
| 数据库 | PostgreSQL | JSONB + 事务 + advisory lock 支撑 review 并发 |
| 间隔重复 | ts-fsrs | FSRS v5 实现，算法权威 |
| LLM | `openai` + `@anthropic-ai/sdk`（官方 SDK） | 见 ADR-003，不用 Vercel AI SDK |
| 校验 | Zod v4 | 入参/出参 schema 校验 |
| 测试 | Vitest 4 + @vitest/coverage-v8 | 原生 ESM、快、TDD 友好 |
| 架构守护 | dependency-cruiser | 强制分层依赖方向（见 ADR-001） |
| 运行时 | tsx（dev）/ Node | — |

**依赖克制原则**：能不引就不引。每个新依赖必须证明官方 SDK / 现有工具无法覆盖。
（这也是拒绝 Vercel AI SDK 的根本原因。）

---

## 3. ARCHITECTURE — 架构总览

```
HTTP routes ──► services ──► repositories ──► db (PostgreSQL)
                 │
                 ├──► llm       (L2ContentService 调 provider/parser/prompts/usage)
                 ├──► fsrs      (ReviewService 经 FsrsAdapterFn 调 ts-fsrs)
                 └──► domain    (纯实体，被各层引用，零出向)
errors / observability：零出向，任意层引用
```

关键解耦点：
- **ReviewService 与 L2TransitionService 解耦**：ReviewService 通过可选依赖
  `checkAndTransition` 注入 L2 晋升逻辑，不直接 import L2TransitionService。
  `createServices` 构造一次 L2TransitionService，把它的方法传给 ReviewService。
- **L2ContentService 两阶段**：`generateDraft` 不写 DB（调 LLM + 预算检查 + 解析，
  返回结构化结果，永不 throw）；`confirmDraft` 事务写入
  （insert + refreshL2Cache + 重算 l2_hash + markL2StaleForRecheck）。
- **fsrs 经 adapter 函数注入**：`FsrsAdapterFn` 把 ts-fsrs 计算与 ReviewService 解耦，
  ReviewService 不直接 import ts-fsrs，可替换/测试。

---

## 4. PATTERNS — 贯穿全库的工程模式

### 4.1 withTransaction 事务边界
所有写操作走 `withTransaction(async (tx) => { const repos = createRepositories(tx); ... })`。
一个 service 方法 = 一个事务，不跨方法持锁。Repository 方法 `requireTx()` 强制事务上下文（H4）。
services 层禁止直接调 `db/sql|connection|client|...`（arch 规则强制）。

### 4.2 Repository factory
`createRepositories(tx?)` 创建一组 repo，可绑定 `PoolClient`（事务内）或不绑定（只读）。
从 `src/index.ts` 抽出到 `repositories/factory.ts` 以打破循环依赖（M-NEW-3 fix）。

### 4.3 Service 可选依赖注入
`createServices(deps)` 接收可选依赖：`llmProvider` / `usageTracker` 未注入时
`services.l2content` 为 `undefined`，路由返回 503。`fsrsAdapter` 必填（M6 fix，编译期强制）。
`loadWeights` 可选，默认返回 null。这让系统在 LLM 缺失时仍完整可跑。

### 4.4 Structured AppError
统一错误层级（`src/errors/index.ts`）：`AppError` 抽象基类，子类声明 `httpStatus` + `code`。
`NotFoundError(404)` / `ValidationError(422)` / `ConflictError(409)` /
`UnauthorizedError(401)` / `ForbiddenError(403)` / `BusinessRuleError(422)` /
`DbConnectionError(503)`。`errorToResponse()` 统一映射到 HTTP，Route 层无需逐路由 try/catch。
pg 连接错误按 SQLSTATE / errno 检测 → 503。

### 4.5 TDD
测试与实现同步，271 测试覆盖 domain / errors / fsrs / repositories / services / http / llm。
集成测试（`tests/review-concurrency.test.ts`）连真实 PostgreSQL 验证并发与 6767 词导入。
lint-staged 在 commit 前跑 `tsc --noEmit`，CI 跑 `verify`（typecheck + arch:check + test）。

---

## 5. TRADEOFFS — 关键取舍

### 5.1 L2 transition best-effort 不回滚 L1
`submitAnswer` 主事务先提交 L1 调度结果，`checkAndTransition` 其后执行。
若 L2 插入失败（非 23505），L1 已提交不回滚。理由：L1 是用户答题的真相，L2 是派生优化，
派生失败不应否定主答。靠幂等（下次满足条件再试）补偿，而非事务回滚。

### 5.2 LLM usage 边界（当前 vs 目标）
- **当前**：UsageTracker 直接读 `llm_usage` 表做单自然日 token 预算（多实例一致），
  超预算 `generateDraft` 返回 `OVER_BUDGET`。usage 记录 best-effort（`.catch()` 吞失败）。
- **目标**：per-user / per-wordbook 配额、滑动窗口而非自然日重置、预算预警 hook、
  严格模式（usage 写入失败则拒绝草稿）。
- **取舍**：当前不阻塞主流程 > 严格预算；可能略超预算（usage 写失败时）。

### 5.3 L3 将同库隔离而非独立物理 DB
L3（agent 自生长）计划复用同一 PostgreSQL 实例，通过 schema/表前缀隔离
（如 `l3_*` 表 / `agent_*` 表），而非独立物理 DB。理由：
- 同库可 JOIN，L1/L2/L3 联动查询成本低
- 运维简单（一套备份/迁移/监控）
- 隔离靠表 + arch 规则 + 事务边界，不靠物理库
- 代价：L3 写入压力影响主库——但 L3 是低频 agent 写，非热路径，可接受

### 5.4 draft 不落库
LLM 草稿不持久化，用户关闭浏览器即丢。可接受——LLM 重生成本低，且避免未审核 AI 内容污染库。

---

## 6. PHILOSOPHY — 设计哲学（并行 agent 必读）

### 6.1 保持 L1/L2/L3 调度隔离
L1（速刷）/ L2（持久化辨析）/ L3（agent 自生长）是三种认知任务，**调度必须物理隔离**：
独立调度表、独立 content_hash、独立 weights、独立重卡机制。
任何联动都是**单向继承**（L1→L2→L3），不允许反向污染。改 L2 不碰 L1，改 L3 不碰 L1/L2。
这是双轨/三轨设计的根本，arch 规则与 content_hash 分层共同守护。

### 6.2 L3 不参与 FSRS
L3 是 agent 自生长知识链，**不走 FSRS 调度**。FSRS 只管 L1/L2 的间隔重复。
L3 的"何时触发"由 agent 策略决定（如知识缺口检测、用户主动请求），不与 FSRS stability/difficulty 耦合。
若未来 L3 需要自己的调度，应建独立调度器，不复用 FSRS。

### 6.3 Agent 写入必须 pending review
任何 agent（L3 / LLM 扩展）产生的写入**必须经人类 review**才能进入权威库。
L2ContentService 的 draft→confirm 就是这一哲学的体现：LLM 草稿不落库，用户勾选才事务写入。
L3 同理：agent 产出先进 `pending` 状态表，人类/规则确认后才提升为 active。
**绝不允许 agent 直接写权威数据**——这是防止 AI 污染知识库的底线。

---

## Consequences

- ✅ 多 agent 并行开发有统一架构上下文
- ✅ L1/L2/L3 隔离哲学明确，避免演进中漂移
- ✅ tradeoff 显式记录，未来回溯有据
- ⚠️ L3 同库隔离要求 arch 规则持续演进（Phase 2C 需补 l3 边界规则）
- ⚠️ agent 写入 pending review 要求 L3 表设计带 status 字段 + 确认流程
