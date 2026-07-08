# ADR-005: L3 语境空间不属于 user_word_l2_progress

- **Status**: Accepted
- **Date**: 2026-07-07（Phase 2C 前瞻清理）
- **Phase**: Phase 2C → Phase 3
- **References**: ADR-0004（§5.3 / §6.1 / §6.2）、ADR-0002

## Context

`user_word_l2_progress` 表当前带有两列从 Phase-0 self-growing 草案遗留下来的字段：

- `l3_pending boolean DEFAULT false`
- `l3_self_assessments jsonb DEFAULT '[]'`

全项目 grep 结果：除 schema 定义、`UserWordL2ProgressRow` 类型、测试 fixture
（`tests/services/cross-track.test.ts` 的 `makeL2Row`）和 migration 快照外，
**没有任何 service / repository / route / domain 逻辑读取或写入这两个字段**。它们是死字段。

风险：后续并行 agent 看到 `l3_*` 前缀的列挂在 L2 进度表上，可能误以为这就是 L3 语境空间的
主模型，从而把 L3 业务逻辑耦合到 `user_word_l2_progress`——违反 ADR-0004 §6.1（L1/L2/L3 调度隔离）
与 §6.2（L3 不参与 FSRS）。

## Decision

采用**方案 B：保留字段 + 显式注释**，不生成 migration。具体：

### 1. 字段保留但不提升为 L3 主模型

- `l3_pending` / `l3_self_assessments` 维持现状（死字段），仅作为行形状的一部分存在。
- 在 `src/db/schema.ts`、`src/domain/index.ts`、`tests/services/cross-track.test.ts` 三处加
  `⚠️ L3 BOUNDARY` 注释，明确声明：这两列不是 L3 语境空间主数据，当前无业务代码使用，
  保留仅为避免 migration churn。

### 2. L3 的真正归属：独立 `l3_` 表族（Phase 3）

Phase 3 的 L3（agent 自生长知识链）**必须**通过独立表族实现，初步命名：

| 表 | 职责 |
|----|------|
| `l3_sources` | L3 语料/来源（原文、出处、可信度） |
| `l3_contexts` | L3 语境实例（一个词在一个 source 中的真实用法） |
| `l3_proposals` | agent 产出的待审 proposal（status: pending → confirmed/rejected） |

这些表与 `user_word_l2_progress` **无外键、无共享列、无 join 语义**——L3 是知识层，
不是用户进度层。L3 通过 `word_id` 与 `words` 关联，不通过 L2 进度行关联。

### 3. 三条不可妥协的边界（写入 arch 规则 / spec）

1. **L3 不属于 `user_word_l2_progress`**——L2 进度表只管 L2 的 FSRS 调度状态。
2. **L3 不参与 FSRS**——L3 的"何时触发"由 agent 策略决定，不读不写 stability/difficulty/retrievability。
3. **L3 写入必须经 proposal → review → confirm**（ADR-0004 §6.3），agent 不直接写权威表。

### 4. 迁移策略

- 现在（Phase 2C）：不删字段，不加字段，0 migration。
- Phase 3 L3 落地时：新建 `l3_sources / l3_contexts / l3_proposals` 三表（一次 migration）。
- 届时再评估 `l3_pending / l3_self_assessments` 是否仍有用：
  - 若确认无用 → 单独一条 drop-column migration（`0005_*.sql` 或后续编号）。
  - 若 L3 表族需要某个 L2 侧的轻量 flag → 显式重新定义其语义并补测试。
  - **不允许**在未明确语义前把 L3 主逻辑挂到这两列上。

## Tradeoffs

- **保留死字段 vs 立即删除**：选择保留。理由——Phase 2C 刚完成 331 测试稳定，删列需 migration
  + 回滚风险 + 测试改动，而字段本身零运行成本（boolean/jsonb default，无索引、无约束）。
  注释已足以阻止误用。等 Phase 3 L3 表族设计敲定后再统一处理，决策成本更低。
- **注释 vs arch 规则**：当前用注释 + 本 ADR 表达边界。Phase 3 落地时应补 dependency-cruiser
  规则，禁止 `services/l3*` 依赖 `repositories/l2-progress`（反向亦然），把边界从文档升级为机器守护。

## Consequences

- ✅ 消除"l3_* 列 = L3 主模型"的歧义，并行 agent 不会误耦合
- ✅ 0 migration churn，331 测试不受影响
- ✅ L3 表族设计被提前锁定为独立 `l3_` 前缀，Phase 3 可直接开工
- ⚠️ 死字段短期保留，需在 Phase 3 收尾时显式清理（本 ADR 记录在案）
- ⚠️ 边界目前仅靠注释 + ADR 守护，Phase 3 需补 arch 规则机器化

## Phase 3A.1 Clarification

ADR-0005's proposal/review/confirm requirement applies to agent-generated or otherwise unreviewed L3 writes. Phase 3A's owner/manual HTTP API is a confirmed foundation-write surface: the authenticated owner explicitly creates trusted source/context/occurrence/link rows.

There is no `l3_proposals` table in Phase 3A because this phase does not implement agents, LLM parsing, recommendation, MCP, or bulk import parsing that would create unreviewed candidates. Phase 3B/3C should add `l3_proposals` before any automated or agent-generated L3 evidence can become authoritative.
