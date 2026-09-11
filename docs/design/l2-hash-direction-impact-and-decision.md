# L2 hash 形状变化（ADR-0017 direction 键）影响面报告与决策（R1）

- **日期**：2026-09-11
- **范围**：0027 迁移把 `refresh_l2_cache` 改为"为每个 object 条目追加 `direction` 键"，
  而 L2 hash 的输入包含 `words` 的四个缓存列，需判定是否产生用户可见 churn。
- **结论（TL;DR）**：**不存在用户可见 churn**。迁移本体不刷新缓存、不重算任何 hash；
  唯一的 hash 驱动状态变化（L2 `due_at` 推前）只在用户主动做 L2 内容编辑时发生，
  与 0027 之前的行为同构。**决策：保持现状（方案 A），不改 0027 本体、不加对账脚本。**

## 0. 关键前提核查（0027/0028 是否已被应用）

| 检查 | 结果 |
|---|---|
| git 状态 | `0027_cold_eddie_brock.sql` / `0028_black_ironclad.sql` 均为 **untracked，未提交** |
| 本地运行库（compose `vocab-observatory-postgres-1`） | `vocab_migrations.__v2_release_migrations` = **27 条（至 0026）**；`word_l2_content.direction` 不存在；`l3_sessions` 不存在 |
| 验证容器 | T01/T02 用的临时容器均为一次性、已删除，不构成"已应用" |

⇒ 本任务**本可**改 0027 本体（窗口成立），但基于下面的证据，**选择不改**。

## 1. 证据链：写入点 / 比较点 / 消费点

### 1.1 hash 的写入点（仅 7 处，全部是用户主动的 L2 内容编辑）

| 位置 | 动作 |
|---|---|
| `src/services/l2-content.service.ts:1032,1039-1040` | `confirmDraft`：insert → refresh → `computeL2Hash/FullHash` → finalize |
| `:1165,1170-1171` | `acceptCandidate`（append/replace） |
| `:1190,1195-1196` | `deactivateContentRow` |
| `:1212,1217-1218` | `deleteContentRow`（active 行） |
| `:1259,1264-1265` | `removeContentRowItem` |
| `:1297,1302-1303` | `hideContentRowItem` |
| `:1332,1337-1338` | `restoreContentRowItem` |

- `computeL2Hash` = hash(`collocations`+`corpus_items`+`synonym_items`+`antonym_items`)
  （`src/db/content-hash.ts:43-51`）；`computeL1Hash` 只含 L1 字段（`:30-40`）——
  direction 键进不了 L1 hash。
- `refreshL2Cache` 的唯一 TS 调用方就是上面 7 处（`src/repositories/l2-content.repository.ts:162-167`）；
  `finalize_l2_content_hash` 的唯一 TS 调用方是 `l2-progress.repository.ts:613`。
- **0027 本体不调用 refresh**（文件内只有 ADD COLUMN / 防御性 UPDATE / CHECK / INDEX /
  `CREATE OR REPLACE FUNCTION`）；迁移不物化任何缓存。

### 1.2 hash 的比较点与消费点

| 位置 | 比较内容 | 状态变化 | 触发条件 |
|---|---|---|---|
| `drizzle-release/0018_witty_longhorn.sql:109-121`（`finalize_l2_content_hash`） | 新 L2 hash vs `user_word_l2_progress.l2_content_hash_snapshot` | 不等 → 写 snapshot + `l2_due_at = now()`（L2 重卡，按 `l2_paused = false` 过滤） | 仅上表 7 个编辑路径 |
| `src/repositories/review.repository.ts:635-647` `findStaleCards` | `uwp.content_hash_snapshot` vs `words.content_hash` | 只读 | **无生产调用方**（仅测试/文档） |
| `src/repositories/review.repository.ts:658-676` `markStaleForRecheck` / `:684-702` `markL1StaleForRecheck` | — | 写 `needs_recheck = true` + 推 due | **无生产调用方**（仅测试/文档） |
| `src/domain/review.entity.ts:64-69` `needsRecheck(currentContentHash)` | snapshot vs 传入 hash | 纯查询 | **无生产调用方** |
| `src/services/review-queue.ts:34,104,179` | 读 `needs_recheck` 做优先级分桶 | 排序 | 依赖上面的写入——而写入者不存在 |
| `src/repositories/l2-progress.repository.ts:86-107` `findDueCards` | 不比较 hash | — | — |
| `src/services/l2-review.service.ts:150-151` | snapshot 仅作 fallback key | — | — |
| `src/services/review.service.ts:489-496` + `review.repository.ts:373-395` | 答题时把**当前** `words.content_hash` 写回两个 snapshot 列 | snapshot 自愈 | 用户答题 |

**`needs_recheck` 在本仓没有任何运行时写入者**（全仓 grep：仅列定义、索引、
两个未被调用的 mark 方法、队列读取与类型）；0027 之前就是如此，与 direction 无关。

## 2. 影响面量化

- **迁移时刻**：0 个词受影响。0027 不触碰 `words` 缓存列、`words.*_content_hash`、
  `user_word_*` 任何行。
- **迁移后**：direction 键只在"该词的下一次 L2 内容编辑"时随 refresh 写入缓存。
  8/8 存量词若从不编辑 L2 内容，缓存与 hash 永久保持 0027 之前的字节。
- **编辑时刻**：hash 值变化是**内容变化的正常结果**（7 条路径都会改变缓存：新增/激活/
  停用/删除行、移除/隐藏/恢复条目），L2 `due_at` 推前是设计内的"内容已变 → 重做一次"
  （ADR-0003 / 双轨 spec 既有语义），与 direction 键无关。
- **重复性**：不重复。同内容重复 refresh 产出逐字节相同的缓存；同 hash 重复 finalize
  更新 0 行（见 §4 实测）。
- **唯一新增边界情形**：某次编辑若"除 direction 键外条目内容与编辑前完全相同"（例：
  确认空数组、replace 成完全相同的条目集），0027 前该次 finalize 是 no-op，0027 后会
  多推一次 L2 重卡（该词正在被编辑，1 次、一次性）。**无 L1 影响**。

## 3. 决策：保持现状（方案 A），不做一次性对账

被否方案与理由：

- **方案 B（仅非 `通用` 挂方向键）**：能消除上述边界情形并让存量 hash 逐字节不变，但
  (1) 与 ADR-0017 §3 "为**每个**缓存条目保留 direction 字段"的字面要求相悖，需要重解释；
  (2) 破坏"缓存字节 ↔ hash"的完全对应（同一缓存形状之外还要记忆缺省规则）；
  (3) `?? '通用'` 的读取约定并没有省掉——迁移后未被编辑过的存量缓存**本来就没有该键**，
     读取层无论如何都必须处理"缺席 = 通用"。
- **方案 C（hash 输入剥离 direction）**：会让"方向变体差异"对 hash 不可见（方向是
  ADR-0017 的内容身份，不是装饰字段），并且要在 TS 侧引入静默剥离逻辑；收益（省掉一次
  可忽略的 hash 值变化）远小于语义损失。
- **方案 A 的"一次性对账脚本"**：不需要。hash 是 content-addressed 的，且写入点总是紧跟
  其物化的 refresh——每个词的 `words.l2_content_hash` 与自己的缓存字节始终自洽（要么都
  是旧形状，要么都是新形状），不存在"hash 落后于内容"的存量行。（`scripts/backfill-content-hash.ts`
  只处理 `l1_content_hash IS NULL` 的词，也不会触发任何 progress 侧变化；无需扩展。）

## 4. 实测证据（隔离 postgres:17-alpine，已删除）

阶段 1-2：0026 时代建库 + 造存量态（缓存已物化、hash 已写、L1/L2 进度行就位）→ 应用真实
0027 → 逐键 diff：

| 键 | 0027 后是否变化 |
|---|---|
| `words.collocations` / `corpus_items` | **不变**（仍为无 direction 的裸条目） |
| `words.l2_content_hash` / `content_hash` | **不变** |
| `user_word_l2_progress.l2_content_hash_snapshot` / `l2_due_at` | **不变** |
| `user_word_progress.needs_recheck` / `due_at` | **不变** |

阶段 3：模拟 0027 后该词的首次编辑（refresh + finalize 新 hash）：

- 缓存条目变为 `{"phrase":"p1","direction":"通用"}`（形状迁移发生）；
- `finalize` 恰好更新 1 行、snapshot 更新、`l2_due_at` 推前（内容确已变化）；
- L1 探针行：`needs_recheck = false`、`due_at` 不变；
- 重复 refresh → 缓存逐字节相同；重复 finalize 同 hash → **更新 0 行**。

## 5. 回归锁（本次新增，防止结论腐化）

- `scripts/verify-database-roles.ts`：fixture 增 L1 探针行；断言 L2 级联后
  `needs_recheck=false`、L1 `due_at`/两列 snapshot 逐字节不变；断言 refresh 形状幂等、
  同 hash 重复 finalize = 0 行。（已做变异验证：把 L1 期望反转 → 断言确实失败。）
- `tests/db/content-hash.test.ts`：锁定 direction 是 L2 内容身份（入 L2/full hash）、
  同形状稳定、且**不渗入 L1 hash**（ADR-0002 隔离）。

## 6. 残留事项（不在本任务范围）

1. **读取层**：T10/T11 按方向过滤缓存条目时必须 `item.direction ?? '通用'`——迁移后
   尚未编辑过的存量缓存没有该键（此约定与方案选择无关）。
2. **既有事实**：`needs_recheck` 全链路无写入者（`markL1StaleForRecheck` 等为死代码）。
   这是 0027 之前就存在的状态，建议另立任务决定"接线或删除"。
3. 若未来确需方案 B，最小改动集已明确：0027 条件键、`REFRESH_L2_CACHE_DIRECTION_CONTRACT`
   增"通用不挂键"断言、`scripts/verify-database-roles.ts` 期望回退为裸条目 + 新增一条
   非通用行锁方向键、`tests/db/content-hash.test.ts` 相应用例反转。
