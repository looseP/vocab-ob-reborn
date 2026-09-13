# 增量认知 × L3 空间升级：任务分解（外派执行版）

- **日期**：2026-09-11
- **依据**：ADR-0017 / 0018 / 0019 / 0020（`wt-main/docs/adr/`）+ CONTEXT.md 新词条
- **执行方式**：多 agent 外派，按 Wave 分批；同 Wave 内任务互不依赖可并行
- **代码根**：`wt-main/`

---

## 0. 外派通用约束（每个 agent 的 brief 都必须带）

**必读材料**（按序）：`docs/adr/0004` §6（三条红线）→ `docs/adr/0005` → `docs/adr/0008` → 本任务对应的新 ADR（0017-0020）→ `CONTEXT.md` 相关词条。

**通用门禁（完成时必须全绿）**：
- `npm run typecheck`、`npm run arch:check`（depcruise 零违规）
- `npm run test:unit`（含分层覆盖率：domain 85/85/79、service 87/85/75、repository 90/86/75、http 82/81/71；diff 覆盖 ≥85%）
- 涉及 API：`npm run api:governance`；涉及前端：`npm run frontend:build`；涉及迁移：`npm run db:schema:drift`
- **不得**在 `src/` 下新建一级目录（`assertKnownSourceArchitecture` 会直接拒绝）
- 一个 service 方法 = 一个事务（`withTransaction` + `actorId`）；新用户表必须有 RLS policy
- domain 层零出向（纯函数、不 import db/repositories/services）

**门禁取证纪律**（2026-09-12 实证，违反视为未完成）：
1. 本 worktree **无 `origin/main`**：凡用 base 的门禁显式传 `API_CONTRACT_BASE_REF` / `ROUTE_COMPLEXITY_BASE_REF` / `COVERAGE_BASE_REF`；**禁止把 base 指向 HEAD**（区间为空 → 空真）。
2. **任何 PASS 必须在「能行使该分支的 base」上取证**：base 必须早于被验证对象引入。反例（已发生）：新增路由文件 `maxLines` 设 58 而实际 62，用默认 `base=HEAD^` 跑棘轮 → 文件在 base 已存在 → cap 分支未被行使 → 打印 passed 却是空真；换 base=新增前的 ref 立刻红（`62 lines > 58 (bootstrap)`）。
3. **新增文件的 bootstrap 限额取数口径必须与 `measureRouteComplexity` 一致**（含空行；`split(/\r?\n/)` 去尾换行）。禁止用编辑器行数或非空行计数。验证：`ROUTE_COMPLEXITY_BASE_REF=<该文件新增前的 ref> npx tsx scripts/verify-route-complexity.ts`。
4. 不要在 npm 脚本 / gate 配置里**硬编码 base**（`cross-env FOO=HEAD~1` 会覆盖 CI 注入的 env，使 `ci.yml` 的 PR-base 失效——已修的反例）。
5. 报告须区分【本地跑】与【CI 绿】；未在 CI 上跑过的不得写成"CI 通过"。

**并发写者纪律**（同实证）：
6. 触及**共享文件**的任务不得与其他任务同树并发：串行派发，或各自独立 worktree（交付时报 worktree 路径 + base）。共享文件清单（现状，新增共享面须补登）：`src/http/operations.ts`、`src/http/*-response-contract.ts`、`src/schemas/**`、`src/repositories/interfaces.ts`、`src/domain/index.ts`、`tests/http/authorization-registry.test.ts`、`scripts/verify-route-complexity.ts`、`scripts/run-mcp-server.mjs`、`docs/operations/mcp-server.md`、`docs/api/openapi.json`、`src/frontend/api/generated/openapi.ts`。
7. 若确实并行产出：由**主 agent 合并为一个提交**（消息分列交付）；不要要求执行方自行拆分（共享文件交织会留下无法自证的中间态）。
8. 生成物冲突：由**最后完成者**重跑 `api:openapi && api:client:check` 并二次确认幂等（hash 稳定）后再交。

**到期清理项纪律**：
9. 「保留一个契约窗口」必须写进**代码锚点**（schema 注释 + `.describe()` 双载体）：到期版本、删除动作、是否 breaking、可 grep 检索标记。检索标记精确形 `DEPRECATED(<item>)` 以**注释处**为准（`.describe()` 可自然语言展开）。只写在报告/文档里的清理项视为**未落地**。范式：`src/schemas/http/index.ts:596-607`（error-book offset，到期 0.2.0）。

**覆盖率纪律**：
10. 提交前自证：你改的**每个受治理文件** `lines>=85%` 且 `branches>=75%`（`npx vitest run --coverage` 全量口径，附逐文件表）；只跑子集套件不足以代表单文件整体覆盖率。
11. 提交前**不跑** diff 覆盖率门禁（工作树未提交时会 fail-closed）；该门禁由主 agent 提交后以 `HEAD^` 度量。

**UI 卡验收纪律**（2026-09-13 追加，D0–D4 体验补救路线实证）：
12. 凡 UI 卡（新增页面 / 改版 / 视觉修复），交付时**必须**附：
    a. **设计基线条目引用**——改动对应 `docs/design/l3-space/baseline.md` 的哪些条目（体验目标 / 信息层级 / 状态矩阵 / token 映射），无对应条目的视觉决策须在卡内先补基线再动工；
    b. **前后截图对比**——落到工作区 `deliverables/software-company/<audit 目录>/screenshots/`（**截图因体积不入库，仅文档入库**），命名 `<阶段>-after-*.png`；纯重构无视觉变化的须声明并给一张现状截图佐证；
    c. 两者缺一，主 agent **不予收口**（视为未完成，不是"部分完成"）。
13. UI 卡的门禁除通用项外必须含：明暗双主题截图、空/加载/错/满四态中受影响态的截图、移动端宽度（≤480px）截图（凡页面级改动）。

**关键 schema 事实**（防踩坑）：
- `word_l2_content` 是 **word-scoped 全局表**：无 `user_id`、无 RLS、无唯一约束（`src/db/schema.ts:869-883`）；候选池 = 同表 `is_active=false` 行
- L1→L2 晋升已有实现：`L2TransitionService.checkAndTransition`（自动门，`l2-transition.service.ts:125-134`）与 `promoteNow`（手动，`l2-transition.service.ts:224`；HTTP `POST /:slug/promote`）——**提前升级是扩展它，不是新造**
- L1 suspend 已有先例：`review.repository.ts:502`（`metadata={action:"suspend"}`）；L2 无 suspend，用 `l2_paused` + `l2_paused_reason`（CHECK 含 `'manual'`）
- `sessions` 表 `wordbook_id` notNull + mode CHECK 只含 L1/L2 模式 → **L3 会话用新表 `l3_sessions`，不动 `sessions`**
- `words.metadata` jsonb 含 `morphology / mnemonic / semantic_chain`（`content-hash.ts:14-18`）——锚点算法输入
- LLM prompt 注入面：`PromptBuildOptions`（`src/llm/prompts/index.ts:56-61`），direction 从这里进

---

## 1. 里程碑与依赖图

```
W1（schema + domain，4 任务全并行）
  T01 direction 三处落地 ─┬─► T05 升级工单服务 ─┐
  T02 三张新表 ──────────┼─► T06 L3 练习记录 ───┤
  T03 建议/锚点纯函数 ───┼─► T07 会话计划服务 ──┤
  T04 L3 练习生成器 ─────┘   T08 一键遗忘服务 ──┘
                              │
W3                            ▼
                        T09 HTTP 路由+契约
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        T10 升级工作台    T11 L3 练习+错题库  T12 一键遗忘流
W4（P2，后置）：T13 agent 关联管线、T14 观测回看
```

---

## 2. Wave 1（schema + domain，P0，全并行）

### T01 [schema] direction 三处落地（ADR-0017）

- **交付物**：
  - 迁移：`word_l2_content` 加 `direction text not null default '通用'` + CHECK(`通用/考研/雅思`) + 去重唯一 `(word_id, field, direction)`（按活跃语义定 partial 条件，避免候选/退役行互堵）；既有行 backfill `通用`（幂等、可回滚）
  - 迁移：`l3_sources` 加 `direction text not null default '通用'` + CHECK
  - `refresh_l2_cache` DB 函数改造：聚合时为每个缓存条目保留 `direction` 字段（`drizzle-release/0018_witty_longhorn.sql:17` 是现状）
  - `wordbooks.direction` 落 `settings` jsonb（0 迁移，仅类型与默认值）
  - `src/db/schema.ts` 同步
- **验收**：`db:schema:drift` 绿；迁移幂等/可回滚；**行为保持**——默认 direction=`通用` 时所有读取结果与迁移前一致（现有测试全绿）；typecheck
- **工作量 M（3-7 人日）｜P0**

### T02 [schema] 三张新表（ADR-0018/0019）

- **交付物**（各配 RLS `own_all` + schema.ts 同步）：
  - `upgrade_work_orders`：`id, user_id, word_id, wordbook_id, direction, status(标记中|升级中|已完成|已取消), suggestion_snapshot jsonb, created_at, updated_at, completed_at`；部分唯一索引 `(user_id, word_id, wordbook_id) WHERE status IN ('标记中','升级中')`；复合 FK `(wordbook_id,user_id)→wordbooks(id,user_id)`
  - `l3_practice_attempts`：`id, user_id, context_id notnull FK→l3_contexts, occurrence_id null FK→l3_occurrences, session_id null FK→l3_sessions, practice_type, outcome, payload jsonb, created_at`；索引 `(user_id, outcome, created_at)`；**无 FSRS 列**
  - `l3_sessions`：`id, user_id, type(l2_upgrade|l3_practice|cram_pack|knowledge), title, plan jsonb(实体引用+version), version int, status, started_at, ended_at, created_at`
- **验收**：同 T01 门禁；**工作量 M｜P0**

### T03 [domain] 升级建议 + 锚点候选 纯函数（ADR-0018/0020）

- **交付物**：
  - `src/domain/upgrade-suggestion.ts`：`computeUpgradeSuggestion({ currentBookL1: { recentRatings }, otherBooksL2: { state, retrievability, l2ProductionStatus }[] }) → 'strong' | 'normal' | 'needs_settling'`；档位规则显式可测
  - `src/domain/forgetting-anchors.ts`：`computeAnchorCandidates({ progressRows, wordsMeta }) → anchorWordIds[]`；输入含 `words.metadata.{morphology,mnemonic,semantic_chain}` 与 `aliases`；确定性规则（如：高 stability ∪ 词根族活跃 ∪ 近期评分好）
  - `tests/domain/` 双测试文件，覆盖各档/各规则分支
- **验收**：arch:check 零违规（零出向）；domain 门禁 + diff ≥85%；**工作量 S–M｜P0**

### T04 [domain] L3 练习任务生成器（ADR-0019）

- **交付物**：`src/domain/l3-practice-task.ts`
  - 作文句默写任务：从 context 生成（原句 + 目标词挖空位/输入校验规则）
  - 语境义自测（记录版）任务：原句 + 隐藏 bound sense（目标词高亮）
  - `deterministicTaskId`（sha256(sessionId, contextId, attemptIndex)，参照 `src/domain/l2-task.ts:77-80`）+ mulberry32 PRNG（`:123-133`）
  - 纯函数零出向 + 测试
- **验收**：同 T03；**工作量 M｜P0**

---

## 3. Wave 2（services，依赖 W1，P0/P1）

### T05 [service] 升级工单服务 + 提前升级执行（ADR-0018）← T01/T02/T03

- **交付物**：
  - `src/services/upgrade-work-order.service.ts`：`mark`（建单+快照 suggestion）、`list`（待升级清单）、`cancel`、`start`、`complete`
  - 扩展 `L2TransitionService`：新增 `promoteWithSeed({ userId, wordId, wordbookId, direction })`——从该词**跨书最佳** L2/L1 状态取种子（现继承算术 `l2-transition.service.ts:158-168` 只看本书 L1），创建 `(user,word,book)` L2 行；review_log `metadata.seeded_from` 记录来源；**既有 `checkAndTransition` / `promoteNow` 一字不动**
  - 幂等：重复 complete 吞 23505（参照 `:200-214`）
- **验收**：service 门禁；幂等/事务测试；现有晋升测试全绿；**工作量 M｜P0**

### T06 [service] L3 练习记录 + 错题库（ADR-0019）← T02/T04

- **交付物**：`src/services/l3-practice.service.ts`
  - `recordAttempt`（幂等键）、`listAttempts`
  - `errorBook({ space?, direction? })` → attempts(`outcome=wrong`) 派生查询，JOIN contexts→sources 按两轴过滤
  - **零 FSRS 写入**（depcruise `l2-no-l3-*` 规则保持零违规）
- **验收**：service 门禁；幂等测试；**工作量 M｜P0**

### T07 [service] 会话计划服务（ADR-0019）← T02

- **交付物**：`src/services/l3-session.service.ts`
  - `createPlan`（攻坚包：space×direction 抽 N 条 context × D 天；plan jsonb 只存**实体 id 引用** + `version=1`）
  - `getSession` → 渲染描述（计划+引用，现拉现渲染，不存产物）
  - `endSession`；**版本拒绝**（未知 version 抛错，不静默损坏——借 TypeWords 评审思路）
- **验收**：service 门禁；版本拒绝测试；**工作量 M｜P1**

### T08 [service] 一键遗忘服务（ADR-0020）← T03

- **交付物**：`src/services/forgetting.service.ts`
  - `preview(bookId)` → `{ anchors, suspendCount }`（调 T03 纯函数）
  - `apply(bookId, confirmedAnchorIds)` → 单事务：L1 progress 批量 `state='suspended'`（复用 `review.repository.ts:502` 模式，metadata `{action:'bulk_forget', batchId}`）+ L2 progress 批量 `l2_paused=true, l2_paused_reason='manual'`
  - `restore(bookId, batchId)` → 只恢复本批次（metadata 批次 id 溯源）
  - 防误触：apply 必须携带 preview 产出的锚点清单
- **验收**：service 门禁；事务原子性（部分失败全回滚）；**跨书隔离测试**（只影响目标书）；**工作量 M｜P1**

---

## 4. Wave 3（http + 前端）

### T09 [http] 全部新路由 + 契约 ← T05/T06/T07/T08

- **交付物**：routes（upgrade-work-orders / l3-practice(attempts,error-book) / l3-sessions / forgetting(preview,apply,restore)）；zod schemas（`src/schemas/http/`）；OpenAPI 重生成
- **验收**：http 门禁 + `api:governance` + 契约测试；**工作量 M｜P1**

### T10 [frontend] 升级工作台 + 待升级清单（ADR-0018）← T09

- **交付物**：待升级清单页（工单 + suggestion 档位）；工作台（复用 `WordL2Composer` 的 draft/external-prompt/confirm 流，direction 从工单注入）；L1 卡首学时刻 suggestion 徽标（轻量内联，**不破坏 <5s 节奏**）
- **验收**：`frontend:build` + 组件测试；**工作量 M｜P1**

### T11 [frontend] L3 练习 + 错题库 + 会话壳（ADR-0019）← T09

- **交付物**：会话壳（渲染 plan+引用）；默写组件；记录版语境义自测组件；错题库视图（space/direction 筛选）
- **验收**：`frontend:build`；**工作量 M–L｜P1**

### T12 [frontend] 一键遗忘确认流（ADR-0020）← T09

- **交付物**：词书页入口 → preview 弹窗（锚点清单 + 数量 + agent 叙事位）→ 确认 apply → 恢复入口
- **验收**：`frontend:build`；**工作量 S–M｜P1**

---

## 5. Wave 4（P2，可后置）

| 任务 | 内容 | 依赖 | 工作量 |
|---|---|---|---|
| **T13a** 权限门禁（✅ `9baf377` + `a3a89d6`） | `/api/*` 按端点最小角色（注册表 `minRole` + 查找表）；agent = 读全量 + 只写 proposal 路径（proposal 入口 2 + 提示词组装 + L3 imports）；`agentId` 服务端认定入 `Principal`；未认证 401 而非 403 | T09 路由 | ✅ 已完成 |
| **T13b** L3 读面放开与缺口补齐（✅ `7c7519d`） | `sources` / `words/:slug/contexts` 补 `direction`+`space` 两轴（space 走 `l3_source_spaces` junction）；新增 `GET /occurrences`、`GET /context-links` list（cursor 分页）；error code 集中为 `src/errors/codes.ts` 单一导出 | T13a | ✅ 已完成 |
| **T13c** MCP 工具面与能力发现（✅ `156da29`） | 补 L3 工具；**下线 `confirm_l2_content`**（ADR-0029 §3）；工具 description 标注"产物进 proposal、需人工确认"；`GET /api/l3/capabilities` + MCP `get_capabilities`（数字从 `src/schemas/resource-budget.ts` 常量导出，禁第二套真源）；error code 枚举复用 T13b 的单一导出。**原 T13「agent 关联建议（圈词划词重构第一阶段）」的提案通道用例由本卡承载**：agent 经 proposal 通道提交 occurrence/link 关联建议（`source_type='agent'`），阅读视图内 accept，**写入一律 pending（Q8 已决）** | T13a + T13b | M |
| **T13c-2** MCP 提案状态查询（✅ `d3ae06b`） | 收尾卡：新增只读工具 `list_l3_proposals` / `get_l3_proposal`（读前写后插位）；description 一律复用 `READ_ONLY_NOTE`；`get_capabilities` 广告调用者 role/access；工具表 11→13、删除「agent 无法自查提案状态」缺口。**无服务端/契约/生成物改动** | T13c | S |

**T13 切片命名（本表为权威）**：三分制 = **T13a 门禁 / T13b 读面 / T13c 工具面**。ADR 只引用 ADR 号、不引用卡片号（ADR-0029 §Consequences）；派单与验收一律以本表切片名为准（此前口头使用的 T13a/b/c/d 四分写法已作废）。
| **T14** 观测回看 | 统计脚本/看板：`seeded_from` 词的 L2 lapse 率 vs 自动晋升词（ADR-0018 回看依据）；锚点算法质量回看（ADR-0020） | T05 上线后有数据 | S |

---

## 6. 门禁对照速查

| 任务 | typecheck | arch:check | 分层覆盖+diff85% | db:schema:drift | api:governance | frontend:build |
|---|---|---|---|---|---|---|
| T01/T02 | ✅ | ✅ | ✅ | ✅ | — | — |
| T03/T04 | ✅ | ✅ | ✅(domain) | — | — | — |
| T05–T08 | ✅ | ✅ | ✅(service/repo) | — | — | — |
| T09 | ✅ | ✅ | ✅(http) | — | ✅ | — |
| T10–T12 | ✅ | — | — | — | — | ✅ |
| T13/T14 | ✅ | ✅ | 按触及层 | — | T13 ✅ | T13 ✅ |

## 7. 执行顺序建议

1. **W1 四任务全并行**（2 名 agent：schema 组 T01+T02，domain 组 T03+T04）——它们共同构成所有后续的地基。
2. **W2 四任务并行**（T05/T06/T07/T08，除 T05 依赖 T01 外彼此独立）。
3. **T09 单独**（集中过 api:governance），然后 **T10/T11/T12 并行**。
4. W4 视 W1-W3 落地情况随时插入，不阻塞主线。

**禁止事项提醒**（写进每个 brief）：不改 ADR-0002 自动晋升路径；不给 attempts 加任何 FSRS 列；不给 `sessions` 表加 L3 mode（用 `l3_sessions`）；不让 agent 直写 active L3（一律 proposal pending）。
