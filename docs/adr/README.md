# Architecture Decision Records (ADR)

## Phase 3 ADR Index

| ADR | Topic | Phase |
| --- | --- | --- |
| [0007](./0007-l3-context-space-foundation.md) | L3 confirmed owner/manual context-space foundation | Phase 3A |
| [0008](./0008-l3-proposal-review-pipeline.md) | L3 proposal review and confirm pipeline | Phase 3B |
| [0009](./0009-l3-import-proposal-builder.md) | L3 deterministic import-to-proposal builder | Phase 3C |
| [0010](./0010-l3-read-model-graph-api.md) | L3 read model and graph API | Phase 3D |
| [0011](./0011-l3-recommendation-proposal-builder.md) | L3 recommendation proposal builder | Phase 3E |
| [0012](./0012-frontend-host-decision.md) | Frontend host decision and minimal L3 shell | Phase 4B |

## Current Closed Baseline

`main@ab68e3c` is the current closed baseline for Phase 3E plus the standalone
L1 vocabulary review package.

- `main@9f9702c` remains the Phase 3E code and CI Node 24 green runtime
  baseline.
- `main@403438c` records Phase 3E as closed.
- `main@ab68e3c` adds and merges the L1 review package, closing the separate
  L1 document/package delivery.
- `main@167785a` records the closed baseline governance state used as the
  Phase 3F cross-contract regression starting point.
- Phase 3F adds regression-only coverage for the import -> proposal -> confirm,
  recommendation -> proposal -> confirm, recommendation generation, and L3
  read graph boundaries. It must not expand L3 runtime features.
- Phase 3G seals route-level HTTP/API contracts for `/api/l3/imports/*`,
  `/api/l3/proposals*`, `/api/l3/recommendations*`, and `/api/l3/graph`.
  It is regression-only: routes stay thin service callers, request bodies stay
  camelCase, and 400/404/409/422 error semantics are covered without adding
  runtime features or migrations.
- Phase 3H adds the frontend integration consumption contract for Phase 4A.
  It defines UI surfaces, API consumption, UI state machines, error UX,
  view-model guidance, command rules, cache invalidation, and Phase 4A
  acceptance criteria without changing backend runtime behavior.
- Phase 4A.0 records that this repository currently has no frontend host and
  adds a backend-safe L3 frontend consumption scaffold: typed API client,
  error normalization, state/cache helpers, and contract tests. It does not add
  backend endpoints, migrations, UI framework dependencies, or L1/L2/FSRS
  behavior changes.
- Phase 4A.1 hardens the frontend contract scaffold as a framework-agnostic
  consumption layer: complete L3 endpoint wrappers, robust error normalization,
  cache invalidation signals, state helpers, frontend validation guards, and
  dependency-purity tests. It remains backend-only and adds no routes,
  migrations, UI host, or framework dependencies.
- Phase 4B creates the first frontend host: a minimal Vite + React +
  TypeScript shell under `src/frontend`. It reuses `src/l3/frontend/contract.ts`
  through a browser adapter, adds placeholder Import/Proposal/Recommendation/
  Graph surfaces, and does not add backend endpoints, migrations, active L3
  semantics, graph algorithms, or server-side static serving.
- Phase 4C wires the first real L3 frontend loop: raw import -> pending proposal
  preview -> proposal queue/detail -> validate/confirm/reject. It reuses the
  existing frontend client and contract helpers, keeps confirm as the only
  active L3 upgrade trigger, and does not add backend endpoints, migrations,
  recommendation UI, graph visualization, or L1/L2/FSRS behavior changes.
- Phase 4C.1 hardens that loop with explicit import form validation, safer
  import/proposal item summaries, ordinal item rendering, busy-action disabling,
  normalized error details fallback, and static API-boundary tests. It remains a
  frontend-only hardening pass with no backend, migration, recommendation,
  graph visualization, or L1/L2/FSRS expansion.
- Phase 4D.1 wires the minimum recommendation queue UI: generate/list/filter/
  detail plus accept/reject. `link_gap` acceptance shows the proposal bridge and
  opens proposal review without implying an active link. It remains frontend
  only, with no backend, migration, graph visualization, recommendation
  algorithm, or L1/L2/FSRS expansion.
- Phase 4D.2 wires the minimum graph read surface UI: local query controls,
  `client.getGraph`, stats, nodes, edges, empty/error states, and proposal
  confirm stale-signal consumption. It remains frontend only, with no backend,
  migration, graph visualization library/editor, or L1/L2/FSRS expansion.
- Phase 4D.3 hardens the existing frontend closed loop with smoke coverage for
  Import -> Proposal Review -> confirm -> Graph stale, Recommendation
  `link_gap` -> Proposal Review -> confirm -> Graph edge readback, shared
  409/422 error semantics, cache/stale signal matrix behavior, and API
  boundary checks. It remains frontend/test/doc only with no backend,
  migration, graph visualization, context/word/source full page, or L1/L2/FSRS
  expansion.
- Phase 4E adds read-only Context Detail, Word Space, and Source Space pages.
  They use `L3FrontendClient`, local required-field validation,
  `L3ErrorMessage`, and the proposal-confirm active-read stale signal. A
  successful read clears read stale only. The phase adds no backend endpoints,
  migrations, graph visualization library, L3 editor, MCP agent UI,
  recommendation/import semantic changes, or L1/L2/FSRS expansion.
- Phase 4F hardens the existing L3 frontend runtime UX contract. It records
  Vite frontend build as the automated runtime smoke gate, keeps browser smoke
  as a manual checklist because no DOM/browser test dependency exists, expands
  static API-boundary coverage to all L3 frontend pages/components/state/view
  models, and locks error, loading, empty-state, handoff, and stale/cache
  semantics without backend, migration, graph visualization, UI framework,
  router, global state, recommendation, import parser, MCP, LLM, dictionary, or
  L1/L2/FSRS changes.
- Phase 4G adds a read-only SVG graph visualization MVP to the existing Graph
  page. Nodes and edges come only from the `client.getGraph` response, the
  existing stats/list fallback remains, node/edge selection is local display
  state, deterministic layout is frontend-only, and the phase adds no backend
  endpoint, migration, dependency, graph editing, persisted layout, active L3
  mutation path, recommendation/import semantic change, MCP, LLM, dictionary,
  or L1/L2/FSRS behavior change.

Historical red CI runs on `19906f3` and the temporary Phase 3E PR branch are
closed as Node 20 workflow incompatibilities with `dependency-cruiser@18`; they
are superseded by the Node 24 workflow fix in `main@9f9702c`.

## Repository Governance

- Protect `main` so pull requests require the CI workflow to pass before merge.
- Keep the Phase 3E migration order intact:
  `drizzle/0009_magenta_captain_flint.sql` ->
  `drizzle/0010_hesitant_mojo.sql`. Do not squash these migrations into
  earlier files.
- The current `l1-vocab-review-package.zip` is accepted in Git history for this
  delivery. If future review packages keep growing or need repeated updates,
  publish them through GitHub Releases, CI artifacts, or Git LFS instead of
  repeatedly committing large zip binaries.

本目录记录 vocab-observatory-v2 的架构决策。每个 ADR 描述一个决策的 Context / Decision / Consequences。

> 同步策略：本目录是 ADR 的**唯一权威源**。codebase-memory 的 `manage_adr` 存一份
> 合并镜像（供多 agent 检索），但本地文件为最终真相。修改 ADR 后须同步到 codebase-memory。

## 索引

| ADR | 主题 | 阶段 |
|-----|------|------|
| [0001](./0001-layered-architecture.md) | 分层架构与领域边界（dependency-cruiser 强制） | Phase 0/1 |
| [0002](./0002-dual-track-fsrs-isolation.md) | 双轨 FSRS 隔离（L1 速刷 / L2 持久化） | Phase 2A |
| [0003](./0003-llm-provider-and-l2-extension.md) | LLM Provider + L2 扩展两阶段闭环 | Phase 2B |
| [0004](./0004-purpose-stack-patterns-philosophy.md) | 目的 / 技术栈 / 工程模式 / Tradeoff / 设计哲学（含 L3 前瞻） | Phase 0→2B |
| [0005](./0005-l3-context-space-boundary.md) | L3 语境空间边界——不属于 user_word_l2_progress / 不参与 FSRS / 独立 l3_ 表族 | Phase 2C→3 |
| [0006](./0006-l2-composer-contract-freeze.md) | L2 Composer 合同冻结（not chat / collocation 必词典落地 / external-prompt 非持久 / Phase 2E 不引入 L3） | Phase 2E |

## 并行 agent 必读

若你是被派到本项目的并行 agent，**至少**读 ADR-0004 的 §6 PHILOSOPHY：
- L1/L2/L3 调度隔离
- L3 不参与 FSRS
- Agent 写入必须 pending review

这三条是不可妥协的架构红线。

此外，**写 L3 相关代码前必读 ADR-0005**：`user_word_l2_progress` 上的
`l3_pending` / `l3_self_assessments` 列**不是** L3 语境空间主模型，L3 必须用独立
`l3_` 表族实现。
