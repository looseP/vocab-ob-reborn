# ADR-0023: 多设备 = 在线优先、服务器权威、不做离线同步

- **Status**: Accepted
- **Date**: 2026-09-12
- **References**: ADR-0022（单 owner 多设备）、ADR-0002（双轨 FSRS）、CONTEXT.md（Device / Server authority）
- **上游**: 2026-09-12 后端完备性拷问会话（第一轮）

## Context

多设备（桌面 + 手机 + 平板）访问同一份数据。前端现状**零离线能力**：Vite SPA、无 service worker/manifest、无 IndexedDB、无全局缓存层（`src/frontend/state/l3CacheSignals.ts:4-10` 显式 `phase_4c_local_state_no_global_cache`），本地持久化只有主题与最近搜索。

若引入离线队列/后台同步，就必须定义**同一张卡在两台设备上被评分的合并规则**——而 FSRS 的 stability/difficulty 是路径依赖的：两次并发 `good` 不能简单相加，并发 `again` 与 `easy` 更难定义。这是本项目最贵的一类复杂度。

## Decision

1. **在线优先**：所有读写直达服务器；客户端只持有派生视图，不持有权威状态。
2. **服务器权威**：数据库行是唯一真相源；无离线队列、无后台同步、无冲突解决。
3. **多设备共享同一 owner 身份**：设备是**会话层**概念（各设备一条 `auth_sessions`，可单独撤销），**不是数据分区**，也不是同步副本。

## Tradeoffs

- **离线可用 vs 冲突复杂度**：接受"断网即不可用"，换取 FSRS 语义不被并发合并污染。
- **本地持久缓存 vs 一致性**：不做持久缓存，避免"缓存看着新、服务器已变"的二义；代价是每次进入都要拉取（延迟由既有预算与超时护栏兜住）。
- **设备粒度 vs 会话粒度**：撤销按会话 token（`auth_sessions`），不做"设备指纹/信任设备清单"。

## Consequences

- ✅ FSRS 保持单写者语义，调度正确性不依赖客户端协调。
- ⚠️ **断网不可用必须被明确告知**（否则用户会在通勤路上以为应用坏了）。
- ⚠️ 多设备并发写**全局内容表**（`word_l2_content` 无 user_id / 无 RLS，`src/db/schema.ts:869-890`）的语义仍需在实现层明确（当前靠 advisory lock 与 append 语义，非唯一约束）。
- ⚠️ 将来若要离线，须先立新 ADR 定义 FSRS 并发合并规则；本决策不构成"永久不做"的承诺。
