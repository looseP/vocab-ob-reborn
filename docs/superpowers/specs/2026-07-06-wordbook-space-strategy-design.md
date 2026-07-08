# Wordbook Space Strategy Design

**Date**: 2026-07-06
**Status**: Approved (pending user spec review)
**Project**: vocab-observatory-v2

## 1. Problem Statement

当前 v2 后端的词书空间设计继承自 v1（migration 0022-0024），支持：
- 扁平词书（无层级嵌套）
- per-wordbook 进度隔离（`UNIQUE(user_id, word_id, wordbook_id)`）
- per-wordbook 笔记/会话/FSRS 设置隔离
- 词条多对多分配到词书（`wordbook_items`）

但缺少以下能力：
1. **词书分组/嵌套** — 无法把「基础词」「雅思词汇」放到「英语」分类下
2. **跨词书筛选复习** — 无法按标签从多个词书抽卡组成临时学习队列
3. **同词跨词书灵活进度** — 同一词条在不同词书进度始终独立，用户无法选择"合并进度"
4. **合并后复习记录统一管理** — 合并的词需要所有复习读写走全局层

## 2. Design Decisions

### 2.1 核心规则

> 标记为"已合并"的词，所有复习相关数据的读写都走全局层。各词书的独立 progress 和 review_logs 在合并期间不再被读写。笔记始终独立。

### 2.2 合并基准词书选择

- **默认**：自动选 `review_count` 最多（相同时取 `stability` 最高）的词书进度为基准
- **可选**：用户可手动指定"合并归属'xxx'词书"，覆盖默认选择

### 2.3 取消合并策略

用户选择：
- **全量复制**：master 当前 FSRS 状态复制到所有参与词书的 progress 行；全局层 review_logs 可选拉取增量到各词书
- **恢复备份**：各 progress 行恢复到合并前快照（`snapshot_jsonb`）；全局层 review_logs 保留不拉取

### 2.4 笔记独立性

笔记（notes/highlights/annotations）始终绑定 `(wordbook_id, word_id)`，进度合并不影响笔记。不同词书对同一词的笔记内容可以不同。

### 2.5 review_logs 全局层

合并后的复习记录写入全局层：
- `wordbook_id = NULL`（不绑定具体词书）
- `progress_id = NULL`（不绑定具体 progress 行）
- `master_progress_id = master.id`（绑定到全局进度）

词书统计查询用 `WHERE wordbook_id IS NOT NULL` 过滤全局记录，防止污染。

## 3. Data Model

### 3.1 新增表：word_progress_master

Per-word 全局进度，结构与 `user_word_progress` 的 FSRS 字段一致。

```sql
CREATE TABLE word_progress_master (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  word_id         uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,

  -- FSRS scheduling fields (mirrors user_word_progress)
  schedule_algo   text NOT NULL DEFAULT 'fsrs'
                    CHECK (schedule_algo IN ('leitner','sm2','fsrs')),
  state           text NOT NULL DEFAULT 'new'
                    CHECK (state IN ('new','learning','review','relearning','suspended')),
  desired_retention numeric(4,3) NOT NULL DEFAULT 0.900
                    CHECK (desired_retention >= 0.700 AND desired_retention <= 0.990),
  stability       numeric(10,4),
  difficulty      numeric(10,4),
  retrievability  numeric(8,6),
  interval_days   integer,

  due_at          timestamptz,
  last_reviewed_at timestamptz,
  last_rating     review_rating,  -- nullable enum

  review_count    integer NOT NULL DEFAULT 0,
  lapse_count     integer NOT NULL DEFAULT 0,
  again_count     integer NOT NULL DEFAULT 0,
  hard_count      integer NOT NULL DEFAULT 0,
  good_count      integer NOT NULL DEFAULT 0,
  easy_count      integer NOT NULL DEFAULT 0,
  skip_count      integer NOT NULL DEFAULT 0,

  content_hash_snapshot text,
  scheduler_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  needs_recheck   boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT word_progress_master_user_word_key UNIQUE (user_id, word_id)
);

CREATE INDEX idx_master_due ON word_progress_master (user_id, due_at);
CREATE INDEX idx_master_word ON word_progress_master (word_id);

-- updated_at trigger (reuse handle_updated_at)
CREATE TRIGGER trg_master_updated_at
  BEFORE UPDATE ON word_progress_master
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
```

### 3.2 user_word_progress 新增列

```sql
ALTER TABLE user_word_progress
  ADD COLUMN master_progress_id uuid NULL
    REFERENCES word_progress_master(id) ON DELETE SET NULL,
  ADD COLUMN snapshot_jsonb jsonb NULL;
  -- snapshot_jsonb: 合并时备份的原始 FSRS 字段快照，用于取消合并时"恢复备份"

CREATE INDEX idx_uwp_master ON user_word_progress (master_progress_id)
  WHERE master_progress_id IS NOT NULL;
```

- `master_progress_id NULL` = 独立模式（现有行为不变）
- `master_progress_id 非 NULL` = 合并模式（FSRS 读写走 master）

### 3.3 review_logs 改动

```sql
ALTER TABLE review_logs
  ALTER COLUMN wordbook_id DROP NOT NULL,  -- NULL = 全局层记录
  ADD COLUMN master_progress_id uuid NULL
    REFERENCES word_progress_master(id) ON DELETE SET NULL;

CREATE INDEX idx_review_logs_master ON review_logs (master_progress_id)
  WHERE master_progress_id IS NOT NULL;
```

- `wordbook_id NULL` + `master_progress_id 非 NULL` = 合并后的全局复习记录
- `wordbook_id 非 NULL` + `master_progress_id NULL` = 独立模式的词书复习记录（现有行为）
- 存量数据不受影响（全部是 `wordbook_id 非 NULL`）

### 3.4 wordbooks 新增列（层级嵌套）

```sql
ALTER TABLE wordbooks
  ADD COLUMN parent_id uuid NULL REFERENCES wordbooks(id) ON DELETE CASCADE;

CREATE INDEX idx_wordbooks_parent ON wordbooks (parent_id)
  WHERE parent_id IS NOT NULL;
```

### 3.5 sessions 改动（跨词书筛选复习）

```sql
ALTER TABLE sessions
  ALTER COLUMN wordbook_id DROP NOT NULL,  -- NULL = 筛选会话
  ADD COLUMN scope_jsonb jsonb NULL;
  -- scope_jsonb: { "type": "filtered", "wordbookIds": ["uuid1","uuid2"], "tag": "难词" }
```

## 4. Merge Flow

### 4.1 合并操作

```
输入：userId, wordId, 参与合并的 wordbookIds[], 基准 wordbookId（可选）

1. 查询所有参与合并的 progress 行（必须都是独立模式）：
   SELECT * FROM user_word_progress
   WHERE user_id = $userId AND word_id = $wordId
     AND wordbook_id = ANY($wordbookIds)
     AND master_progress_id IS NULL

   如果不足 2 行 → 抛 BusinessRuleError("至少需要 2 个词书的进度才能合并")

2. 选择基准 progress：
   - 如果用户指定了基准 wordbookId：
     基准 = 上述结果中 wordbook_id = 基准的那行
     如果不存在 → 抛 NotFoundError
   - 如果未指定（默认）：
     基准 = 上述结果中 review_count 最多（相同时 stability 最高）的那行

3. 创建 word_progress_master 行：
   INSERT INTO word_progress_master (
     user_id, word_id,
     schedule_algo, state, desired_retention,
     stability, difficulty, retrievability, interval_days,
     due_at, last_reviewed_at, last_rating,
     review_count, lapse_count, again_count, hard_count,
     good_count, easy_count, skip_count,
     content_hash_snapshot, scheduler_payload, needs_recheck
   )
   SELECT 同名字段 FROM user_word_progress WHERE id = $基准.id

4. 复制基准词书的历史 review_logs 到全局层：
   INSERT INTO review_logs (
     user_id, word_id, wordbook_id, progress_id, master_progress_id,
     rating, state, stability, difficulty, due_at,
     reviewed_at, elapsed_days, scheduled_days,
     metadata, previous_progress_snapshot, idempotency_key
   )
   SELECT
     user_id, word_id,
     NULL,           -- wordbook_id = NULL（全局层）
     NULL,           -- progress_id = NULL
     $master.id,     -- master_progress_id
     rating, state, stability, difficulty, due_at,
     reviewed_at, elapsed_days, scheduled_days,
     metadata, previous_progress_snapshot, idempotency_key
   FROM review_logs
   WHERE progress_id = $基准.id
   ORDER BY reviewed_at ASC

5. 更新所有参与 progress 行：
   UPDATE user_word_progress
   SET master_progress_id = $master.id,
       snapshot_jsonb = to_jsonb(整行 FSRS 字段快照)
   WHERE id IN (所有参与 progress 行的 id)

6. 全部在一个事务内执行
```

### 4.2 取消合并操作

```
输入：userId, wordId, 策略("copy_latest" | "restore_snapshot")

1. 查 master：
   SELECT * FROM word_progress_master
   WHERE user_id = $userId AND word_id = $wordId

2. 查所有引用此 master 的 progress 行：
   SELECT * FROM user_word_progress WHERE master_progress_id = $master.id

3a. 策略 = "copy_latest"（全量复制）：
   对每个 progress 行：
   UPDATE user_word_progress
   SET stability = master.stability,
       difficulty = master.difficulty,
       ... (全部 FSRS 字段 = master 当前值),
       master_progress_id = NULL,
       snapshot_jsonb = NULL
   WHERE id = $progress.id

   可选：拉取全局层 review_logs 增量到各词书
   INSERT INTO review_logs (..., wordbook_id, progress_id, master_progress_id=NULL)
   SELECT ..., $progress.wordbook_id, $progress.id, NULL
   FROM review_logs WHERE master_progress_id = $master.id

3b. 策略 = "restore_snapshot"（恢复备份）：
   对每个 progress 行：
   UPDATE user_word_progress
   SET stability = (snapshot_jsonb->>'stability')::numeric,
       difficulty = (snapshot_jsonb->>'difficulty')::numeric,
       ... (全部 FSRS 字段 = snapshot 值),
       master_progress_id = NULL,
       snapshot_jsonb = NULL
   WHERE id = $progress.id

4. 删除全局层 review_logs（恢复备份模式下保留，全量复制模式下可选删除）
   -- "restore_snapshot": 不删除，全局记录留作历史
   -- "copy_latest": 可选删除或保留

5. 删除 master 行：
   DELETE FROM word_progress_master WHERE id = $master.id

6. 全部在一个事务内执行
```

## 5. Read/Write Rules (Merged vs Independent)

| 操作 | 独立模式 (master_progress_id=NULL) | 合并模式 (master_progress_id 非 NULL) |
|---|---|---|
| findDueCards | 查 progress 行的 due_at/state | 查 progress 行 → JOIN master 取 due_at/state |
| findProgressForUpdate | SELECT FOR UPDATE progress 行 | SELECT FOR UPDATE **master** 行 |
| saveAnswer | UPDATE progress 行的 FSRS 字段 | UPDATE **master** 的 FSRS 字段 |
| review_logs 写入 | wordbook_id=具体, progress_id=具体, master_progress_id=NULL | wordbook_id=**NULL**, progress_id=**NULL**, master_progress_id=**master.id** |
| 词书统计 | `WHERE wordbook_id=$1` | 全局记录 wordbook_id=NULL 自动排除 |
| 词条完整复习历史 | `WHERE word_id=$1 AND wordbook_id=$2` | `WHERE word_id=$1 AND (wordbook_id=$2 OR master_progress_id IS NOT NULL)` |
| notes/highlights/annotations | 正常按 wordbookId 隔离 | **不变**（笔记始终独立） |

### 5.1 findDueCards 合并模式查询

```sql
SELECT uwp.*, w.slug, w.title, w.lemma,
       COALESCE(m.due_at, uwp.due_at) AS effective_due_at,
       COALESCE(m.state, uwp.state) AS effective_state
FROM user_word_progress uwp
JOIN words w ON w.id = uwp.word_id
LEFT JOIN word_progress_master m ON m.id = uwp.master_progress_id
WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
  AND COALESCE(m.state, uwp.state) != 'suspended'
  AND (COALESCE(m.due_at, uwp.due_at) IS NULL
       OR COALESCE(m.due_at, uwp.due_at) <= now())
ORDER BY COALESCE(m.due_at, uwp.due_at) ASC NULLS FIRST
LIMIT $3
```

### 5.2 findProgressForUpdate 合并模式

```sql
-- 合并模式：锁 master 行，返回 master 的 FSRS 状态 + progress 行的 wordbook 上下文
SELECT m.*, uwp.wordbook_id, uwp.word_id,
       w.content_hash, w.slug AS word_slug, w.title AS word_title, w.lemma AS word_lemma
FROM user_word_progress uwp
JOIN word_progress_master m ON m.id = uwp.master_progress_id
JOIN words w ON w.id = uwp.word_id
WHERE uwp.id = $1::uuid
FOR UPDATE OF m
```

### 5.3 saveAnswer 合并模式

```sql
-- 合并模式：UPDATE master（不更新 progress 行的 FSRS 字段）
UPDATE word_progress_master
SET difficulty = $1, due_at = $2, interval_days = $3,
    lapse_count = lapse_count + $4,
    last_rating = $5, last_reviewed_at = $6,
    retrievability = $7, review_count = review_count + 1,
    scheduler_payload = $8, stability = $9, state = $10,
    ${counterField} = ${counterField} + 1,
    content_hash_snapshot = $11,
    updated_at = $12
WHERE id = $13::uuid

-- review_logs 写入全局层
INSERT INTO review_logs (
  user_id, word_id, wordbook_id, progress_id, master_progress_id,
  rating, state, ...
) VALUES (
  $userId, $wordId,
  NULL,           -- 全局层
  NULL,           -- 不绑定 progress
  $masterId,      -- 绑定 master
  ...
)
```

## 6. Filtered Session (Cross-Wordbook Review)

### 6.1 创建筛选会话

```sql
INSERT INTO sessions (user_id, wordbook_id, mode, scope_jsonb)
VALUES ($userId, NULL, 'review', jsonb_build_object(
  'type', 'filtered',
  'wordbookIds', $wordbookIds::jsonb,
  'tag', $tagSlug
))
```

### 6.2 跨词书查询 due 卡片

```sql
SELECT uwp.*, w.slug, w.title, w.lemma,
       COALESCE(m.due_at, uwp.due_at) AS effective_due_at,
       COALESCE(m.state, uwp.state) AS effective_state
FROM user_word_progress uwp
JOIN words w ON w.id = uwp.word_id
LEFT JOIN word_progress_master m ON m.id = uwp.master_progress_id
-- 如果有 tag 筛选
JOIN word_tags wt ON wt.word_id = uwp.word_id
JOIN tags t ON t.id = wt.tag_id AND t.slug = $tagSlug
WHERE uwp.user_id = $1
  AND uwp.wordbook_id = ANY($2::uuid[])
  AND COALESCE(m.state, uwp.state) != 'suspended'
  AND (COALESCE(m.due_at, uwp.due_at) IS NULL
       OR COALESCE(m.due_at, uwp.due_at) <= now())
ORDER BY COALESCE(m.due_at, uwp.due_at) ASC NULLS FIRST
LIMIT $3
```

### 6.3 筛选会话的 review_logs

筛选复习不是"合并复习"——卡片仍有明确的词书归属。review_logs 记录卡片所属的原始 wordbook_id（非 NULL），但如果该词已合并，也记录 master_progress_id。

## 7. Wordbook Hierarchy

### 7.1 树形查询

```sql
-- 查询词书子树（递归 CTE）
WITH RECURSIVE tree AS (
  SELECT id, name, parent_id, 0 AS depth
  FROM wordbooks WHERE id = $1
  UNION ALL
  SELECT w.id, w.name, w.parent_id, t.depth + 1
  FROM wordbooks w JOIN tree t ON w.parent_id = t.id
)
SELECT * FROM tree ORDER BY depth, name;
```

### 7.2 父词书复习

选择父词书复习时，自动包含所有子词书的 due 卡片。在 Service 层展开子树为 wordbookIds 列表，复用筛选会话机制。

## 8. Architecture Impact

### 8.1 新增 Repository

```
src/repositories/
  master-progress.repository.ts   — word_progress_master CRUD
```

### 8.2 修改的 Repository

| Repository | 改动 |
|---|---|
| ReviewRepository | findDueCards/findProgressForUpdate/saveAnswer 加 COALESCE(master) 分支 |
| StatsRepository | 查询加 `AND wordbook_id IS NOT NULL` 过滤全局记录 |
| WordbookRepository | 新增 findChildren/findSubtree（层级查询） |

### 8.3 新增 Service

```
src/services/
  progress-merge.service.ts    — mergeProgress / unmergeProgress
  filtered-session.service.ts  — createFilteredSession / getFilteredDueCards
```

### 8.4 新增 Domain

```
src/domain/
  master-progress.entity.ts  — MasterProgress 实体
  review.entity.ts           — ReviewCard 增加 isMerged / effectiveDueAt / effectiveState
```

### 8.5 不改动的部分

| 模块 | 理由 |
|---|---|
| notes / note_revisions | 笔记始终独立，不受合并影响 |
| word_highlights / word_annotations | 始终按 wordbookId 隔离 |
| words / tags / word_tags | 内容层不受进度策略影响 |
| wordbooks.settings (FSRS 设置) | per-wordbook 设置不变，合并只影响进度不影设置 |

## 9. Testing Strategy

### 9.1 合并/取消合并测试

- 合并 2 个词书的同词进度 → master 创建 + 历史 logs 复制 + progress 行标记
- 合并后复习 → 读写走 master + review_logs 写全局层
- 取消合并（全量复制）→ 各 progress 获得 master 最新值
- 取消合并（恢复备份）→ 各 progress 恢复 snapshot 值
- 合并后词书统计不包含全局记录
- 合并后笔记仍独立可访问

### 9.2 筛选会话测试

- 跨 2 个词书 + tag 筛选 → 返回符合条件的 due 卡片
- 筛选会话复习 → review_logs 记原始 wordbook_id

### 9.3 层级嵌套测试

- 创建父子词书 → 查询子树返回正确结果
- 父词书复习 → 包含子词书的 due 卡片

## 10. Migration Plan

所有改动是**纯增量**（新增表 + 新增列），不改现有列/约束/索引。可以在一个 migration 中完成：

```sql
-- 0036_wordbook_space_strategy.sql
-- 1. CREATE TABLE word_progress_master (...);
-- 2. ALTER TABLE user_word_progress ADD COLUMN master_progress_id ...;
-- 3. ALTER TABLE user_word_progress ADD COLUMN snapshot_jsonb ...;
-- 4. ALTER TABLE review_logs ALTER COLUMN wordbook_id DROP NOT NULL;
-- 5. ALTER TABLE review_logs ADD COLUMN master_progress_id ...;
-- 6. ALTER TABLE wordbooks ADD COLUMN parent_id ...;
-- 7. ALTER TABLE sessions ALTER COLUMN wordbook_id DROP NOT NULL;
-- 8. ALTER TABLE sessions ADD COLUMN scope_jsonb ...;
-- 9. CREATE INDEXES ...;
-- 10. CREATE TRIGGER trg_master_updated_at ...;
```

存量数据不受影响：
- 所有 progress 行 `master_progress_id = NULL`（独立模式）
- 所有 review_logs `wordbook_id` 非 NULL（词书记录）
- 所有 sessions `wordbook_id` 非 NULL（词书会话）
- 所有 wordbooks `parent_id = NULL`（扁平）

## 11. Out of Scope

以下能力不在本次设计范围内，留待未来：
- 词书间词条迁移（更新 wordbook_id + 级联更新关联表）
- 词书设置预设/模板复用
- 多用户共享词书
- 社区词书市场
