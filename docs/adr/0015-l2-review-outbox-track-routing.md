# ADR-0015: L2 复习闭环 Outbox track='l2' 事件路由

- **Status**: Accepted
- **Date**: 2026-08-25（FR-12 接线1 落地）
- **Phase**: Phase 2E → FR-12
- **References**: ADR-0002（双轨 FSRS 隔离）、ADR-0005（L3 边界）、l2-drill spec §七

## Context

FR-12 要求 L2 复习应答（`L2ReviewService.answerWithinTx`）完成后，必须通过
Outbox 事件触发 `CrossTrackService.checkL2FailureCascade`（L2→L1 弱信号检测），
**但不递增 `cards_seen`，不触发 L1 effect 链，不触发 L2 transition**。

此前的 `review.answer.recorded.v1` 事件 payload 只有 L1 语义——worker 处理时
无条件调用 `incrementCardsSeenFromOutbox` + `findProgressForOutbox` + L1 cascade
检查 + L2 transition。如果 L2 应答也走这条路径，会导致：

1. `cards_seen` 被错误递增（L2 应答不是"看了一张卡"，而是辨析/产出训练）
2. L1 cascade 逻辑被错误触发（L2 失败不等于 L1 识别能力衰退——可能只是
   synonym 集合偏难）
3. L2 transition 被重复触发（L2 应答已有独立的 FSRS 调度路径，不走 transition）

## Decision

### 1. 在事件 payload 上加 `track` 字段（加性演进）

`reviewAnswerRecordedPayloadSchema` 新增可选字段：

```ts
track: z.enum(["l1", "l2"]).optional().default("l1"),
```

- 存量事件无此字段 → 解析时缺省 `'l1'`（向后兼容）
- 新事件由 service 层在入队时显式设置 `track: 'l1'` 或 `track: 'l2'`

### 2. Worker 按 track 分支路由

`ReviewOutboxWorker` 在 `dispatchEffect` 中检查 `payload.track`：

| track | 触发的 effect | 跳过的 effect |
|-------|-------------|-------------|
| `'l1'`（默认） | `cards_seen` 递增 + L1 cascade + L2 transition | — |
| `'l2'` | `l2_weak_signal`（调 `CrossTrackService.checkL2FailureCascade`） | `cards_seen` / L1 cascade / L2 transition |

### 3. L2ReviewService 入队时显式设置 track='l2'

`L2ReviewService.answerWithinTx` 在 `outbox.enqueue` 时构造 payload：

```ts
payload: {
  version: 1,
  reviewLogId,
  progressId,
  sessionId,
  userId,
  wordbookId,
  wordId,
  track: "l2",  // ← 红线：L2 应答事件必须标记 track='l2'
}
```

### 4. l2_weak_signal 效应的幂等性

`checkL2FailureCascade` 只在 L2 行 recent_ratings 最后 3 个都是 `again` 时
调用 `reviewRepo.markL1WeakSignal(userId, wordbookId, wordId, true)`。该 UPDATE
是幂等的（`true → true` 是 no-op）。即使 outbox 重放，也不会重复触发或翻转回 `false`。

## Tradeoffs

- **加字段 vs 新事件类型**：选择加 `track` 字段而非新建
  `l2.review.answer.recorded.v1` 事件类型。理由——两个 track 共享 reviewLogId /
  progressId / sessionId / userId / wordbookId / wordId 六元组，只是下游效应不同。
  新事件类型会导致 dedupe key 空间分裂（同一 reviewLog 在 L1/L2 各入一条），
  且 worker 需要注册两套 handler。加字段 + 分支路由更经济。

- **默认 'l1' vs 必填**：选择 `optional().default("l1")`。理由——存量 outbox
  表中已有的事件行没有 `track` 字段，JSON 解析时必须能安全缺省为 `'l1'`，
  否则 worker 重启后会因 schema 校验失败而卡住整个队列。

- **L2 弱信号 vs L1 cascade 强信号**：L2→L1 是弱信号（只 mark flag，不 re-card），
  L1→L2 是强信号（pause/resume）。理由——L2辨析失败 ≠ L1识别衰退（可能只是
  synonym 集合偏难），强制 re-card L1 会打断用户的 L1 速刷节奏。弱信号让用户
  自行决定是否 re-grind L1。见 ADR-0002 decision-2。

## Consequences

- ✅ 存量 L1 事件零行为变化（`track` 缺省 `'l1'`，走原路径）
- ✅ L2 应答不再错误递增 `cards_seen`（sessions 表统计不被污染）
- ✅ L2 失败只标记 `l1_weak_signal=true`，不触碰 L1 的 due_at / needs_recheck / state
- ✅ Worker 单点分支路由，新增 track 不需要新 handler 注册
- ⚠️ 后续若新增 L3 track，需在 worker `dispatchEffect` 中补 `track === 'l3'` 分支
- ⚠️ `track` 字段是 string enum，不向后兼容旧版本 worker 二进制（但本项目无此约束）
