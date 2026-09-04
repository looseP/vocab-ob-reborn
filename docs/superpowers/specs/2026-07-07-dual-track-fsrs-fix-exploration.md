# 双轨 FSRS 深度修复探索

- **Status**: Fix Exploration / 基于代码验证
- **Date**: 2026-07-07
- **Base**: `2026-07-06-self-growing-knowledge-chain.md` 决策 1（L1/L2 双轨隔离）
- **审查基础**: 对双轨 FSRS 初始设计的 5 项审查发现
- **代码验证**: v2 `schema.ts` / `review.service.ts` / `review.repository.ts` 实际读取

---

## 审查发现回顾

| # | 问题 | 严重度 | 根因 |
|---|------|--------|------|
| 1 | inherit_ratio 公式数学错误 | 🔴 | `min(0.5, L1_S/(L1_S+21))` 在 L1_S=21 给出 0.5 不是 0.25 |
| 2 | L2_state 应为 Review 非 Learning | 🟡 | Learning 是分钟级间隔，L2_S=5.25d 需天级调度 |
| 3 | content_hash 分层遗漏 | 🔴 | `markStaleForRecheck` 用全量 hash，L2 扩展会误触发 L1 重卡 |
| 4 | 跨轨"连续"定义不精确 | 🟡 | "连续 again×3" 歧义，需明确滑动窗口 |
| 5 | L2 暂停状态字段缺失 | 🟡 | "L2 暂停"无存储字段和恢复机制 |

---

## 代码验证结论（修复前的事实基线）

### ✅ 已兼容（无需改现有代码）

1. **desired_retention 是 per-progress 的**（`schema.ts:121` + `review.service.ts:112`）
   - L1 progress 行设 `desired_retention=0.85`，L2 progress 行设 `0.95`
   - FSRS adapter 从 `progress.desired_retention` 读取，天然支持双轨
   - check 约束 `0.700-0.990`（`schema.ts:168`）覆盖两个值 ✓

2. **state check 约束已含 'review'**（`schema.ts:167`）
   - 修复 #2 的 `L2_state=Review` 在现有约束内 ✓

3. **FSRS adapter 是注入的**（`review.service.ts:44-50`）
   - L1/L2 共用同一 adapter（ts-fsrs repeat() 逻辑相同，参数不同）
   - `loadWeights` 按 wordbookId 加载，L2 weights 可扩展为 `loadL2Weights` ✓

### 🔴 需要改现有代码

4. **`markStaleForRecheck` 用全量 content_hash**（`review.repository.ts:411-427`）
   - `content_hash_snapshot != $1` 对比的是 words 表全量 hash
   - L2 扩展改了 `words.content_hash` → 触发 L1 `needs_recheck=true` + `state→relearning` + `due_at=now()`
   - **这直接违背双轨隔离承诺** → 修复 #3 必须做

5. **`saveAnswer` 写 `content_hash_snapshot`**（`review.repository.ts:169`）
   - 用 `progress.content_hash`（words 表全量 hash）更新快照
   - 修复 #3 需要改为分层 hash 快照

6. **`findStaleProgress` 用全量 hash 对比**（`review.repository.ts:396-404`）
   - `content_hash_snapshot != (SELECT content_hash FROM words ...)`
   - 修复 #3 需要分 L1/L2 版本

---

## 修复 1: inherit_ratio 公式修正

### 问题

```typescript
// 原设计（错误）
inherit_ratio = Math.min(0.5, l1Stability / (l1Stability + 21))
// L1_S=21 → 21/42 = 0.5（不是声称的 0.25）
// L1_S=42 → 42/63 = 0.67 → min=0.5（几乎刚过阈就到上限）
```

### 修正

```typescript
// 修正后
function computeInheritRatio(l1Stability: number): number {
  const threshold = 21; // 跃迁阈值
  return 0.5 * l1Stability / (l1Stability + threshold);
}
```

| L1_S | 原公式 | 修正后 | L2_S (修正) |
|------|--------|--------|-------------|
| 21（刚过阈）| 0.5 ❌ | **0.25** ✅ | 5.25d |
| 42 | 0.5 | 0.333 | 14.0d |
| 63 | 0.5 | 0.375 | 23.6d |
| 90 | 0.5 | 0.409 | 36.8d |
| 180（极稳）| 0.5 | 0.448 | 80.6d |
| ∞ | 0.5 | 0.5 | — |

### 实现位置

跃迁触发器（新建 `src/services/l2-transition.service.ts`）：

```typescript
export class L2TransitionService {
  constructor(private repos: Repositories) {}

  /**
   * 在 L1 submitAnswer 事务内调用（saveAnswer 后）。
   * 检查是否满足跃迁条件，若满足创建 L2 progress 记录。
   */
  async checkAndTransition(
    tx: PoolClient,
    progress: UserWordProgressRow,
  ): Promise<void> {
    // 跃迁条件
    if (progress.stability < 21) return;
    if (progress.review_count < 5) return;
    if (!['good', 'easy'].includes(progress.last_rating)) return;

    // 检查是否已有 L2 progress（幂等）
    const existing = await this.repos.l2Progress.findByWordAndUser(
      progress.user_id, progress.word_id,
    );
    if (existing) return; // 已跃迁过

    // 计算继承参数
    const inheritRatio = 0.5 * progress.stability / (progress.stability + 21);
    const l2Stability = progress.stability * inheritRatio;
    const l2Difficulty = Math.min(10, (progress.difficulty ?? 5) + 2.0);

    // 创建 L2 progress（state=Review，非 New/Learning）
    await this.repos.l2Progress.insert({
      user_id: progress.user_id,
      word_id: progress.word_id,
      l2_stability: l2Stability,
      l2_difficulty: l2Difficulty,
      l2_state: 'review',          // 修复 #2: Review 非 Learning
      l2_desired_retention: 0.95,  // L2 高保留
      l2_due_at: new Date(Date.now() + l2Stability * 86400000),
      l2_review_count: 0,
      l2_weights_source: 'inherited',  // 标记 weights 来源
      l2_inherited_from_l1: true,      // 审计标记
    });
  }
}
```

### 兼容性

- **新逻辑，不改现有代码** ✓
- 插入点：`review.service.ts:submitAnswer` 的 step 7（saveAnswer）后、step 8（session 计数）前
- 同事务内，失败回滚不影响 L1 复习结果

### 边界情况

| 场景 | 处理 |
|------|------|
| L1_S 正好 21.0 | 跃迁（≥21 满足） |
| L1_S=21 但 review_count=4 | 不跃迁（review_count<5） |
| 已有 L2 progress（重复跃迁） | 幂等跳过 |
| L1_S=21 但 last_rating=hard | 不跃迁（rating 不满足） |
| L1_S=21 但 last_rating=again | 不跃迁 |

---

## 修复 2: L2_state = Review

### 问题

FSRS 四状态的调度语义：

| state | 调度 | 间隔级别 |
|-------|------|---------|
| New | init 算法（重新计算 S/D） | — |
| Learning | learning steps（如 1min→10min） | 分钟级 |
| **Review** | **repeat() 标准公式（S×增长因子）** | **天/月级** |
| Relearning | 重新 learning steps | 分钟级 |

L2 初始 stability = 5.25d（天级），用 `Learning` 会让 ts-fsrs 用分钟级间隔——与 L2_S 矛盾。

### 修正

```typescript
L2_state = 'review'  // 不是 'learning'
```

### ts-fsrs 兼容性验证

ts-fsrs 的 `repeat(card, now, rating)` 内部逻辑：
- `card.state === State.Review` → 用 `next_state_for_review_card()`（基于 S/D 的标准调度）
- 不检查 `card.reps` 是否为 0——只要 state=Review 且有 stability/difficulty，就用 Review 调度

所以 `state=Review + reps=0` 是合法组合，FSRS 会正确按天级间隔调度。

### 实现位置

同修复 1 的 `L2TransitionService.checkAndTransition`——创建 L2 progress 时设 `l2_state: 'review'`。

---

## 修复 3: content_hash 分层（最复杂）

### 问题

现有漂移检测链路（`review.repository.ts:396-427`）：

```
words.content_hash（全量）
    ↓
user_word_progress.content_hash_snapshot（复习时快照）
    ↓
markStaleForRecheck: snapshot != current_hash → needs_recheck=true + state→relearning
```

L2 扩展改 `words.content_hash` → 触发 L1 重卡。**违背隔离**。

### 修正：分层 hash

#### 3.1 words 表新增列

```sql
ALTER TABLE words
  ADD COLUMN l1_content_hash text,
  ADD COLUMN l2_content_hash text;

-- 保留原 content_hash 列（向后兼容：导入去重仍用全量 hash）
```

```typescript
// schema.ts words 表追加
l1ContentHash: text("l1_content_hash"),
l2ContentHash: text("l2_content_hash"),
```

#### 3.2 hash 计算函数

```typescript
// src/db/content-hash.ts（新建）
import { createHash } from "crypto";

/** L1 hash: 只基于 L1 字段 */
export function computeL1Hash(word: {
  definition_md: string;
  core_definitions: unknown;
  prototype_text: string | null;
  metadata: { morphology?: unknown; mnemonic?: unknown; semantic_chain?: unknown };
}): string {
  const l1Payload = JSON.stringify({
    definition_md: word.definition_md,
    core_definitions: word.core_definitions,
    prototype_text: word.prototype_text,
    morphology: word.metadata?.morphology,
    mnemonic: word.metadata?.mnemonic,
    semantic_chain: word.metadata?.semantic_chain,
  });
  return createHash("sha256").update(l1Payload).digest("hex");
}

/** L2 hash: 只基于 L2 字段 */
export function computeL2Hash(word: {
  collocations: unknown[];
  corpus_items: unknown[];
  synonym_items: unknown[];
  antonym_items: unknown[];
}): string {
  const l2Payload = JSON.stringify({
    collocations: word.collocations,
    corpus_items: word.corpus_items,
    synonym_items: word.synonym_items,
    antonym_items: word.antonym_items,
  });
  return createHash("sha256").update(l2Payload).digest("hex");
}

/** 全量 hash: 保留用于导入去重（向后兼容） */
export function computeFullHash(word: {...}): string {
  // 现有逻辑不变
}
```

#### 3.3 user_word_progress 表新增列

```sql
ALTER TABLE user_word_progress
  ADD COLUMN l1_content_hash_snapshot text;  -- L1 漂移检测快照
-- 保留原 content_hash_snapshot（向后兼容）
```

#### 3.4 user_word_l2_progress 表新增列

```sql
ALTER TABLE user_word_l2_progress
  ADD COLUMN l2_content_hash_snapshot text;  -- L2 漂移检测快照
```

#### 3.5 markStaleForRecheck 分层

```typescript
// review.repository.ts 改造

/** L1 漂移 → 只触发 L1 重卡（不影响 L2） */
async markL1StaleForRecheck(wordId: string, newL1Hash: string): Promise<number> {
  const rows = await this.query<{ id: string }>(
    `UPDATE user_word_progress
     SET l1_content_hash_snapshot = $1,
         needs_recheck = true,
         state = CASE
           WHEN state = 'review' THEN 'relearning'
           WHEN state = 'new' THEN 'new'
           ELSE state
         END,
         due_at = now()
     WHERE word_id = $2::uuid
       AND l1_content_hash_snapshot IS NOT NULL
       AND l1_content_hash_snapshot != $1
     RETURNING id`,
    [newL1Hash, wordId],
  );
  return rows.length;
}

/** L2 漂移 → 只触发 L2 重卡（不影响 L1） */
async markL2StaleForRecheck(wordId: string, newL2Hash: string): Promise<number> {
  const rows = await this.query<{ id: string }>(
    `UPDATE user_word_l2_progress
     SET l2_content_hash_snapshot = $1,
         l2_due_at = now()
         -- 不改 l2_state（L2 软重卡：只到期，不降 state）
     WHERE word_id = $2::uuid
       AND l2_content_hash_snapshot IS NOT NULL
       AND l2_content_hash_snapshot != $1
       AND l2_paused = false
     RETURNING id`,
    [newL2Hash, wordId],
  );
  return rows.length;
}
```

#### 3.6 saveAnswer 改造

```typescript
// review.repository.ts saveAnswer 改造
// 原：content_hash_snapshot = $11（全量 hash）
// 改：l1_content_hash_snapshot = $11（L1 hash）

await this.query(
  `UPDATE user_word_progress
   SET difficulty = $1, due_at = $2, interval_days = $3,
       last_reviewed_at = $4, last_rating = $5, lapse_count = $6,
       retrievability = $7, review_count = review_count + 1,
       scheduler_payload = $8, stability = $9, state = $10,
       ${counterField} = ${counterField} + 1,
       l1_content_hash_snapshot = $11,  -- 改：L1 hash 快照
       -- 保留 content_hash_snapshot = $12（全量，向后兼容）
       updated_at = $13
   WHERE id = $14::uuid`,
  // ...params
);
```

#### 3.7 L2 扩展时的 hash 更新

```typescript
// L2ContentService.extendL2 改造
async extendL2(params: {...}): Promise<void> {
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);

    // 1. 写 word_l2_content
    await repos.l2content.insert({ ...params });

    // 2. 刷新 words 表 L2 JSONB 缓存
    await this.refreshL2Cache(tx, params.wordId);

    // 3. 重算 L2 hash（不算 L1 hash——L1 没变）
    const word = await repos.words.findById(params.wordId);
    const newL2Hash = computeL2Hash(word);
    await repos.words.updateL2Hash(params.wordId, newL2Hash);

    // 4. 只触发 L2 重卡（不触发 L1）—— 修复 #3 核心
    await repos.reviews.markL2StaleForRecheck(params.wordId, newL2Hash);

    // 5. 全量 hash 也更新（导入去重用）
    const newFullHash = computeFullHash(word);
    await repos.words.updateContentHash(params.wordId, newFullHash);
  });
}
```

### 兼容性

| 现有功能 | 影响 | 处理 |
|---------|------|------|
| 导入去重（words.content_hash 唯一约束）| 无 | 保留全量 hash 列 |
| saveAnswer 的 content_hash_snapshot | 改名 | 新增 l1_content_hash_snapshot，保留原列 |
| markStaleForRecheck | 分层 | 新增 markL1StaleForRecheck + markL2StaleForRecheck |
| findStaleProgress | 分层 | 新增 findL1StaleProgress + findL2StaleProgress |

### 数据迁移

```sql
-- 回填 l1_content_hash / l2_content_hash
UPDATE words SET
  l1_content_hash = ... -- 用 computeL1Hash 逻辑回填
  l2_content_hash = ... -- 用 computeL2Hash 逻辑回填
WHERE l1_content_hash IS NULL;

-- 回填 l1_content_hash_snapshot
UPDATE user_word_progress uwp
SET l1_content_hash_snapshot = w.l1_content_hash
FROM words w
WHERE uwp.word_id = w.id
  AND uwp.l1_content_hash_snapshot IS NULL
  AND uwp.content_hash_snapshot IS NOT NULL;
```

---

## 修复 4: 滑动窗口 recent_ratings

### 问题

"连续 again×3" 歧义——是最近 3 次还是任意历史 3 连？

### 修正：滑动窗口最近 N 次

#### 4.1 新增字段

```sql
ALTER TABLE user_word_progress
  ADD COLUMN recent_ratings jsonb DEFAULT '[]';

ALTER TABLE user_word_l2_progress
  ADD COLUMN recent_ratings jsonb DEFAULT '[]';
```

#### 4.2 saveAnswer 更新滑动窗口

```typescript
// review.repository.ts saveAnswer 追加
// recent_ratings = jsonb_path_query_array(
//   recent_ratings || $rating::jsonb,
//   '$[last 5 to last]'
// )

await this.query(
  `UPDATE user_word_progress
   SET ...
       recent_ratings = (
         SELECT jsonb_agg(elem)
         FROM (
           SELECT elem
           FROM jsonb_array_elements(
             recent_ratings || to_jsonb($15::text)
           ) WITH ORDINALITY AS t(elem, ord)
           ORDER BY ord DESC
           LIMIT 5
         ) sub
         ORDER BY ord ASC
       )
   WHERE id = $14::uuid`,
  [...params, input.rating],
);
```

#### 4.3 跨轨联动检查

```typescript
// src/services/cross-track.service.ts（新建）
export class CrossTrackService {

  /** L2 复习后检查：最近 3 次 L2 全 again → L1 软重卡 */
  async checkL2FailureCascade(
    tx: PoolClient,
    l2Progress: L2ProgressRow,
  ): Promise<void> {
    const recent = l2Progress.recent_ratings ?? [];
    if (recent.length >= 3 &&
        recent.slice(-3).every(r => r === 'again')) {
      // L1 软重卡（只到期，不重置 stability）
      await this.repos.reviews.softRecheckL1(
        tx, l2Progress.word_id, l2Progress.user_id,
      );
    }
  }

  /** L1 复习后检查：最近 2 次 L1 全 again → L2 暂停 */
  async checkL1FailureCascade(
    tx: PoolClient,
    l1Progress: UserWordProgressRow,
  ): Promise<void> {
    const recent = l1Progress.recent_ratings ?? [];
    if (recent.length >= 2 &&
        recent.slice(-2).every(r => r === 'again')) {
      await this.repos.l2Progress.pause(
        tx, l1Progress.word_id, l1Progress.user_id,
        'l1_cascade_failure',
      );
    }
  }

  /** L1 复习后检查：最近 2 次 L1 全 good+ → L2 解冻 */
  async checkL1Recovery(
    tx: PoolClient,
    l1Progress: UserWordProgressRow,
  ): Promise<void> {
    const recent = l1Progress.recent_ratings ?? [];
    if (recent.length >= 2 &&
        recent.slice(-2).every(r => ['good', 'easy'].includes(r))) {
      await this.repos.l2Progress.unpause(
        tx, l1Progress.word_id, l1Progress.user_id,
      );
    }
  }
}
```

---

## 修复 5: L2 暂停状态字段

### 修正

```sql
ALTER TABLE user_word_l2_progress
  ADD COLUMN l2_paused boolean DEFAULT false NOT NULL,
  ADD COLUMN l2_paused_at timestamptz,
  ADD COLUMN l2_paused_reason text;
-- reason 枚举：'l1_cascade_failure' / 'wordbook_focus' / 'manual'
```

```typescript
// L2 progress repository
async pause(tx, wordId, userId, reason: string): Promise<void> {
  await this.query(
    `UPDATE user_word_l2_progress
     SET l2_paused = true, l2_paused_at = now(), l2_paused_reason = $3
     WHERE word_id = $1 AND user_id = $2`,
    [wordId, userId, reason],
  );
}

async unpause(tx, wordId, userId): Promise<void> {
  await this.query(
    `UPDATE user_word_l2_progress
     SET l2_paused = false, l2_paused_at = null, l2_paused_reason = null,
         l2_due_at = now()  -- 解冻后立即到期
     WHERE word_id = $1 AND user_id = $2
       AND l2_paused = true
       AND l2_paused_reason = 'l1_cascade_failure'`,  -- 只自动解冻级联暂停
    [wordId, userId],
  );
}
```

### L2 队列查询过滤

```typescript
// findDueL2Cards 查询追加条件
async findDueL2Cards(userId: string, limit: number): Promise<L2ProgressRow[]> {
  return this.query(
    `SELECT ${L2_PROGRESS_COLUMNS}
     FROM user_word_l2_progress
     WHERE user_id = $1
       AND l2_paused = false          -- 过滤暂停
       AND l2_due_at <= now()
       AND l2_state != 'suspended'
     ORDER BY l2_due_at ASC
     LIMIT $2`,
    [userId, limit],
  );
}
```

### 暂停语义矩阵

| reason | 触发 | 解冻 |
|--------|------|------|
| `l1_cascade_failure` | L1 最近 2 次全 again | L1 最近 2 次全 good+（自动） |
| `wordbook_focus` | 进入词书专注模式 | 退出专注模式（自动） |
| `manual` | 用户手动暂停 | 用户手动解冻 |

---

## 修复后的完整数据模型

### user_word_progress（L1 轨，改）

```sql
-- 新增列
ALTER TABLE user_word_progress
  ADD COLUMN l1_content_hash_snapshot text,   -- 修复 #3
  ADD COLUMN recent_ratings jsonb DEFAULT '[]'; -- 修复 #4

-- 保留列（向后兼容）
-- content_hash_snapshot（全量，导入去重用）
-- needs_recheck（L1 漂移标记）
```

### user_word_l2_progress（L2 轨，新建+补字段）

```sql
CREATE TABLE user_word_l2_progress (
  -- FSRS 调度
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  word_id uuid NOT NULL REFERENCES words(id),
  l2_stability numeric(10,4),
  l2_difficulty numeric(10,4),
  l2_retrievability numeric(8,6),
  l2_state text DEFAULT 'review' NOT NULL,  -- 修复 #2: Review 非 Learning
  l2_desired_retention numeric(4,3) DEFAULT 0.950 NOT NULL,  -- L2 高保留
  l2_due_at timestamptz,
  l2_last_reviewed_at timestamptz,
  l2_last_rating text,
  l2_review_count integer DEFAULT 0 NOT NULL,
  l2_lapse_count integer DEFAULT 0 NOT NULL,
  l2_interval_days integer,
  l2_scheduler_payload jsonb DEFAULT '{}' NOT NULL,

  -- 漂移检测（修复 #3）
  l2_content_hash_snapshot text,

  -- 滑动窗口（修复 #4）
  recent_ratings jsonb DEFAULT '[]',

  -- 暂停状态（修复 #5）
  l2_paused boolean DEFAULT false NOT NULL,
  l2_paused_at timestamptz,
  l2_paused_reason text,

  -- 审计
  l2_inherited_from_l1 boolean DEFAULT false,  -- 修复 #1: 标记继承来源
  l2_weights_source text DEFAULT 'inherited',   -- 'inherited' / 'optimized'
  l2_predicted_retrievability numeric(8,6),
  l3_pending boolean DEFAULT false,
  l3_self_assessments jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),

  -- 约束
  UNIQUE(user_id, word_id),
  CHECK (l2_state = ANY(ARRAY['new','learning','review','relearning','suspended'])),
  CHECK (l2_desired_retention >= 0.700 AND l2_desired_retention <= 0.990),
  CHECK (l2_paused_reason IS NULL OR l2_paused_reason = ANY(
    ARRAY['l1_cascade_failure','wordbook_focus','manual']
  ))
);
```

### words 表（补列）

```sql
ALTER TABLE words
  ADD COLUMN l1_content_hash text,  -- 修复 #3
  ADD COLUMN l2_content_hash text;  -- 修复 #3
-- 保留 content_hash（全量，向后兼容）
```

---

## 修复依赖关系与实施顺序

```
修复 #3 (content_hash 分层) ─────┐
                                 ├──→ 修复 #1 (inherit_ratio) ──→ 修复 #2 (state)
修复 #4 (recent_ratings) ────────┤
                                 └──→ 修复 #5 (l2_paused)
```

**建议顺序**：

1. **修复 #3 先行**（最复杂、最关键）—— content_hash 分层是一切的基础，不做就无法实现隔离
2. **修复 #1 + #2**（跃迁逻辑）—— 依赖 #3 的分层 hash（L2 扩展时不触发 L1）
3. **修复 #4 + #5**（跨轨联动）—— 依赖 #1 的 L2 progress 表存在

### Phase 分解

| Phase | 修复 | 工作量 | 验收 |
|-------|------|--------|------|
| A | #3 content_hash 分层 | 大 | L2 扩展后 L1 needs_recheck 不变 |
| B | #1+#2 跃迁+初始化 | 中 | L1_S≥21 后自动创建 L2 progress，state=Review |
| C | #4+#5 跨轨联动 | 中 | L2 连续 again×3 → L1 软重卡；L1 连续 again×2 → L2 暂停 |

---

## 修复引入的新问题及对策

| 新问题 | 风险 | 对策 |
|--------|------|------|
| #3 回填 l1/l2_content_hash 需全表扫描 | 迁移慢 | 离线脚本分批回填，每批 1000 词 |
| #3 全量 hash 与分层 hash 不一致 | 导入去重冲突 | 导入时同时更新三个 hash |
| #1 跃迁在事务内失败回滚 | L1 复习结果丢失 | 跃迁放在 saveAnswer 之后，失败只记日志不回滚 |
| #4 recent_ratings jsonb 膨胀 | 查询慢 | 只存最近 5 条，jsonb 不建索引（滑动窗口小） |
| #5 l2_paused 词被遗忘 | 永久暂停 | 每周 cron 检查 l2_paused 超过 30 天的词，提醒用户 |
