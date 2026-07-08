# 双轨 FSRS 正式设计规格

- **Status**: Spec / 已整合 3 决策 + 10 漏洞修复 / 待 review → 实施
- **Date**: 2026-07-07
- **取代**: 本 spec 合并并修正以下文档的矛盾部分，为唯一权威：
  - `2026-07-06-self-growing-knowledge-chain.md` 决策 1（L1/L2 双轨隔离）
  - `2026-07-07-dual-track-fsrs-fix-exploration.md`（修复探索）
  - 早期设计探索中的 inherit_ratio 公式与 L2_state 定义
- **依赖**: `2026-07-06-self-growing-foundation-design.md` / `2026-07-06-self-growing-backend-implementation.md`
- **代码验证**: v2 schema.ts / review.service.ts / review.repository.ts 实际读取

---

## 一、设计目标

L1（认知识别）与 L2（应用辨析）是两种不同认知任务，记忆衰减规律不同。混在一个 FSRS 调度里会互相污染：L1 速刷失败不该重置 L2 辨析记忆；L2 扩展不该触发 L1 重卡；L1 retention(0.85) ≠ L2 retention(0.95)。

**设计原则**：双轨隔离 + 有继承关系 + 默认隔离极端联动 + 不破坏现有 v2 架构 + 向后兼容。

---

## 二、双轨定位

| 维度 | L1 速刷底线轨 | L2 持久化轨 |
|------|-------------|------------|
| 认知任务 | 再认——看到词想起释义 | 回忆+辨析——能主动使用+区分近义 |
| desired_retention | 0.85 | 0.90 |
| 交互时长 | <5s/词（快速翻转）| 15-30s/词（看搭配/例句/辨析）|
| good 门槛 | "认识"即 good | "能辨析"才 good |
| 调度表 | user_word_progress（现有，改）| user_word_l2_progress（新建）|
| content_hash | l1_content_hash | l2_content_hash |
| weights | per-wordbook fsrs_weights | per-wordbook fsrs_l2_weights（冷启动复用 L1）|

retention 差异的调度效果（FSRS interval = S × 9 × (R^(-2) - 1)）：

| retention | 间隔系数 | L2_S=5.25d 首次间隔 | 语义 |
|-----------|---------|-------------------|------|
| 0.95 | 0.97S | 5.1d | 太频繁，每 5 天辨析一次负担重 |
| 0.90 | 2.12S | 11.1d | 标准持久化，有呼吸空间（**L2 采用**） |
| 0.85 | 3.46S | 18.2d | L1 用这个（速刷底线） |

L2=0.9 的间隔系数 2.12 是 FSRS 默认值，间隔 11d 起步，随 stability 增长到数月——这才是"持久化"的语义。L1=0.85（速刷容忍遗忘）/ L2=0.9（标准持久化）差异明确但不过分。

---

## 三、数据模型

### 3.1 words 表新增列

```sql
ALTER TABLE words ADD COLUMN l1_content_hash text, ADD COLUMN l2_content_hash text;
-- 保留原 content_hash（全量，向后兼容：导入去重用）
```

### 3.2 user_word_progress 新增列（L1 轨）

```sql
ALTER TABLE user_word_progress
  ADD COLUMN l1_content_hash_snapshot text,
  ADD COLUMN recent_ratings jsonb DEFAULT '[]',
  ADD COLUMN l1_weak_signal boolean DEFAULT false NOT NULL;
-- 保留 content_hash_snapshot（全量兼容）/ needs_recheck（L1 漂移标记）
```

### 3.3 user_word_l2_progress 表（L2 轨，新建）

```sql
CREATE TABLE user_word_l2_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  word_id uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  -- FSRS 调度
  l2_stability numeric(10,4),
  l2_difficulty numeric(10,4),
  l2_retrievability numeric(8,6),
  l2_state text DEFAULT 'review' NOT NULL,
  l2_desired_retention numeric(4,3) DEFAULT 0.900 NOT NULL,
  l2_due_at timestamptz,
  l2_last_reviewed_at timestamptz,
  l2_last_rating text,
  l2_review_count integer DEFAULT 0 NOT NULL,
  l2_lapse_count integer DEFAULT 0 NOT NULL,
  l2_interval_days integer,
  l2_scheduler_payload jsonb DEFAULT '{}' NOT NULL,
  l2_again_count integer DEFAULT 0 NOT NULL,
  l2_hard_count integer DEFAULT 0 NOT NULL,
  l2_good_count integer DEFAULT 0 NOT NULL,
  l2_easy_count integer DEFAULT 0 NOT NULL,
  -- 漂移检测
  l2_content_hash_snapshot text,
  -- 滑动窗口
  recent_ratings jsonb DEFAULT '[]',
  -- 暂停状态
  l2_paused boolean DEFAULT false NOT NULL,
  l2_paused_at timestamptz,
  l2_paused_reason text,
  -- 审计与 L3 预留
  l2_inherited_from_l1 boolean DEFAULT false,
  l2_weights_source text DEFAULT 'inherited',
  l2_predicted_retrievability numeric(8,6),
  -- ⚠️ L3 BOUNDARY (ADR-0005): 以下两列是 Phase-0 遗留死字段，当前无业务代码使用，
  -- 且 NOT the L3 语境空间主模型。L3 将在 Phase 3 用独立 l3_sources/l3_contexts/l3_proposals
  -- 表族实现，不参与 FSRS，不挂在 user_word_l2_progress 上。保留仅为避免 migration churn。
  l3_pending boolean DEFAULT false,
  l3_self_assessments jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, word_id),
  CHECK (l2_state = ANY(ARRAY['new','learning','review','relearning','suspended'])),
  CHECK (l2_desired_retention >= 0.900 AND l2_desired_retention <= 0.990),
  CHECK (l2_paused_reason IS NULL OR l2_paused_reason = ANY(ARRAY['l1_cascade_failure','wordbook_focus','manual']))
);
CREATE INDEX idx_l2_progress_due ON user_word_l2_progress(user_id, l2_due_at) WHERE l2_paused = false;
CREATE INDEX idx_l2_progress_word ON user_word_l2_progress(word_id);
```


### 3.5 review_logs 表改造（共享 L1/L2 + track 字段）

```sql
-- review_logs 加 track 字段
ALTER TABLE review_logs
  ADD COLUMN track text DEFAULT 'l1' NOT NULL;
CREATE INDEX idx_review_logs_track ON review_logs(track);

-- 去掉 progress_id 的 FK 约束（改为裸 uuid，应用层校验）
-- progress_id 现在可能指向 user_word_progress.id 或 user_word_l2_progress.id
-- track 字段区分指向哪张表
ALTER TABLE review_logs
  DROP CONSTRAINT review_logs_progress_id_fkey;

-- CHECK 约束
ALTER TABLE review_logs
  ADD CONSTRAINT review_logs_track_check
  CHECK (track = ANY(ARRAY['l1', 'l2']));
```

**幂等检查**：`checkIdempotency(key)` 查 `WHERE idempotency_key = $1`（不限 track，因为 key 全局唯一）。

**weights 优化**：`SELECT * FROM review_logs WHERE track = 'l2' AND ...` — 一条查询搞定。

### 3.4 content_hash 计算函数

```typescript
// src/db/content-hash.ts（新建）
export function computeL1Hash(word): string {
  // hash(definition_md + core_definitions + prototype_text + metadata.morphology/mnemonic/semantic_chain)
}
export function computeL2Hash(word): string {
  // hash(collocations + corpus_items + synonym_items + antonym_items)
}
export function computeFullHash(word): string { /* 现有逻辑不变 */ }
```

---

## 四、L1→L2 跃迁机制

### 跃迁条件

```
L1_stability ≥ 21d AND L1_review_count ≥ 5 AND L1_last_rating ∈ {good, easy} AND 无已有 L2 progress（幂等）
```

### 跃迁触发器（submitAnswer 事务内，saveAnswer 后）

```typescript
// src/services/l2-transition.service.ts
async checkAndTransition(tx, progress) {
  if (Number(progress.stability) < 21) return;
  if (progress.review_count < 5) return;
  if (!['good','easy'].includes(progress.last_rating)) return;
  const existing = await repos.l2Progress.findByWordAndUser(progress.user_id, progress.word_id);
  if (existing) return;
  const l1S = Number(progress.stability);
  const inheritRatio = 0.5 * l1S / (l1S + 21);  // 修正公式
  await repos.l2Progress.insert({
    user_id: progress.user_id, word_id: progress.word_id,
    l2_stability: Math.max(l1S * inheritRatio, 1.0),  // 漏洞1修复：绝对下限 1.0d
    l2_difficulty: Math.min(10, (Number(progress.difficulty) ?? 5) + 2.0),
    l2_state: 'review',  // 修正: Review 非 Learning
    l2_desired_retention: 0.9,
    l2_due_at: new Date(Date.now() + l1S * inheritRatio * 86400000),
    l2_inherited_from_l1: true, l2_weights_source: 'inherited',
  });
}
```

跃迁失败处理：catch 只吞 23505（unique violation，幂等场景），其他 DB 错误 re-throw——防止吞掉 schema 错误。记日志，不回滚 L1 事务（L1 复习结果已保存不应丢失）。下次满足条件再尝试（幂等）。

**漏洞2修复**：catch 块检查 `err.code === '23505'`，其他错误（含表不存在的 42P01）re-throw。

---

## 五、L2 初始化策略

### inherit_ratio 公式（修正后）

```
inherit_ratio = 0.5 × L1_stability / (L1_stability + 21)
```

| L1_S | ratio | L2_S | L2 首次间隔(0.90) | 语义 |
|------|-------|------|-----------------|------|
| 21 | 0.250 | 5.25d | 11.1d | 接近从零 |
| 42 | 0.333 | 14.0d | 29.6d | 弱迁移 |
| 90 | 0.409 | 36.8d | 77.7d | 较强 |
| 180 | 0.448 | 80.6d | 170.2d | 强迁移 |
| ∞ | 0.500 | — | — | 上限 |

依据：再认→回忆迁移率 30-50%（Tulving 编码特异性）。ratio 从 0.25 渐近 0.5，反映"L1 越稳 L2 迁移越多，但永不超过 L1 一半"。

### difficulty 初始化

`L2_difficulty = min(10, L1_difficulty + 2.0)` — 辨析天然比识别难，+2.0 固有难度增量。

### state 初始化

`L2_state = 'review'`（不是 'learning'）。理由：Learning 用分钟级间隔，Review 用天/月级。L2_S=5.25d 需天级调度。ts-fsrs repeat() 对 state=Review+reps=0 用标准调度公式，不检查 reps。

### weights 初始化

L2_weights = L1_weights（冷启动）。L2 积累 400+ 复习后独立拟合，存 `wordbooks.settings.review.fsrs_l2_weights`。L2 desired_retention=0.9（标准持久化，非 0.95）。

---

## 六、content_hash 分层

### 问题

现有 markStaleForRecheck（repo:411）用全量 content_hash。L2 扩展改 words.content_hash → 触发 L1 needs_recheck=true + state→relearning — 违背隔离。

### 分层方案

words 表：l1_content_hash（L1 字段）+ l2_content_hash（L2 字段）+ content_hash（全量，兼容）。
user_word_progress：l1_content_hash_snapshot（L1 漂移）+ content_hash_snapshot（全量兼容）。
user_word_l2_progress：l2_content_hash_snapshot（L2 漂移）。

### 分层 markStaleForRecheck

```typescript
// L1 漂移 → 只触发 L1 重卡
async markL1StaleForRecheck(wordId, newL1Hash) {
  // UPDATE user_word_progress SET l1_content_hash_snapshot=$1, needs_recheck=true,
  //   state=CASE WHEN state='review' THEN 'relearning' ELSE state END, due_at=now()
  // WHERE word_id=$2 AND l1_content_hash_snapshot IS NOT NULL AND l1_content_hash_snapshot!=$1
}

// L2 漂移 → 只触发 L2 重卡（不影响 L1）
async markL2StaleForRecheck(wordId, newL2Hash) {
  // UPDATE user_word_l2_progress SET l2_content_hash_snapshot=$1, l2_due_at=now()
  // WHERE word_id=$2 AND l2_content_hash_snapshot IS NOT NULL AND l2_content_hash_snapshot!=$1 AND l2_paused=false
}
```

### L2 扩展时 hash 更新

extendL2 事务内：写 word_l2_content → 刷 L2 JSONB 缓存 → 重算 l2_content_hash → **只调 markL2StaleForRecheck**（不调 L1 版）→ 更新全量 content_hash（兼容）→ 记 outbox。

### saveAnswer 改造

`content_hash_snapshot = $11` → `l1_content_hash_snapshot = $11` + 保留 `content_hash_snapshot = $12`（兼容）。

**recent_ratings 更新**（漏洞8修复）：saveAnswer 的 SQL 追加 `recent_ratings = (SELECT jsonb_agg(elem) FROM (SELECT elem FROM jsonb_array_elements(recent_ratings || to_jsonb($rating::text)) WITH ORDINALITY t(elem, ord) ORDER BY ord DESC LIMIT 5) sub ORDER BY ord ASC)`——append 最新 rating + slice 最近 5 条。

**参数编号注意**（漏洞4修复）：现有 SQL $1-$13，加 recent_ratings 后变 $14。实施时必须完整重读 saveAnswer 的 SQL + 参数数组，逐个核对编号。TDD 测试覆盖"L1 复习后 l1_content_hash_snapshot 正确写入 + content_hash_snapshot 也写入 + recent_ratings 更新"。

---

## 七、跨轨联动

### 原则：默认隔离 + 极端联动

正常 L1/L2 完全独立。仅连续失败才跨轨：L2 连续 again×3 → L1 软重卡；L1 连续 again×2 → L2 暂停。

### 滑动窗口 recent_ratings

`recent_ratings jsonb DEFAULT '[]'` 存最近 5 条评分。每次复习 append + slice(-5)。

### 联动规则

| 触发 | 条件 | 影响 | 解除 |
|------|------|------|------|
| L2→L1 | L2 最近 3 次全 again | **只标记 l1_weak_signal=true**（不自动重卡，不改 due_at/needs_recheck） | 用户在 UI 看到后决定是否重刷 L1；用户点击"重刷 L1"才触发软重卡 |
| L1→L2 | L1 最近 2 次全 again | L2 自动暂停（l2_paused=true, reason='l1_cascade_failure'） | L1 最近 2 次全 good+ → 自动解冻 |

L2 需 3 次（辨析本就难，单次失败正常）；L1 只需 2 次（速刷失败 2 次说明基础塌了）。

**L2→L1 只标记不自动重卡的理由**：辨析失败≠识别不牢，可能只是同义词特别难辨析。自动重卡会打扰 L1 速刷节奏。改为标记 l1_weak_signal，用户在 UI 看到"⚠️ L2 辨析连续失败，建议重新速刷"后自行决定。

```typescript
// src/services/cross-track.service.ts
async checkL2FailureCascade(tx, l2Progress) {
  const recent = l2Progress.recent_ratings ?? [];
  if (recent.length >= 3 && recent.slice(-3).every(r => r === 'again')) {
    // 只标记 l1_weak_signal，不自动重卡（用户决定是否重刷 L1）
    await repos.reviews.markL1WeakSignal(tx, l2Progress.word_id, l2Progress.user_id, true);
  }
}
async checkL1Cascade(tx, l1Progress) {
  const recent = l1Progress.recent_ratings ?? [];
  if (recent.length >= 2 && recent.slice(-2).every(r => r === 'again')) {
    await repos.l2Progress.pause(tx, l1Progress.word_id, l1Progress.user_id, 'l1_cascade_failure');
  } else if (recent.length >= 2 && recent.slice(-2).every(r => ['good','easy'].includes(r))) {
    await repos.l2Progress.unpauseByReason(tx, l1Progress.word_id, l1Progress.user_id, 'l1_cascade_failure');
  }
}
```

---

## 八、L2 暂停机制

`l2_paused` + `l2_paused_at` + `l2_paused_reason`（枚举 l1_cascade_failure / wordbook_focus / manual）。

暂停语义：L2 不进队列（findDueL2Cards 加 WHERE l2_paused=false），stability/difficulty 保留不动。

**l2_due_at 冻结语义**（漏洞10修复）：暂停时**不改 l2_due_at**（保留原值，但 WHERE l2_paused=false 让它不进队列）；解冻时**统一 SET l2_due_at = now()**（立即到期）。语义：暂停=不可见但保留原 due_at，解冻=立即到期。这避免"暂停 30 天后恢复被惩罚"的问题。

| reason | 触发 | 解除 |
|--------|------|------|
| l1_cascade_failure | L1 最近 2 次全 again | L1 最近 2 次全 good+（自动） |
| wordbook_focus | 进入词书专注模式 | 退出专注模式（自动） |
| manual | 用户手动 | 用户手动 |

每周 cron 检查 l2_paused 超 30 天的词提醒用户（防永久遗忘）。

---

## 九、FSRS 失败处理差异

| 轨 | again 处理 | 理由 |
|---|---|---|
| L1 | S 不重置（残余记忆） | 速刷失败可能一时想不起 |
| L2 | S 显著降，下限 = L1_S × 0.1 | 辨析失败=理解不牢该降；有 L1 基础不归零 |

L2 归零下限防止"L2 反复失败 S 跌到 0.4d 变每天辨析"的惩罚地狱。

---

## 十、weights 独立优化

冷启动复用 L1 weights。L2 积累 400+ 总复习后独立拟合（computeParameters 用 L2 review_logs），存 fsrs_l2_weights。loadL2Weights 优先读 fsrs_l2_weights，无则 fallback 到 fsrs_weights。

---

## 十一、与现有架构兼容性

**已兼容**：FSRS adapter 注入 / desired_retention per-progress / state check 含 review / withTransaction+requireTx / error 体系。

**需改**：markStaleForRecheck 拆 L1/L2 版 / saveAnswer 改 l1_content_hash_snapshot / findStaleProgress 拆 L1/L2 版 / submitAnswer 插入跃迁检查(step 7.5)+跨轨联动检查 / review_logs 加 track 字段 + 去 progress_id FK。

**新建**：l2-transition.service / l2-review.service / cross-track.service / l2-progress.repository / content-hash.ts。

**L2ReviewService.submitL2Answer 设计**（漏洞5修复）：独立于 ReviewService.submitAnswer，因为 progress 表/repo/检查逻辑不同。但复用同一 fsrsAdapter（传入 L2 的 l2_scheduler_payload + L2 desired_retention(0.9) + L2 weights）。l2_scheduler_payload 格式 = StoredSchedulerCard（与 L1 相同，漏洞6修复），fsrsAdapter 的 toCard/fromCard 通用。

---

## 十二、实施路线图

| Phase | 内容 | 验收 | 周期 |
|-------|------|------|------|
| A | content_hash 分层 | L2 扩展后 L1 needs_recheck 不变 | 1-2 周 |
| B | L2 轨 + 跃迁 | L1_S≥21 自动创建 L2 progress, state=Review | 2-3 周 |
| C | 跨轨联动 + 暂停 | L2 again×3→L1 软重卡; L1 again×2→L2 暂停; L1 恢复→L2 解冻 | 1-2 周 |
| D | weights 独立优化 | L2 积累 400+ 自动分叉优化 | 1 周 |

依赖：A 是一切基础（不做则双轨假隔离）→ B 依赖 A → C 依赖 B → D 独立。

---

## 十三、边界情况

| 场景 | 处理 |
|------|------|
| L1_S=21.0 正好 | 跃迁（≥21 满足） |
| L1_S=21 但 review_count=4 | 不跃迁 |
| 重复跃迁 | 幂等跳过 |
| 跃迁失败 | catch+记日志，不回滚 L1 |
| L2 首次即 again | S 降至 max(L2_S×0.3, L1_S×0.1) |
| L1/L2 同日到期 | 各自独立复习 |
| L2 暂停期间 L2 扩展 | markL2StaleForRecheck WHERE l2_paused=false，暂停词不触发重卡 |
| 手动暂停后手动解冻 | reason=manual，解冻后 l2_due_at=now() |
| L2 weights 未优化时 L1 weights 变更 | L2 fallback 到新 L1 weights（直到 L2 独立优化） |

---

## 十四、风险与对策

| 风险 | 对策 |
|------|------|
| 分层 hash 回填慢 | 离线脚本 scripts/backfill-content-hash.ts 分批 1000 词/批，每词 computeL1Hash + computeL2Hash 回填。验收：回填后 l1_content_hash 非空率 100%（漏洞9修复） |
| 全量与分层 hash 不一致 | 导入时同时更新三个 hash |
| 跃迁在事务内失败 | 放 saveAnswer 后，失败只记日志不回滚 |
| recent_ratings jsonb 膨胀 | 只存最近 5 条，不建索引 |
| l2_paused 词被遗忘 | 每周 cron 检查超 30 天提醒 |
| L2 weights 数据不足时过拟合 | 400 阈值 + 可配置 |

---

## 十五、决策记录（2026-07-07 深度调研后整合）

### 决策 1：L2 retention = 0.900（非 0.950）

FSRS interval = S × 9 × (R^(-2) - 1)：
- 0.95 的间隔系数 0.97S → stability=5.25d 时 5 天后就要再辨析，负担太重
- 0.90 的间隔系数 2.12S → 11d 起步，随 stability 增长到数月，这才是"持久化"
- L1=0.85（速刷底线）/ L2=0.9（标准持久化）差异明确但不过分
- CHECK 收紧为 >= 0.900 AND <= 0.990

### 决策 2：跨轨联动分级——L2→L1 只标记，L1→L2 自动暂停

两个方向因果链强度不同：
- L2 失败 → L1：弱（辨析失败≠识别不牢）→ 只标记 l1_weak_signal=true，用户决定是否重刷
- L1 失败 → L2：强（识别都没了辨析无意义）→ 自动暂停 L2，L1 恢复后自动解冻
- 新增字段：user_word_progress.l1_weak_signal boolean

### 决策 3：review_logs 共享 + track 字段

- 共享 review_logs 表 + track 字段（'l1'/'l2'）
- progress_id 去 FK 改裸 uuid（应用层校验）
- 优势：weights 优化/导出/幂等都用单表查询，不需跨表 UNION

### 10 个漏洞修复

1. L2_S 下限 = max(result, 1.0d)——防"4 小时后就要辨析"的惩罚地狱
2. 跃迁 catch 只吞 23505 unique violation——不吞 schema 错误
3. L2 desired_retention CHECK >= 0.900——L2 不能低于 0.9
4. saveAnswer 参数编号位移——实施时逐个核对 $1-$14
5. 新建 L2ReviewService.submitL2Answer——复用 fsrsAdapter，独立 progress 表
6. l2_scheduler_payload = StoredSchedulerCard 格式——与 L1 一致
7. review_logs 加 track + 去 FK——共享表方案
8. recent_ratings append + slice(-5)——saveAnswer SQL 追加更新
9. content_hash 回填脚本——scripts/backfill-content-hash.ts 分批 1000/批
10. 暂停不改 l2_due_at，解冻 SET l2_due_at=now()——避免暂停后惩罚
