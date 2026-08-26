# ADR-0016: L3 语境源适配器接入 L2 Drill 产出自评

- **Status**: Accepted
- **Date**: 2026-08-25（FR-12 接线2 落地）
- **Phase**: Phase 2E → FR-12
- **References**: ADR-0005（L3 边界）、ADR-0015（track='l2' 事件）、l2-drill spec §四

## Context

L2 Drill Mode 的产出自评步（stepIndex=1）需要一个参照例句供用户比对造句质量。
此前的实现（`buildL2ProductionTask`）从词表自带的 `corpus_items` 中取第一条
作为 `referenceExample`——但这些语料是导入时静态附带的，不是用户自己的 L3
语境空间中的真实用法。

FR-12 要求：L2 产出自评步应优先消费 L3 语境空间中该词的真实语境片段，
让用户看到"这个词在我自己的阅读/笔记中是如何使用的"，而不是通用语料的
通用例句。

但 ADR-0005 确立了 L3 语境空间边界红线：
1. L3 不属于 `user_word_l2_progress`
2. L3 不参与 FSRS（不写 stability/difficulty/retrievability）
3. L3 写入必须经 proposal → review → confirm

因此 L2 消费 L3 必须是**只读消费**，且不能引入 L3 → L2 的 FSRS 反向耦合。

## Decision

### 1. 定义 `ContextSource` 端口（domain 层纯接口）

```ts
export interface ContextSnippetLookup {
  userId: string;
  wordId: string;
  limit?: number;
}

export interface ContextSource {
  getContextSnippets(lookup: ContextSnippetLookup): Promise<string[]>;
}
```

- 端口位于 `src/domain/context-source.ts`，是纯接口，零依赖
- `ContextSnippetLookup.userId` 必填——RLS 红线：L3 数据是 user-scoped
- 返回 `string[]`——只取 `l3_contexts.text`（原文片段），不返回
  occurrence / links 等元数据，避免给 task generator 传入过多信息

### 2. 实现 `L3ContextSourceAdapter`（infrastructure 层适配器）

```ts
export class L3ContextSourceAdapter implements ContextSource {
  constructor(deps: L3ContextSourceAdapterDeps = {}) {
    this.txRunner = deps.txRunner ?? withTransaction;
    this.repoFactory = deps.repoFactory ?? createRepositories;
  }

  async getContextSnippets(lookup): Promise<string[]> {
    return this.txRunner(async (tx) => {
      const repos = this.repoFactory(tx);
      const page = await repos.l3Context.listContextsForWord({
        userId: lookup.userId,
        wordId: lookup.wordId,
        limit: lookup.limit ?? 3,
      });
      return page.items.map((item) => item.context.text);
    }, { actorId: lookup.userId });
  }
}
```

- 适配器位于 `src/services/l3-context-source-adapter.ts`
- 自带 `withTransaction` + `actorId=userId`——即使在 L2 事务内被调用，
  也会开一个独立的 L3 只读事务，两个事务都设置同一个 actorId
- 默认 `limit=3`——避免一次拉太多拖慢 L2 队列建步
- `repoFactory` 可注入——测试可用 mock 替换

### 3. `L2DrillService` 注入 `ContextSource`

```ts
export class L2DrillService {
  constructor(deps: {
    fsrsAdapter: L2FsrsAdapterFn;
    loadWeights: ...;
    loadL2Weights?: ...;
    contextSource?: ContextSource;  // ← 新增注入口
  }) {
    this.contextSource = deps.contextSource ?? noopContextSource;
  }

  private async fetchContextSnippets(userId, wordId): Promise<string[]> {
    try {
      return await this.contextSource.getContextSnippets({ userId, wordId });
    } catch {
      return [];  // best-effort：L3 故障不阻塞 L2 队列建步
    }
  }
}
```

- `contextSource` 是可选依赖——未注入时回退到 `noopContextSource`（恒返 `[]`）
- `fetchContextSnippets` best-effort 吞掉所有异常——L3 故障不阻塞 L2
- 只在 `buildStep0Task`（辨析步任务生成）中调用，不影响 FSRS 调度路径

### 4. `buildL2ProductionTask` 优先使用 L3 语境

```ts
export function buildL2ProductionTask(input): L2TaskPayload {
  const l3Reference = input.contextSnippets?.[0];
  const corpusReference = corpusEntries(input.word.corpus_items)[0];
  const reference = l3Reference ?? corpusReference?.text;
  return { ..., referenceExample: reference };
}
```

- 优先取 L3 语境片段（`contextSnippets[0]`）
- L3 无语境时回退到 `corpus_items`（词表自带语料）
- 两者都无 → `referenceExample` 为 `undefined`（产出自评步无参照例句，
  用户自行造句）

### 5. 生产环境接线（`createServices`）

```ts
l2Drill: new L2DrillService({
  fsrsAdapter: deps.fsrsAdapter,
  loadWeights,
  loadL2Weights: deps.loadL2Weights,
  contextSource: deps.contextSource ?? new L3ContextSourceAdapter(),
}),
```

- `ServiceDeps` 新增可选 `contextSource?: ContextSource`
- 生产环境默认注入 `new L3ContextSourceAdapter()`（自带 withTransaction +
  createRepositories，无需额外配置）
- 测试可通过 `ServiceDeps.contextSource` 注入 mock 或 noopContextSource

## Tradeoffs

- **端口 vs 直接注入 repo**：选择定义 `ContextSource` 端口而非直接把
  `L3ContextRepository` 注入 `L2DrillService`。理由——
  1. domain 层（`l2-task.ts`）只能依赖纯接口，不能依赖 repository
  2. 未来 L3 语境源可能切换（如 LLM 生成语境、外部 API），端口让替换零成本
  3. 测试时可用 `noopContextSource` 或 mock，不需要 mock 整个 repository

- **独立事务 vs 共享 L2 事务**：选择独立事务。理由——
  L3 只读查询不需要 L2 的 FOR UPDATE 行锁，独立事务更轻量；
  两个事务都设 actorId=userId，RLS 都能正确过滤；
  L3 查询只 LIMIT 3，不会长时间占用连接。

- **best-effort 吞异常 vs 抛出**：选择 best-effort 吞掉。理由——
  L3 语境是"锦上添花"（有则用 L3 例句，无则用 corpus 回退），
  不应因为 L3 故障阻塞 L2 队列建步。用户更关心"能继续练"而非"例句来自 L3 还是 corpus"。

- **只取 text vs 返回完整 item**：选择只取 `context.text` 字符串。理由——
  domain 层的 task generator 是纯函数，不应接收 occurrence / links 等
  复杂元数据。`referenceExample` 只需要一句话字符串。

## Consequences

- ✅ L2 产出自评步优先使用用户自己的 L3 语境，体验个性化
- ✅ L3 → L2 是只读消费，不引入 FSRS 反向耦合（ADR-0005 红线守住）
- ✅ L3 故障 best-effort 回退到 corpus，不阻塞 L2
- ✅ `ContextSource` 端口可未来扩展（LLM 生成语境、外部 API）
- ✅ 测试可通过 `noopContextSource` 或 mock 完全隔离 L3
- ⚠️ 首次接线后，L2 drill 会多一次 L3 只读查询（LIMIT 3），有轻微延迟
- ⚠️ 如果 L3 语境质量差（如用户导入了低质量语料），产出自评参照例句可能不如
  corpus 精准——但这是用户自己的语境，用户可自行在 L3 编辑器中清理
