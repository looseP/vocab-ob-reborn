# ADR-0021: needs_recheck 读时派生（"内容已更新"标记的懒计算）

- **Status**: Accepted
- **Date**: 2026-09-11
- **Amends**: 无。不修改 ADR-0002 的双轨调度、不触碰 ADR-0004 §6 红线；`markStaleForRecheck` / `markL1StaleForRecheck` 保留为无调用方的死代码，`needs_recheck` 列与 `idx_progress_recheck` 保留（人工标记仍生效）
- **References**: ADR-0002（双轨 FSRS / content_hash 分层）、ADR-0004 §6（红线）、CONTEXT.md（Review scheduling）、`docs/design/l2-hash-direction-impact-and-decision.md` §1.2 / §6
- **上游**: 2026-09-11 队列"重新核对"能力取证（主 agent）

## Context

队列的"重新核对（内容已更新）"能力**已全部建好，但标记永远拿不到 true**：

- 消费端已就绪：
  - 提权：`src/services/review-queue.ts` `getStateRank`（needsRecheck → stateRank 0，压过 learning/relearning）
  - 分桶/文案：`describeQueuePriority`（bucket `learning`、label「重新核对」、reason「内容已更新，请重看」）
  - 新卡配额排除：`buildReviewQueueBatch`（`state === "new" && !needs_recheck` 才计入配额与 deferred）
  - 映射入口：`src/services/review.service.ts` `toQueueCandidate` 读 `progress.needs_recheck`
- 写入端是故意留空的半成品：
  - `src/repositories/review.repository.ts` `markStaleForRecheck`（标注 @deprecated）/ `markL1StaleForRecheck` —— **全仓无生产调用方**
  - `src/services/cross-track.service.ts` 明确 decision-2：L2 辨析失败只标 `l1_weak_signal`，**绝不碰** `needs_recheck`（既有测试锁死该行为）

数据契约事实（决定本方案的写法）：

- `saveAnswer` 把 `content_hash_snapshot` 与 `l1_content_hash_snapshot` **同时**写成 `$11`，而调用方传的是 `words.content_hash`（**全量** hash）→ "L1 专属"通路当前不可用；
- `words.l1_content_hash` 列存在，但运行时无任何写入者（`computeL1Hash` 在 `src/` 零调用）。

即：写时标记路径要么需要新增 FSRS 写入（撞红线），要么依赖一条尚不存在的数据链。

## Decision

**在读队列时派生 needs_recheck，不做任何写入**（零迁移、零用户数据变更、零 FSRS 写入）：

```
needs_recheck = 行上的值（人工标记，保留兼容）
             || deriveContentStaleness({ contentHash, l1ContentHash, contentHashSnapshot, l1ContentHashSnapshot })
```

精确规则（`src/domain/content-staleness.ts`，纯函数、零出向、零 IO、零时间依赖）：

1. 若 `words.l1_content_hash` 与 `progress.l1_content_hash_snapshot` **都可用** → 比 L1 对；
2. 否则若 `words.content_hash` 与 `progress.content_hash_snapshot` 都可用 → 比全量对；
3. 被判定的那一对里任一侧缺失（NULL / undefined / 空串）→ **不派生**（false）：新卡、未作答的行不得被标为"需重新核对"；
4. 派生结果**只影响队列分桶/排序**；`due_at` / `state` / 任何 FSRS 字段零改动；
5. 快照在用户下次作答时由 `saveAnswer` 既有行为自动刷新 → 标记**自愈**；不"修"这个写入。

### 读取路径（为什么只改一条）

`ReviewService.getQueue`（`src/services/review.service.ts`）：

| 路径 | 走向 | 是否派生 |
|---|---|---|
| review / zen | `findDueCandidates` → `toQueueCandidate` → `buildReviewQueueBatch`（优先级分桶/配额） | ✅ 派生在这里 |
| review / zen 兜底（候选池为空或依赖未装配） | `findDueCards` → `toQueueItem` | ❌ 无载体（见下） |
| cram / preview | `findPracticeCards ?? findDueCards` → `toQueueItem` | ❌ 练习模式（无调度副作用、无优先级元数据） |

- 兜底路径的 DTO（`ReviewQueueItemDto`）**不携带任何优先级/重核字段**，`toQueueItem` 也不做分桶 —— 该路径本就不表达"重新核对"语义；
- 两条查询的 WHERE 逐字相同（`review.repository.ts` 的 findDueCards / findDueCandidates：`state != 'suspended'` + `due_at IS NULL OR due_at <= now()`）⇒ **候选池为空时 findDueCards 必为空** ⇒ 生产 DI 下兜底分支不可能产出非空队列；只有 `findDueCandidates` 未装配时才有数据，而那种降级配置本来就没有任何优先级元数据。
- ⇒ 不存在"同一行在一条路径上 true、在另一条路径上 false"的可见不一致。若未来要让兜底路径也携带该标记，必须先扩展 `ReviewQueueItemDto` 与 HTTP 契约（另立任务）。

## Tradeoffs

- **读时派生 vs 补上写时标记**：写时标记需要在 L2 内容编辑路径（7 条）与导入/精修路径上埋点，并伴随状态迁移（`review → relearning`、`due_at = now()`）——那是**写 FSRS 字段**，撞 ADR-0004 §6；读时派生零写入、零迁移、幂等（重复读结果相同）、可回滚（撤掉派生即回到今天的行为），且标记随作答自愈。
- **降级比全量 hash vs 只比 L1**：只比 L1 需要先补齐 L1 hash 的产出链（写入端 + 存量回填），那是一个带不可逆数据操作风险的独立任务；在那个任务落地前，用全量对比可以立刻把能力从"不可达"恢复到"可用但有噪声"。
- **只改候选池路径 vs 两条路径都改**：见上表。另一条路径没有语义载体，强行"都改"只能靠扩 HTTP 契约，收益不足以承担契约变更成本。
- **人工标记列保留**：`needs_recheck` 列与索引不删（人工/未来写入端仍可用），派生只做 OR 的低优先级补充。

## Consequences

- ✅ "重新核对"从死能力变为可达：内容发生变化的词会被提权到队首，并显示「重新核对 / 内容已更新，请重看」；变更后用户答一次即自愈。
- ✅ 零写入、零迁移、零 FSRS 影响；ADR-0002 的双轨隔离与 ADR-0004 §6 红线不动。
- ⚠️ **(a) 当前用全量 hash 降级判定 ⇒ L2 内容变更也会触发 L1 卡的"重新核对"（暂接受）**。理由：提示无害、不写调度、一次作答即自愈；代价是"L2-only 编辑"会带来一次多余的"重看"提示。观测口径：若重核卡的实际重新作答率极低（多数是误报），说明噪声偏高，应优先推进 (b)。
- ⚠️ **(b) P2 跟进项：补齐 `words.l1_content_hash` 的产出链**（import/精修写入 + 作答改为填 L1 快照 + 存量回填）。补齐后**同一行代码自动升级为 L1 专属判定，无需改动**（判定顺序第 1 条生效，第 2 条自然停用）。
- ⚠️ 死代码仍在：`markStaleForRecheck` / `markL1StaleForRecheck` / `findStaleCards` 保持零调用方。它们会写 `due_at`/`state`，接线前必须重走红线评审；本 ADR 只让"读"侧自洽（接线或删除另立任务）。
