# ADR-0041: 葫芦冲刺——L1 词书上的阶段性冲刺计划容器

- **Status**: Accepted
- **Date**: 2026-10-06
- **References**: ADR-0004 §6（L3 不参与 FSRS 的红线同源纪律）、ADR-0005（L3 边界）、ADR-0019 §2（L1 速刷不进会话：<5s/词节奏不容会话开销）、ADR-0020（遗忘 = 挂起 + 快照回写先例）、ADR-0036 §4 修订（显式模式：不选该模式 ⇒ 分支不可达）、`docs/design/葫芦背书法-完备设计-2026-10-06.md`（下称「完备设计」，实现唯一权威口径）
- **上游**: 2026-10-06 葫芦背书法引入设计/实现计划/深度设计稿三稿 + 可行性复验（完备设计 §二 R1–R8 为对三稿的八处修正）

## Context

用户需要一个**阶段性冲刺**能力：考前若干天，把一整本 L1 词书按页推进、页级检索闸门（默认 80%）、多轮滚动、只记轮次耗时。它既不是 `review`/`cram`/`preview`/`zen`/`ladder` 中任何一个的变体，也不能被它们表达——那五个模式都按 FSRS 到期或全量练习取卡，没有「整批词按页推进 + 轮次」这个粒度。

复验发现三稿中有 8 处口径与代码现状不符，其中 1 处（挂起恢复）会写坏 FSRS 可见状态。完备设计 §二 R1–R8 是这 8 处的修正，本 ADR 的 Decision 4/5/6 与之一致。

结构事实（逐条核实过）：

- `sessions.mode` 的 CHECK 只认 `review/cram/preview/l2_drill`（`src/db/schema.ts:344`），且 `idx_sessions_one_active` 的「坐次」语义与「跨周计划」粒度错位。
- `l3_sessions` 的类型枚举与抽样对象是 `context_id`，不是词。
- 批量取词的唯一出口 `GET /review/queue?mode=preview&wordIds=` 会先 `getOrCreateTodaySession` **INSERT 一行 `sessions`**，且词书锚定默认词书——有副作用，不可复用。
- `words` / `wordbooks` 都没有 direction 列（方向只存在于 `word_l2_content`/`l3_sources`/工单/试卷）。

## Decision

1. **葫芦 = L1 词书上的阶段性冲刺计划；独立两张新表**（`hulu_plans` / `hulu_rounds`，迁移 0050），**不进 `sessions`**（枚举 + 坐次语义两条理由）、**不进 `l3_sessions`**（它的世界是语境不是词）。**不改任何已有表**；回退 = `DROP TABLE hulu_rounds, hulu_plans;`，无数据搬迁。
2. **零 FSRS 写入是结构性保证**：两张新表无 FSRS 列（无 stability / difficulty / retrievability / due），服务层不引用 `review.service`、不写 `review_logs`、不写 `user_word_progress`、不调 `submitAnswer`。唯一碰到既有数据的地方是第 5 条的**可选、默认关闭**挂起开关，它在构造上隔离。
3. **显式第 6 个复习模式**：`reviewModes` 数组末位加 `{ key: "hulu", ... }`，与 `zen`/`练习`/`阶梯` 并列。**不选该模式 ⇒ 分支不可达**（沿 ADR-0036 §4 修订的先例：不用全局布尔开关，因为它会被误开且制造第二个真源）。**不改** `ReviewSession.tsx` / `DrillSession.tsx` / `LadderReviewSession.tsx` / `useReview.ts`。
4. **词集创建时定格**（`word_ids uuid[]`）：整本词书（`direction` **仅标签、不过滤词集** —— `words`/`wordbooks` 无 direction 列，R6）。之后词书增删不影响计划；渲染只缩不换（已删词的定格位置只缩不换）。
5. **可选挂起开关（默认关）**：自研最小实现——`ReviewRepository` 两个新方法（`bulkSuspendByWordIds` / `restoreSuspendSnapshot`，经本 ADR 批准为该类第 9/10 个 `state` 写点）+ 计划行 `suspend_snapshot jsonb` 快照。**不复用** `ForgettingService` 的批次日志（它走 `review_logs`），**恢复 = 快照回写**（逐行写回挂起前 state，且仅当该行当前仍为 `suspended`），**禁止**统一恢复成 `'review'`——那会让 `new`/`learning`/`relearning` 的行伪装成 review 态，改变 `review` 队列行为。
6. **会话恢复走 localStorage + 24h + 独立前缀** `vocab:hulu:sprint:<planId>`：沿用现行机制（经典复习 `vocab:review:session:`、阶梯 `vocab:review:ladder:review`），**ADR-0036 §6 的「30 分钟」文本以代码现状为准**（实际是 localStorage + 24h）。读时校验 `planId`/`roundNo` 与服务端一致，不一致即弃。

## Consequences

- ✅ 回退面最小：两张新表 + 一组新端点 + 一个显式模式项；`DROP TABLE hulu_rounds, hulu_plans;` 即回到今天。
- ✅ 「另外五个模式一个字节都不差」由结构保证：新表无 FSRS 列、服务不引用 `review.service`、挂起默认关且恢复走快照回写。
- ✅ OpenAPI breaking 门禁只遍历基线 paths，纯新增端点不会触发（`scripts/verify-openapi-breaking.ts:315-377`）。
- ⚠️ **stale active 计划**（考完不完成也不放弃）会让挂起的词一直挂起——本期不做自动过期，P2 在计划页对 `exam_date` 已过的 active 计划显示提示横幅，提醒用户放弃。
- ⚠️ 轮次耗时 = 墙钟 `ended_at - started_at`（R5），**中断不切开**；跨夜/跨天的长中断会虚高。这是已知且接受的口径代价，由缩时曲线的免责声明覆盖，不为它建段表。服务端把 `elapsed_seconds` 夹取到 `[0, 86400×7]`。
- ⚠️ 页级明细、词级通过历史、错题导出均**刻意不建**（完备设计 §4.3）：失败页不留记录，「没通过」是页级比例事件，不接错题库（错题库 = `attempts(outcome='wrong')` 派生视图，ADR-0019 §1）。
- ⚠️ 挂起范围含 `new`（与一键遗忘排除 `new` 的语义不同：有快照即安全，且目标是整批退出到期队列）。交错安全（与一键遗忘、手动挂起互不伤）的逐条论证见完备设计 §六。
