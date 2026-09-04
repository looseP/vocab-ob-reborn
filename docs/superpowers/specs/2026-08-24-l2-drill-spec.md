# L2 辨析训练模式（L2 Drill）正式设计规格

- **Status**: Spec / 决策已确认（2026-08-24），待实施
- **Date**: 2026-08-24
- **Supersedes**: `2026-08-22-review-mode-progressive-spec.md` 的整体范围（该稿作废归档）。
  继承其资产：§八 submitL2Answer 设计、§六 任务生成器合同、§九 outbox track 演进。
- **依赖**: 双轨 FSRS spec（2026-07-07）、ADR-0002/0004/0005、`l1-vocabulary-md-format.md`

## 〇、与被取代方案的差异（为什么改）

原 P 规稿把复习会话定义为"L1 锚定步 →（顺路）L2 题"，队列骑乘 L1 到期口径。
评审发现两个问题：

1. **节奏绑架**：L2 卡有自己的到期日（如晋升后第 12 天），但只有当 L1 也到期
   （0.85 DR 下约第 76 天）才会出现在队列——L2 的自适应补练被掐断。
2. **价值错位**：合并交互省下的时间对主动型用户吸引力有限，而爬阶外壳
   （steps 状态机/L1 锚定合同/双步前端）占掉近半工程量。

重定位后：**P 变成 L2 层自己的复习模式**——队列源换成 L2 到期口径，
认知阶梯恢复探索稿完整版（辨析 cued recall → 产出 constructed response），
单轨写反而使红线符合性更干净。

## 〇½、决策记录（2026-08-24 用户确认）

| # | 决策 | 结论 |
|---|------|------|
| D1' | 定位 | L2 层自有复习模式；队列源 = findDueL2Cards（L2 到期口径） |
| D2' | 产出任务进 MVP | 辨析 → 达阈 → 造句+自评（恢复探索稿后半段） |
| D3' | 命名 | `sessions.mode = 'l2_drill'`，中文文案「辨析训练」 |
| D4' | 失败语义 | 辨析答错 → 会话即结束；弱信号由 outbox worker 异步标记；无重考/退阶 |
| D5' | 评分映射 | correct→good / incorrect→again 写 L2 轨；绝不新增 rating 枚举 |
| D6' | 产出步不写 FSRS | 仅步骤明细 + `l2_production_status` 标记；调度账只属于辨析步 |
| D7' | L3 接线 | 只允许标记 + 深链推荐；不自动建 proposal；L3 零调度状态（ADR-0005） |
| D8' | undo | 仅支持撤销"最后的产出自评步"（无 FSRS 回滚需求）；辨析步撤销 409 fast-follow |

## 一、用户体验流

```
取一张 L2 到期卡（未暂停）
   │
   ▼
Step 0  辨析任务（4 选 1，≤15s）：语境填空 / 近义辨析（PRNG 二选一）
   │
   ├─ 答错 → 揭示正确项 → 映射 again 写 L2 轨 → 【会话结束】
   │
   └─ 答对 → 映射 good 写 L2 轨
         │
         ▼
Step 1  产出任务：给目标词 + 释义(+语料参照)，用户造句 → 自评 [用对了] / [没把握]
         │
         ├─ 自评回填 l2_production_status（passed / weak），零 FSRS 写入 → 结束
```

分支矩阵：

| 场景 | 行为 |
|---|---|
| 辨析任务不可行（缓存内容不足以出 MCQ） | **直接进入产出步**（单步会话）——产出只需词条本身，永远可行；队列中不存在无事可做的卡 |
| L2 行暂停 | 不出现在队列（部分索引已过滤） |
| 辨析答错 | 结束；`checkL2FailureCascade` 由 worker 异步评估弱信号 |
| 弃会话留孤儿 pending 步 | 无读取路径即无害；次日新会话不受影响（UNIQUE 含 session_id） |

## 二、红线符合性

| 红线 | 本设计 |
|---|---|
| 调度物理隔离 | 只写 `user_word_l2_progress`；**完全不触碰 L1**——比原 P 更简（连 L1 锚定步都没有） |
| L3 不参与 FSRS | 产出步零调度写入；L3 仅以"深链只读消费 + 标记"形式出现 |
| 评分语义兼容 | 无新 rating 枚举；track='l2' 日志 + metadata 任务证据（沿用原 §七合同） |

## 三、数据模型（migration `0013_l2_drill.sql`）

```sql
-- 1. sessions.mode 扩展
ALTER TABLE sessions DROP CONSTRAINT sessions_mode_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_mode_check
  CHECK (mode = ANY (ARRAY['review','cram','preview','l2_drill']));

-- 2. 步骤明细表（事实记录，非调度器）
CREATE TABLE l2_drill_session_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wordbook_id   uuid NOT NULL REFERENCES wordbooks(id) ON DELETE CASCADE,
  word_id       uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  progress_id   uuid NOT NULL,              -- L2 行 id（应用层校验，无 FK）
  step_index    integer NOT NULL,           -- 0=辨析, 1=产出
  step_type     text NOT NULL CHECK (step_type IN ('l2_discrimination','l2_production')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','skipped')),
  task_id       text,
  task_type     text CHECK (task_type IN ('cloze_mcq','synonym_discrimination','production')),
  task_payload  jsonb,                      -- 含答案/参照例句；出参剥离敏感字段
  outcome       text CHECK (outcome IN ('correct','incorrect','self_passed','self_weak') OR outcome IS NULL),
  mapped_rating review_rating,              -- 仅辨析步非空
  review_log_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  UNIQUE (session_id, word_id, step_index)
);
CREATE INDEX idx_l2_drill_steps_session ON l2_drill_session_steps(session_id, created_at);
-- 复合 owner FK 对齐 sessions 惯例：(session_id,user_id,wordbook_id)/(wordbook_id,user_id)

-- 3. L2 进度行补产出阶段标记
ALTER TABLE user_word_l2_progress
  ADD COLUMN l2_production_status text
  CHECK (l2_production_status IS NULL OR l2_production_status IN ('passed','weak'));

-- 4. review_logs：解除 progress FK（track='l2' 时指向 L2 行）+ 补 track CHECK
ALTER TABLE review_logs DROP CONSTRAINT review_logs_progress_id_fkey;
ALTER TABLE review_logs DROP CONSTRAINT review_logs_progress_scope_fkey;
ALTER TABLE review_logs ADD CONSTRAINT review_logs_track_check
  CHECK (track = ANY (ARRAY['l1','l2']));

-- 5. payload 断路修复·存量化（见 §四）
UPDATE user_word_l2_progress p
SET l2_scheduler_payload = jsonb_build_object(
  'difficulty', p.l2_difficulty, 'due', to_char(p.l2_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'elapsed_days', 0, 'scheduled_days', 0, 'reps', 0, 'lapses', 0, 'learning_steps', 0,
  'last_review', NULL, 'stability', p.l2_stability, 'state', 2)
WHERE COALESCE(p.l2_scheduler_payload, '{}'::jsonb) = '{}'::jsonb;
```

> state=2 即 ts-fsrs `State.Review`。继承行天生就是 review 态（双轨 spec §五）。

## 四、payload 断路修复（评审发现的既有缺陷）

现状：`l2-transition.service.ts` insert 从不写 `l2_scheduler_payload`，所有继承行
落库为 `{}`；`toCard({})` 因 Invalid Date 返回 `createEmptyCard()`（State.New）——
首次作答会把继承卡按全新词调度（分钟级 learning 步），继承 S/D 全部丢失。

三层修复：

1. **写侧**：transition insert 构造初始 payload（state=Review, stability=L2_S,
   difficulty=L2_D, due=l2_due_at, reps=0），语义即 `fromCard`
2. **存量化**：migration 第 5 段 backfill
3. **读侧兜底**：`saveL2Answer` 发现 payload 为空时从行上权威标量列重建卡片；
   测试断言"空 payload 继承卡首答后 due ≥ 天级"

## 五、任务生成器（`src/domain/l2-task.ts`，纯函数零出向）

- 种子 = `sha256(sessionId:wordId:step_index)` 前 8 字节 → mulberry32；同种子同题
- **辨析**（沿用原 P §六合同）：`cloze_mcq`（corpus_items 挖空，干扰项来自
  synonym∪antonym 词条）/ `synonym_discrimination`（semanticDiff 选词）。
  零跨词查询；卫生检查（非空、长度≤40、≠目标词）；两者皆不可行 → 单步降级进产出
- **产出**：`{ taskType:'production', prompt, hintTranslation?, referenceExample? }`。
  prompt = 目标词 + short_definition（+ 可选 corpus 例句作答后对照）；
  无选项字段；永远可行故不作不可行判定
- `ContextSource` 预留接口沿用（默认 noop；FR-12 接线另立 ADR）
- **answerIndex / 参照例句中的答案标注绝不出现在任何 API 出参**

## 六、服务层

```typescript
// src/services/l2-review.service.ts —— 应答内核（原 P §八全量继承）
class L2ReviewService {
  answerWithinTx(repos, input): Promise<SubmitL2AnswerResult>;  // 供 Drill 服务事务内调
  submitL2Answer(input, userId): Promise<SubmitL2AnswerResult>; // 独立入口（未来 R/F/M 复用）
}
// 事务序列：幂等检查 → findL2ForUpdate(SELECT FOR UPDATE JOIN words 取缓存)
//  → 校验非暂停 → assertActiveOwned → fsrsAdapter(payload, rating, now, l2.desired_retention, loadL2Weights())
//  → saveL2Answer（全 l2_* 字段 + recent_ratings slice(-5) + 计数器 + hash snapshot 刷新）
//  → INSERT review_logs(track='l2') → outbox enqueue(track='l2')

// src/services/l2-drill.service.ts —— 会话编排
class L2DrillService {
  getQueue(limit): items + session + stats;      // findDueL2Cards + getOrCreateTodaySession('l2_drill')
  submitTaskAnswer(input): 判分 → answerWithinTx → 回填辨析步
                            → 达阈则建 pending 产出步 → nextStep
  submitSelfAssessment(input): 校验步 pending → 回填 outcome/self_passed|self_weak
                            → UPDATE l2_production_status → 结束【零 FSRS】
  undo(sessionId): 最后一步=产出自评 → 删步+清 production_status（无 FSRS 回滚）
                   最后一步=辨析 → 409 fast-follow；无步 → 409
}
```

不变式（service 层事务内强制）：step_index 严格递增；产出步前提是辨析步 completed
（或辨析不可行时 skipped）；重复提交同一步无幂等键 → 409。

## 七、Outbox 事件扩展

`REVIEW_ANSWER_RECORDED` payload 加必填 `track:'l1'|'l2'`（旧消费方缺省 'l1' 容错）。
Worker 分支：

| track | effects |
|---|---|
| 'l1'（不变） | l2_transition → l1_cascade → session_cards_seen |
| 'l2' | **l2_weak_signal**：CrossTrackService.checkL2FailureCascade 首次接入真实调用方；cards_seen **不递增** |

## 八、API 合同（挂载 `/api/review/l2-drill`，operations.ts 类型化注册）

| 端点 | 说明 |
|---|---|
| GET `/queue?limit=` | `{items:[{progressId, word{id,slug,title,lemma,pos,ipa,cefr}, l2DueAt, l2ReviewCount}], session:{id,mode:'l2_drill'}, stats}` |
| POST `/task-answer` | `{sessionId, stepId, choiceIndex, idempotencyKey?}` → `{ok, outcome, correctOption, mappedRating, l2ReviewLogId, l2NextDueAt, nextStep:{type:'done'}|{type:'production', step:{...}}}` |
| POST `/self-assess` | `{sessionId, stepId, verdict:'passed'\|'weak'}` → `{ok, productionStatus}` |
| POST `/undo` | `{sessionId}` → 409 或 `{ok}` |

现有 `/api/review/*` 合同零改动 → 无 breaking。skip/suspend 天然复用
（assertActiveOwned 不校验 mode）。

## 九、分层落点

| 层 | 文件 |
|---|---|
| db/migration | schema.ts + `drizzle-release/0013_l2_drill.sql`（含 backfill） |
| domain | `l2-task.ts`、`context-source.ts` |
| repositories | l2-progress.repository：`findDueL2Cards`（部分索引现成）/`findL2ForUpdate`/`saveL2Answer`/`updateProductionStatus`；interfaces.ts |
| services | `l2-review.service.ts`、`l2-drill.service.ts` |
| ingest 修复 | `l2-transition.service.ts` 写侧 payload |
| outbox | review-answer.event.ts + worker 'l2' 分支 |
| http | routes/l2-drill.ts + operations.ts + schemas/http |

## 十、测试计划（TDD，基线 1416 净增）

| 组 | 覆盖 |
|---|---|
| domain/l2-task.test | 种子确定性；两种辨析题型可行性矩阵；干扰项卫生；产出 payload 无泄漏 |
| services/l2-review.test | 空 payload 重建路径；weights 回退链；paused 409；saveL2Answer 字段断言；**空 payload 继承卡首答 due≥天级** |
| services/l2-drill.test | 达阈升产出步全链路；答错即止；单步降级（辨析不可行）；自评回填零 FSRS 断言；undo 三态；幂等重放；并发双提交 |
| http/l2-drill.test + contract | 四端点 happy/error；answerIndex 不出现在序列化 |
| outbox worker 补充 | track='l2' → weak_signal 收据；cards_seen 不变 |
| 迁移回归 | 存量日志读写；四 mode 并存；backfill 后无 '{}' payload 残留 |

## 十一、实施路线

| Phase | 内容 | 验收 |
|---|---|---|
| 1a | migration 0013（含 backfill）+ schema + repos + transition 写侧修复 | typecheck + 单测绿 |
| 1b | 任务生成器 + L2ReviewService + L2DrillService + worker 分支 | TDD 全绿 |
| 1c | routes + contracts + api:client:generate | api:governance 双绿 |
| 2 | 前端 ReviewPage「辨析训练」入口 + 两步视图 | frontend:build 过 |
| fast-follow | 辨析步 undo、孤儿步清理、FR-12 语境深链、产出参照丰富化 | 各自小 PR |

## 十二、验收标准（Windows PowerShell，wt-main 下）

```powershell
npm run typecheck; npm run test:unit; npm run api:governance; npm run verify:engineering
```

红线自查：
- [ ] 零 L1 触碰（不 import review.service 写路径）
- [ ] 产出步零 FSRS 写入（断言级测试）
- [ ] 无新 rating 枚举；track='l2' 日志合规
- [ ] l3_* 死字段仍未被业务读写；无自动 proposal 创建
