# ADR-003: LLM Provider + L2 扩展两阶段闭环

- **Status**: Accepted
- **Date**: 2026-07-07（Phase 2B 建立）
- **Supersedes**: ADR-002 的 L2 扩展部分（扩展，不否定双轨隔离）
- **Phase**: Phase 2B

## Context

Phase 2A 建立了双轨 FSRS 骨架，但 L2 内容（搭配/语料/同反义）需要 LLM 生成。
要让用户能为一个词请求 L2 扩展，勾选采纳后写入 `word_l2_content` + 刷新 words
JSONB 缓存 + 触发 L2 重卡——且全程不波及 L1。同时要控制 LLM 成本与优雅降级。

## Decision

### 1. LLM Provider：官方 SDK + 薄包装（不用 Vercel AI SDK）

- `openai` SDK：覆盖 OpenAI / DeepSeek / Ollama / 中转站（不同 baseURL）
- `@anthropic-ai/sdk`：Claude 原生（system 单独传 + content 数组）
- 统一 `LlmProvider` 接口（`src/llm/provider.ts`），~300 行胶水层
- 不用 Vercel AI SDK：太重（框架级），项目刻意保持精简依赖；官方 SDK 已负责
  HTTP/重试/SSE/错误码，我们只包统一接口

### 2. L2 扩展两阶段：draft → confirm

- **`generateDraft`**：调 LLM 生成草稿，**不写 DB**（用户先看）。返回结构化结果：
  `{ draft?, raw?, error?: OVER_BUDGET | LLM_ERROR | PARSE_FAILED }`。
  **永不 throw**——失败作为 `error` 字段返回，HTTP 层映射状态码。
- **`confirmDraft`**：用户勾选后**事务性写入**（`withTransaction`）：
  1. insert `word_l2_content` 行
  2. `refreshL2Cache`（聚合 active 行回写 words JSONB 列）
  3. 重算 `l2_content_hash` → `markL2StaleForRecheck`（重触发 L2 卡，**不碰 L1**）

  两阶段分离的理由：LLM 输出不可信，必须人类 review 后才落库；
  draft 阶段不持锁不写库，可安全重试。

### 3. 预算控制 + 优雅降级

- `UsageTracker`（`src/llm/usage-tracker.ts`）：每日 token 预算
  （`LLM_DAILY_TOKEN_LIMIT`，默认 50000），超预算 `generateDraft` 直接返回 `OVER_BUDGET`
- LLM 未配置时 `services.l2content` 为 `undefined`，`/api/l2/:slug/draft` 路由返回 503
- usage 记录失败不阻塞草稿返回（best-effort：`.catch()` 吞 observability 失败）

### 4. content_hash 双轨隔离延续（Phase 2A）

`confirmDraft` 里重算 `l2_content_hash` → `markL2StaleForRecheck`，
**不调 `markL1StaleForRecheck`** → L1 的 `needs_recheck` 不变。双轨隔离在 LLM 扩展链路上同样成立。

## Architecture (Phase 2B 后)

| 层 | fan-in | fan-out | 变化 |
|----|--------|---------|------|
| http (entry) | 5 | — | +L2 路由 |
| services (internal) | 5 | 59 | +L2ContentService |
| llm (core) | 7 | 4 | NEW — provider/parser/usage-tracker/prompts |
| repositories (core) | 41 | 4 | +L2ContentRepository |
| db (core) | 15 | 4 | +content-hash 引用 |

### 新增边界

- services → llm: 7 calls（L2ContentService 调 provider/parser/prompts/usage-tracker）
- llm → db: 1 call（UsageTracker 调 `getPool`——无 arch 规则禁止，`services-no-raw-db-access`
  只约束 services 层，llm 层允许直连只读统计）

### arch 规则验证

- `http-no-llm-direct`: ✅ http 不直连 llm（路由只调 `services.l2content`）
- `http-no-raw-db-access`: ✅ http 不直连 db/repositories

## Tradeoffs

- **LLM usage 当前/目标边界**：当前 UsageTracker 直接读 `llm_usage` 表做日预算，
  是单实例内存无关的共享预算（多实例一致）。目标：未来加 per-user / per-wordbook 配额、
  滑动窗口而非自然日重置、预算预警 hook。
- **draft 不落库**：用户关闭浏览器草稿丢失。可接受——LLM 重生成本低，且避免存储
  未审核 AI 内容污染库。
- **usage 记录 best-effort**：若 `llm_usage` 写入失败，token 不计入预算 → 可能略超预算。
  取舍：不阻塞主流程 > 严格预算。

## Consequences

- ✅ L2 扩展闭环成立，LLM 输出经人类审核才落库
- ✅ LLM 未配置时全系统仍可跑（L1 完整，L2 仅缺扩展能力）
- ⚠️ 草稿不持久，用户需当场确认
