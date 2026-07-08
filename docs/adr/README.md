# Architecture Decision Records (ADR)

## Phase 3 ADR Index

| ADR | Topic | Phase |
| --- | --- | --- |
| [0007](./0007-l3-context-space-foundation.md) | L3 confirmed owner/manual context-space foundation | Phase 3A |
| [0008](./0008-l3-proposal-review-pipeline.md) | L3 proposal review and confirm pipeline | Phase 3B |
| [0009](./0009-l3-import-proposal-builder.md) | L3 deterministic import-to-proposal builder | Phase 3C |
| [0010](./0010-l3-read-model-graph-api.md) | L3 read model and graph API | Phase 3D |
| [0011](./0011-l3-recommendation-proposal-builder.md) | L3 recommendation proposal builder | Phase 3E |

## Current Closed Baseline

`main@ab68e3c` is the current closed baseline for Phase 3E plus the standalone
L1 vocabulary review package.

- `main@9f9702c` remains the Phase 3E code and CI Node 24 green runtime
  baseline.
- `main@403438c` records Phase 3E as closed.
- `main@ab68e3c` adds and merges the L1 review package, closing the separate
  L1 document/package delivery.

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
