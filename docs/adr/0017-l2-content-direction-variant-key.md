# ADR-0017: L2 内容方向变体键（word_l2_content 按 direction 扩展，进度键不变）

- **Status**: Accepted
- **Date**: 2026-09-11（同日按 schema 实读修正键写法：原稿误写 `(user_id, word_id, field, direction)`，该表实为 word-scoped 全局表，无 user_id）
- **References**: ADR-0002（双轨 FSRS 隔离）、ADR-0004 §6（红线）、ADR-0006（L2 Composer 合同）、ADR-0018（提前升级）、CONTEXT.md（Direction / Wordbook / 升级标记）
- **上游**: 2026-09-11 增量认知设计拷问会话；作废上游设想：`docs/superpowers/specs/2026-07-06-wordbook-space-strategy-design.md`（词书层级 / 合并进度 / `word_progress_master` 方向）

## Context

增量认知模型下，词书的语义被重新收敛为**复习权重 + 内容获取的筛选优先**：

- 进度按书：唯一键维持 `(user, word, wordbook)`，同一词在每本新书里从 L1→L2 链路重新起步；
- 但 L2 内容需要支持"考研向 / 雅思向"的**增量添加**——用户换书后，同一词应能追加当前方向的内容版本，且不得覆盖旧方向的内容；
- `word_l2_content` 现状（`src/db/schema.ts:869-883`）：**word-scoped 全局内容表**——无 `user_id`、未启用 RLS、无任何唯一约束/CHECK（`drizzle-release/0018` 迁移注释明写 "word-scoped GLOBAL content"）；候选池 = 同表 `is_active=false` 行（`l2-content.service.ts:1054-1087`）。一词一字段实际上多行并存（激活/候选/退役），无方向维度，替换式更新会破坏旧方向内容。

同期否决的另一条路线：**进度键全局化**（改 `(user, word)`）。它与"换书重走链路"的产品语义直接矛盾，且同词多书的进度合并需要一套没有正确答案的冲突规则（取最新？取最多？取最保守？）。

## Decision

1. `word_l2_content` 增加 `direction text not null default '通用'`（CHECK 枚举起步：`通用 / 考研 / 雅思`，可扩展）；**新增去重唯一 `(word_id, field, direction)`**（按活跃语义定 partial 条件，避免候选/退役行互相阻塞）；既有行 backfill `通用`（迁移幂等、可回滚）。
2. 候选池无需单独改表：`direction` 列天然覆盖候选行；`L2ContentService.proposeCandidates` 接受 `direction`（**由升级工单在生成时指定**，采纳路径不变，见 ADR-0018）。
3. 展示规则：**当前词书方向优先 + `通用` 兜底**。注意 `words` 的 L2 缓存列（`collocations / corpus_items / synonym_items / antonym_items`）由 DB 函数 `refresh_l2_cache` **全局聚合**（无用户上下文），因此聚合函数必须为每个缓存条目**保留 direction 字段**；方向过滤发生在读取/展示层，不进缓存聚合的选择逻辑。
4. **进度表键不变**（`(user, word, wordbook)`），0 进度迁移；ADR-0002 的双轨隔离与晋升条件不受影响（用户主动豁免路径见 ADR-0018）。

## Tradeoffs

- **变体行 vs 单行 jsonb 按方向分桶**：采纳 / 保存 / 隐藏的生命周期全部是行导向的（CONTEXT.md 既有定义），变体行使这些语义**零改动**；jsonb 分桶会把 item 级 Save/Hide 的作用域变成 `(row × direction)`，采纳语义复杂度爆炸。
- **变体行 vs 主行（通用）+ 方向补丁行**：两类行语义不一致，查询与采纳都要特判，拒绝。
- **生成时指定 direction vs 采纳时指定**：升级工单自带方向，生成时指定免去采纳时的二次确认；采纳时指定会让候选池混入方向不明的行。

## Consequences

- ✅ 方向增量互不覆盖；行导向生命周期零改动；进度 0 迁移；词书=权重/筛选的语义与 schema 自洽。
- ⚠️ 该表是**全局共享内容**（无 user 维度）：direction 变体与 `is_active` 语义同为全局每词（既有行为），本 ADR 不改变这一点；多用户场景下"激活哪个变体"的影响面与现状一致。若有按用户个性化激活的需求，属另一个独立决策。
- ⚠️ 同词内容行数按方向数膨胀；所有读取路径必须带方向过滤（当前方向 + 通用）。
- ⚠️ 方向枚举扩展需要迁移；既有行 → `通用` 的迁移脚本需幂等且可回滚。
- ⚠️ `refresh_l2_cache`（DB 函数）需同步改造以保留条目 direction；缓存消费者（L2 drill `findDueCards` 读缓存列）展示层按方向过滤。
- ⚠️ `2026-07-06-wordbook-space-strategy-design.md` 的"词书层级 / 合并进度"方向被本决策正式取代，该 spec 应在下次文档维护时标记作废。

## R1 复核（2026-09-11）：direction 键进入 L2 hash 的影响面

0027 落地后复核"缓存条目新挂 direction 键 → 重算 hash 与旧快照不一致 → 用户可见
needs_recheck / 重卡抖动"这一推断：

- **结论：不存在用户可见 churn。** 0027 本体不刷新缓存、不重算任何 hash；hash 写入只发生在
  7 条用户主动的 L2 内容编辑路径（`l2-content.service.ts`），`finalize_l2_content_hash`
  的快照比较也只在同一路径内触发 L2 重卡（"内容已变 → 重做"的既有语义，ADR-0003）；
  `needs_recheck` 在本仓无任何运行时写入者（既有事实，与 direction 无关）。
- **决策：保持 §3 原语义**（每个 object 条目保留 direction 键，方案 A），不改 0027 本体、
  不加一次性对账脚本。被否的"仅非通用挂键"（方案 B，需重解释 §3 且读取层照样要处理
  键缺席）与"hash 输入剥离 direction"（方案 C，抹掉方向的内容身份）理由见
  `docs/design/l2-hash-direction-impact-and-decision.md`（含三阶段实测证据、边界情形与
  新增回归锁）。
- **读取层约定（与方案无关）**：迁移后尚未被编辑过的存量缓存没有 direction 键，
  方向过滤一律 `item.direction ?? '通用'`。

## 修正（2026-09-11）：方向不设唯一约束

§Decision 1 曾落地为 `(word_id, field, direction)` 的 partial UNIQUE 索引
（`WHERE is_active = true`）外加 fail-closed preflight 守卫。**该约束被撤销**：

- **唯一约束会阻断既有合法写入路径**：`confirmDraft` 直接 insert（`is_active` 默认
  true）不退休同字段旧行（`src/services/l2-content.service.ts:1019` +
  `l2-content.repository.ts:55`），同 `(word, field)` 第二次确认必撞 23505；
  `acceptCandidate` 默认 `mode='append'` 的**文档语义就是共存**
  （`l2-content.service.ts:1115,1153-1164`），存在 active 兄弟行时必撞。
- **守卫会阻断存量升级**：同键多条 active 行是 0018 以来
  `refresh_l2_cache`（按 `created_at, ordinality` 聚合多行）的既有模型产物，
  在真实数据上属合法状态；旧版 0027 的 preflight 会对这种库 RAISE，迁移无法应用。
- **修正内容**：0027 删除唯一索引与守卫（保留 `direction` 列 + CHECK + 幂等 backfill，
  `refresh_l2_cache` 函数体一字不改）；新增 **0029** 迁移 `DROP INDEX IF EXISTS
  word_l2_content_word_field_direction_active_unique`，为"已应用过旧版 0027"的库兜底
  （新库 no-op）。**不补替代索引**：既有查询由 `idx_l2_content_word_field` 覆盖，
  未来若出现按方向查行的真实查询再补。
- **语义定稿**：direction 是**内容维度**，不是唯一键——同一 `(word, field, direction)`
  的 active 行可 0..n 条；"同一方向多行如何取舍/合并"属于读取层与后续服务决策，
  不在 schema 层用约束替用户做决定（CONTEXT.md Relationships 已同步）。
- **回归守护**：`tests/l2-content.integration.test.ts` 覆盖连续两次 confirmDraft、
  append 采纳共存、replace 采纳留档兄弟行、refresh 聚合顺序与 direction 键行为。
