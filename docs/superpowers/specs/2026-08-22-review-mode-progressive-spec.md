# 渐进递进复习模式（P）正式设计规格

> ⚠️ **已作废（2026-08-24）**：本稿经评审重定位为 L2 层自有复习模式「辨析训练」，
> 由 `2026-08-24-l2-drill-spec.md` 取代。本文保留仅作决策过程存档；
> 其中 §六任务生成器合同、§八 submitL2Answer 设计、§九 outbox 演进被新 spec 继承。

- **Status**: Superseded / 已被 2026-08-24-l2-drill-spec 取代
- **Date**: 2026-08-22
- **来源**: 三份探索稿的正式化收敛（本 spec 为唯一权威，取代探索稿中与本文冲突的部分）：
  - `2026-07-06-review-mode-progressive-design.md`（P 方向探索）
  - `2026-07-06-review-mode-all-directions.md`（R/F/M 探索，后续迭代另立 spec）
  - `2026-07-06-review-mode-knowledge-base.md`（认知科学依据，长期参考）
- **依赖**:
  - `2026-07-07-dual-track-fsrs-spec.md`（双轨权威；§11 漏洞5 submitL2Answer 由本 spec 首次落地）
  - ADR-0004（§5 取舍 + §6 三条红线）/ ADR-0001（分层架构）
  - `2026-07-06-wordbook-space-strategy-design.md`（未实现的已批准 spec；本设计须兼容其未来形态）

## 〇、决策记录（2026-08-22 用户确认）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 首期范围 | 仅 P-MVP；**包含最小 L2 应答路径**（submitL2Answer）。R/F/M 后续迭代 |
| D2 | 状态机存储 | 扩展 `sessions.mode` 枚举 + 新建 `progressive_session_steps` 明细表 |
| D3 | 评分映射 | 四档确定性映射（对=good/错=again），原始证据进 metadata JSONB，**绝不新增 rating 枚举值** |
| D4 | L3 挂载点 | 仅预留 `ContextSource` 接口（默认空实现），FR-12 接线留待独立 ADR |
| D5 | L2 准入门槛 | 以"存在非暂停的 `user_word_l2_progress` 行且到期"为唯一门槛；**不引入平行 capability_stage 字段** |
| D6 | 无 L2 内容降级 | 跳过 L2 阶段静默结束爬阶，仅记 observability 日志，不写任何标记字段 |
| D7 | API 形态 | `/api/review` 下新增 `progressive` 子路由；现有 queue/answer 合同零改动 |
| D8 | undo 语义 | 每步各写一条 review_log；仅允许回退会话内**最后一步**（细化见 §11/S1） |

---

## 一、设计目标与非目标

### 目标

1. 新增第四种队列模式 `mode=progressive`：一次复习一个词是"爬阶会话"——L1 锚定（现有翻卡+评级原样走 FSRS）→ 达阈（good/easy）且有资格时出 1 道 L2 辨析题（客观判分，写 L2 轨）→ 结束。
2. 落地双轨 spec 既欠账的最小 L2 应答路径（saveL2Answer + outbox 联动），使 P 的 L2 步真正产生 cued recall 的测试效应增益。
3. 全程遵守三条红线与分层纪律；API 全类型化并过 governance。

### 非目标（明确排除）

- R（神经通路）/ F（自由提取）/ M（预测验证）——后续迭代各自立 spec。
- L3 语境消费（FR-12）、§8b 遴选算法、自评校准曲线。
- L2 独立队列（findDueL2Cards 泛化队列）——本期 L2 应答仅由爬阶触发；独立队列待 R/F/M 需要时提取为通用 L2ReviewService 队列端点。
- 词性转换题型（words 表无 pos_conversions 数据）。
- 反应时采集参与评分（D3：hard/easy 不由任务自动给出）。

---

## 二、红线符合性对照表

| 红线（ADR-0004 §6） | 本设计的符合方式 |
|---|---|
| **调度物理隔离**：L1/L2/L3 独立进度、独立 hash、独立 weights；联动只允许单向继承 | L1 步写 `user_word_progress`（现有 /answer 语义零改动）；L2 步只写 `user_word_l2_progress`。P 自身不做任何跨轨写：跃迁仍由 outbox worker 的 L2TransitionService 触发；L2 连败弱信号仍由既有 CrossTrackService 在 worker 内执行。P 只是"把当天到期的两轨复习合到一次交互里"，不改变任何联动规则 |
| **L3 不参与 FSRS** | ContextSource 仅返回文本片段用于（未来）题面丰富化，默认空实现；不读不写任何 stability/difficulty/retrievability |
| **评分语义向后兼容 review_logs(track)** | 不新增 rating 枚举值；L2 步日志 `track='l2'`（字段已存在）；任务证据（taskId/taskType/outcome/choiceIndex）写入 `review_logs.metadata` JSONB |

---

## 三、核心概念：爬阶会话模型

```
能力阶段（本模式管）：这个词今天要"做几步"     ← 不进 FSRS
记忆强度（FSRS 管）：这两步各记什么调度账       ← L1 步记 L1 轨，L2 步记 L2 轨
```

一次爬阶 = 一个词最多两步：

| 步 | 内容 | 判分 | 调度落点 |
|---|---|---|---|
| Step 0 `l1_anchor` | 正面 lemma/ipa → 翻转释义等（复用现有 ReviewCardView 数据面） | 用户四档评级（again/hard/good/easy），语义与现有一致："认识"即 good | L1 轨（现有 saveAnswer 原样） |
| Step 1 `l2_discrimination` | 服务端生成的客观选择题（§六） | 对/错二值，映射 good/again | L2 轨（新增 saveL2Answer） |

**升阶门槛（Step 0 → Step 1）**，全部满足才出 L2 题：

```
L1_rating ∈ {good, easy}
AND EXISTS user_word_l2_progress(user_id, wordbook_id, word_id) AND l2_paused = false   -- D5
AND l2_due_at <= now()
AND 任务生成器能从 words 的 L2 JSONB 缓存构建合法题目                                    -- 否则 D6 降级
```

任何一步失败（评级未达阈 / L2 答错）→ 本词爬阶结束，**失败是信号不是惩罚**：不退轨、不改对方轨状态、不出重考。

---

## 四、数据模型

Migration：`drizzle-release/0013_progressive_review_mode.sql`（drizzle-kit generate 离线产出，schema-drift 门禁同步）。

### 4.1 sessions.mode 扩展

```sql
ALTER TABLE sessions DROP CONSTRAINT sessions_mode_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_mode_check
  CHECK (mode = ANY (ARRAY['review','cram','preview','progressive']));
```

> `get_or_create_today_session(p_user_id, p_wordbook_id, p_mode, p_today_start)` **无需改动**：
> mode 是普通 text 参数，advisory lock 键含 mode，唯一活跃索引 `(user_id, wordbook_id, mode) WHERE ended_at IS NULL`
> 天然让 progressive 会话与其他模式互斥共存。

### 4.2 新表 progressive_session_steps

```sql
CREATE TABLE progressive_session_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wordbook_id   uuid NOT NULL REFERENCES wordbooks(id) ON DELETE CASCADE,
  word_id       uuid NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  progress_id   uuid NOT NULL,              -- L1 行 id（应用层校验，无 FK，兼容词书空间 master 形态）
  step_index    integer NOT NULL,           -- 0 = l1_anchor, 1 = l2_discrimination
  step_type     text NOT NULL CHECK (step_type IN ('l1_anchor','l2_discrimination')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','skipped')),
  -- 任务相关（仅 l2_discrimination 步非空）
  task_id       text,                       -- 幂等引用 id，如 "cloze:<uuid>"
  task_type     text CHECK (task_type IN ('cloze_mcq','synonym_discrimination')),
  task_payload  jsonb,                      -- 完整题目（含 answerIndex；API 出参必须剥离）
  -- 结果相关（完成/跳过后回填）
  outcome       text CHECK (outcome IN ('correct','incorrect') OR outcome IS NULL),
  mapped_rating review_rating,              -- 写入对应轨的四档 rating
  track         text NOT NULL DEFAULT 'l1' CHECK (track IN ('l1','l2')),
  review_log_id uuid,                       -- 关联 review_logs.id
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  UNIQUE (session_id, word_id, step_index)
);
CREATE INDEX idx_progressive_steps_session ON progressive_session_steps(session_id, created_at);
CREATE INDEX idx_progressive_steps_user_word ON progressive_session_steps(user_id, word_id);
-- 复合 owner FK（对齐 sessions/review_logs 的 scope 惯例）：
--   FK (session_id, user_id, wordbook_id) → sessions(id, user_id, wordbook_id)
--   FK (wordbook_id, user_id) → wordbooks(id, user_id)
```

要点：

- **steps 是事实明细不是调度器**：FSRS 状态仍在两张 progress 表里；删 steps 行不影响调度真相（undo 场景）。
- `progress_id` 不设外键——词书空间策略未来引入 `word_progress_master` 时，progress_id 语义可平滑切到 master.id，不需要 migration churn（该策略当前未实现，此处只是不留死锁）。
- 孤儿 pending 步（用户中途弃session）：无读取路径即无害；MVP 不清理，记入 §十五 边界情况，后续可挂数据生命周期作业。

### 4.3 review_logs 配套（双轨 spec §3.5 的既定改动落地）

```sql
-- track='l2' 的日志 progress_id 指向 user_word_l2_progress.id，
-- 必须解除指向 user_word_progress 的两个复合 FK（双轨 spec 已决策：裸 uuid + 应用层校验）
ALTER TABLE review_logs DROP CONSTRAINT review_logs_progress_id_fkey;
ALTER TABLE review_logs DROP CONSTRAINT review_logs_progress_scope_fkey;

-- 补上 track 枚举约束（当前列仅有 DEFAULT 'l1'，无 CHECK）
ALTER TABLE review_logs ADD CONSTRAINT review_logs_track_check
  CHECK (track = ANY (ARRAY['l1','l2']));
```

存量数据不受影响：全部现存日志 track='l1' 且 progress_id 本就指向 user_word_progress。

---

## 五、爬阶状态机定义

状态由 steps 表推导（无独立状态列）：

```
[取卡] ──► l1_pending ──(提交四档评级)──┬─ rating ∉ {good,easy} ─► done
                                        │
                                        └─ rating ∈ {good,easy}
                                             ├─ 资格检查通过 ──► 创建 pending l2 步 ──► l2_pending
                                             │      └─(提交 choiceIndex)──► completed(correct|incorrect) ──► done
                                             └─ 资格检查失败（D5/D6）──────► done
```

不变式（service 层强制，事务内校验）：

1. 同一会话同一词的步骤按 `step_index` 严格递增；step_index=1 的步必须存在已完成/跳过的 step_index=0 步作前提。
2. 提交 l2 步时锁定该步行 `FOR UPDATE` 且校验 `status='pending'`；重复提交同一步在无幂等键时抛 `BusinessRuleError`（409），有幂等键时走共享 checkIdempotency 返回幂等结果。
3. 一个 service 方法 = 一个事务（ADR-0004 §4.1）：`submitProgressiveAnswer` 与 `submitProgressiveTaskAnswer` 各自完整闭环。

---

## 六、任务生成器（domain 层）

新建 `src/domain/progressive-task.ts`：纯函数、零出向依赖（domain-no-outbound 规则）。

### 6.1 ContextSource 预留接口（D4）

```typescript
// src/domain/context-source.ts
export interface ContextSource {
  /** 返回可选的语境片段，用于未来 FR-12 题面丰富化；默认实现恒返 [] */
  getContextSnippets(wordId: string): Promise<string[]>;
}
export const noopContextSource: ContextSource = { getContextSnippets: async () => [] };
```

生成器签名携带可选 `contextSource`（默认 noop）；本期不 import 任何 `@/services/l3*` 或 `@/repositories/l3*`。

### 6.2 确定性选题

种子 = `sha256(sessionId:wordId:step_index)` 前 8 字节 → mulberry32 PRNG。同一输入永远生成同一题（幂等重放安全），随机性只在词间/步间生效。

### 6.3 题型合同（MVP 两种）

数据源均为 `words` 表 L2 JSONB 缓存列（`corpus_items` / `synonym_items` / `antonym_items`），条目结构遵循既有 Zod 合同（`schemas/service/index.ts` 的 `l2CorpusItemSchema{text,translation,source}` / `l2SynonymItemSchema{word,semanticDiff,...}`）。**零跨词查询**，干扰项全部来自本词条内容。

**cloze_mcq（语境填空 4 选 1）**

```
候选语料：corpus_items 中 text 含目标 lemma（大小写不敏感、词边界匹配）的条目；
  取首条含命中者（PRNG 在命中集合内选择）。
题面：text 挖空首个 lemma 出现处 → "____"，附 translation 作辅助线索。
选项：正确项 = lemma；干扰项 = 从 synonym_items[].word ∪ antonym_items[].word
  去重（大小写不敏感、排除目标词）后抽 3 个。
不可行判定：无命中语料 OR 干扰项 < 3 → 本题型不可用。
```

**synonym_discrimination（近义辨析 4 选 1）**

```
候选：synonym_items 任一条目 i（PRNG 选择）。
题面："关于 {lemma} 的近义辨析：哪个词贴合以下差异描述？「{i.semanticDiff}」"
选项：正确项 = i.word；干扰项 = 目标 lemma 自身 + 其余 synonym/antonym 词条 2 个。
不可行判定：synonym_items 为空 OR 可用去重词 < 4 → 本题型不可用。
```

**选择顺序**：PRNG 决定先试哪个题型，不可行则试另一个；两者都不可行 → 无 L2 步（D6：observability 日志 `progressive_task_unavailable`，静默结束爬阶）。

### 6.4 payload 结构

```typescript
interface ProgressiveTaskPayload {
  taskId: string;                 // "{taskType}:{uuid}"
  taskType: "cloze_mcq" | "synonym_discrimination";
  prompt: string;
  translation?: string;           // cloze 附带中文线索
  options: [string, string, string, string];
  answerIndex: 0 | 1 | 2 | 3;     // 仅入库，API 出参剥离
}
```

---

## 七、评分映射合同（D3）

| 步 | 结果 | 映射 rating | 写入轨 | review_logs.metadata 追加 |
|---|---|---|---|---|
| l1_anchor | 用户四档评级 | 原样透传 | l1（现有路径） | `mode:"progressive", stepIndex:0, sessionId` |
| l2_discrimination | correct | good | **l2** | `mode:"progressive", stepIndex:1, taskId, taskType, outcome, choiceIndex` |
| l2_discrimination | incorrect | again | **l2** | 同上 |

- 反应时不采集、不参与映射；hard/easy 只能来自 L1 步用户手动评级。
- L2 步的 FSRS 计算参数：`l2_scheduler_payload` + `l2_desired_retention`(0.900) + weights 回退链 `fsrs_l2_weights → fsrs_weights`（双轨 spec §十；loadWeights 注入点新增可选 `loadL2Weights`，缺省回退现有 loadWeights）。
- L2 recent_ratings append+slice(-5)，与 L1 同构（跨轨联动的滑动窗口继续有效）。

---

## 八、submitL2Answer 设计（双轨 spec §11 漏洞5 首次落地）

新建 `src/services/l2-review.service.ts`：

```typescript
export class L2ReviewService {
  constructor(deps: {
    fsrsAdapter: FsrsAdapterFn;                       // 复用同一 adapter（toCard/fromCard 通用）
    loadWeights: (wordbookId: string) => Promise<number[] | null>;
    loadL2Weights?: (wordbookId: string) => Promise<number[] | null>;  // 缺省回退 loadWeights
  }) {}

  /** 事务内核心：供 ProgressiveReviewService 在其事务中调用 */
  async answerWithinTx(repos: TxRepositories, input: SubmitL2AnswerInput): Promise<SubmitL2AnswerResult>;

  /** 独立入口（自有 withTransaction）：为将来 R/F/M 或独立 L2 队列预留 */
  async submitL2Answer(input: SubmitL2AnswerInput, userId: string): Promise<SubmitL2AnswerResult>;
}
```

事务内序列（对齐 ReviewService.submitAnswer 的成熟模式）：

1. 共享 `checkIdempotency(userId, key)`（全局唯一，不限 track）。
2. `repos.l2Progress.findForUpdate(userId, wordbookId, wordId)` —— **新增 repo 方法**，SELECT FOR UPDATE + JOIN words 取 l2 相关内容缓存。
3. 校验：行存在（否则 NotFoundError）、`l2_paused=false`（暂停中答题抛 BusinessRuleError）。
4. `repos.sessions.assertActiveOwned(sessionId, userId, wordbookId)`。
5. `fsrsAdapter(l2_scheduler_payload, mappedRating, now, 0.900, l2Weights)`。
6. `repos.l2Progress.saveL2Answer(...)` —— **新增 repo 方法**：单 SQL 更新 `l2_*` 全字段 + `recent_ratings` append/slice(-5) + 四计数器 + `l2_content_hash_snapshot` 刷新；随后 INSERT review_logs(`track='l2'`, `progress_id=l2行id`, metadata 含任务证据, previous_progress_snapshot 供 undo)。
7. outbox enqueue `REVIEW_ANSWER_RECORDED`，payload 增加 `track:'l2'` 字段（见 §九）。

---

## 九、Outbox 事件扩展

`REVIEW_ANSWER_RECORDED` payload schema **加性演进**（v1 兼容）：新增必填 `track: 'l1' | 'l2'`（旧事件读取方按缺省 'l1' 容错）。

ReviewOutboxWorker 分支处理：

| track | effects（沿用 beginEffect/completeEffect 收据防重放） |
|---|---|
| `'l1'`（现状不变） | l2_transition → l1_cascade → session_cards_seen |
| `'l2'` | **l2_weak_signal**：CrossTrackService.checkL2FailureCascade(userId, wordbookId, wordId)（该方法首次接入真实调用方）→ session_cards_seen |

注意：cards_seen 语义是"卡数"非"步数"——**只有 track='l1' 的事件递增 cards_seen**；L2 步事件不递增，避免一词计两次。

---

## 十、API 合同（D7）

新路由文件 `src/http/routes/progressive-review.ts`，挂载于 `/api/review/progressive`。所有响应在 `operations.ts` 注册 Zod 类型化合同；入参出参 schema 落 `src/schemas/http`。**现有 `/queue` `/answer` 等 operation 合同零改动 → 无 breaking，无需 openapi-breaking-approval。**

### 10.1 GET /api/review/progressive/queue?limit=

```jsonc
{
  "items": [{
    "progressId": "uuid",
    "word": { "id","slug","title","lemma","shortDefinition","ipa","pos","cefr" },
    "state": "review", "dueAt": "...", "lastRating": "good", "reviewCount": 7
    // 注意：不泄露 l2 资格预判（资格在 L1 提交后即时评估，避免过期快照误导前端）
  }],
  "session": { "id": "uuid", "mode": "progressive", "cardsSeen": 12 },
  "stats": { "total": 20, "remaining": 20 }
}
```

实现：复用 `repos.reviews.findDueCards`（L1 到期口径）+ `getOrCreateTodaySession(mode='progressive')`。

### 10.2 POST /api/review/progressive/answer （L1 锚定步）

请求：`progressiveL1AnswerSchema = { progressId, sessionId, rating, idempotencyKey? }`
（与 reviewAnswerSchema 同形，独立命名避免耦合）

响应：

```jsonc
{
  "ok": true,
  "reviewLogId": "uuid",          // L1 轨日志
  "nextDueAt": "...", "state": "review",
  "nextStep":
    | { "type": "done" }
    | { "type": "l2_task", "step": { "stepId": "uuid", "taskId": "cloze:...",
          "taskType": "cloze_mcq", "prompt": "She gave a ____ glance...",
          "translation": "她匆匆瞥了一眼…", "options": ["fleeting","eternal","vivid","solemn"] } }
  // answerIndex 绝不出现在任何出参
}
```

事务序列：幂等检查 → 锁 L1 progress（现有 findProgressForUpdate）→ assertActiveOwned → fsrsAdapter(L1) → saveAnswer（metadata 带 progressive 标记）→ outbox(track='l1') → **插入 completed l1_anchor 步** → 若达阈则跑资格检查（§三）→ 通过则生成任务并插入 pending l2 步 → 返回 nextStep。

### 10.3 POST /api/review/progressive/task-answer （L2 辨析步）

请求：

```jsonc
{ "sessionId": "uuid", "stepId": "uuid", "choiceIndex": 2, "idempotencyKey": "..." }
```

响应：

```jsonc
{
  "ok": true,
  "outcome": "incorrect", "correctOption": 0,     // 判分后揭示
  "mappedRating": "again",
  "l2ReviewLogId": "uuid", "l2NextDueAt": "...",
  "nextStep": { "type": "done" }
}
```

事务序列：幂等检查 → 锁步行 FOR UPDATE + status='pending' 校验 → 经 L2ReviewService.answerWithinTx 完成 §八 序列（内部二次校验 l2 行非暂停）→ 回填步 outcome/mappedRating/reviewLog_id/completed_at → outbox(track='l2')。

错误码约定：步不存在/不属于该会话 → 404；status≠pending → 409 BUSINESS_RULE；l2 行暂停或缺失 → 409 BUSINESS_RULE（步标记 skipped 后返回 done，保证前端总能收尾）。

### 10.4 POST /api/review/progressive/undo （D8）

请求：`{ sessionId }`（无需 reviewLogId——服务端定位会话最后一步）。

语义（S1 细化）：

- 最后一步是 **l1_anchor** → 复用现有 undo RPC（恢复 L1 快照、undone 标记、幂等日志）→ 删除该步行及派生的 pending l2 步。
- 最后一步是 **l2_discrimination** → MVP 返回 `409 BUSINESS_RULE("L2 步撤销将在后续版本提供")`。理由：undo_review_log RPC 与 L1 表硬绑定，为 L2 另写快照恢复会显著扩 migration 面；L2 误判频率低、爆炸半径小，列为已知限制（§十五）快速跟进。
- 会话无步 → 409。

### 10.5 复用声明

`POST /api/review/skip`、`/suspend`、`/undo` 对 progressive 会话**天然可用**：assertActiveOwned 只校验 (id,user,wordbook) 不校验 mode。skip 语义 = 当前卡移出本次队列（现有 skipCard），不产生步记录。

---

## 十一、分层落点表

| 层 | 文件 | 内容 |
|---|---|---|
| db | `src/db/schema.ts` | progressiveSessionSteps 表定义；reviewLogs 去 FK 改裸列注释 |
| migration | `drizzle-release/0013_*.sql` + meta | §四 全部 DDL |
| domain | `src/domain/progressive-task.ts` `src/domain/context-source.ts` | 纯函数任务生成 + 预留接口（零出向） |
| repositories | `src/repositories/l2-progress.repository.ts` interfaces.ts | findForUpdate / saveL2Answer |
| services | `src/services/l2-review.service.ts` `src/services/progressive-review.service.ts` | §八 / §十 业务编排；withTransaction+requireTx；AppError 层级 |
| http | `src/http/routes/progressive-review.ts` operations.ts schemas/http | 薄调用 + 类型化合同注册 |
| outbox | `src/outbox/review-answer.event.ts` review-outbox.worker.ts | payload 加 track；worker l2 分支 |
| frontend（Phase 2） | `src/frontend/pages/ReviewPage.tsx` components/review/* api-generated | 模式卡片 + 两步爬阶视图 |

dependency-cruiser 零违规为硬门禁；routes 不触 repo，services 不触 @/db 直连。

---

## 十二、实施路线图

| Phase | 内容 | 验收 |
|---|---|---|
| **1a** | migration 0013 + schema + repos（findForUpdate/saveL2Answer/steps CRUD） | typecheck + test:unit（repo 层测试连真实 PG 可选，随现有集成测试惯例） |
| **1b** | domain 任务生成器 + L2ReviewService + ProgressiveReviewService + worker l2 分支 | TDD 全绿；覆盖率 ratchet 不降 |
| **1c** | routes + operations 合同 + contract 测试 + `npm run api:client:generate` | api:governance 双绿 |
| **2** | 前端 ReviewPage 渐进模式 + 爬阶组件 | frontend:build 过 |
| **fast-follow** | L2 步 undo、孤儿步清理作业、M 叠加层 | 各自小 PR |

分支 `feat/progressive-review-mode`；提 PR 等 CI 双绿，不自动合并。

---

## 十三、测试计划（TDD）

| 测试组 | 覆盖点 |
|---|---|
| tests/domain/progressive-task.test.ts | 种子确定性（同种子同题）；cloze 命中/无命中；干扰项去重与不足降级；两种题型互备选择；payload 无答案泄漏 |
| tests/services/progressive-review.test.ts | 达阈升阶全链路；未达阈终止；D5 三条件逐项否定矩阵；D6 静默降级；幂等重放；并发同步双提交（advisory lock）；undo 最后一步（L1 成功 / L2 409 / 无步 409） |
| tests/services/l2-review.test.ts | fsrsAdapter 以 0.900 + l2 payload 调用；weights 回退链；paused 行 409；saveL2Answer 字段断言（recent_ratings slice、计数器、hash snapshot） |
| tests/http/progressive-review.test.ts + response-contract | 三端点 happy path + 错误码；answerIndex 不出现在序列化输出 |
| tests/outbox/review-outbox.worker 补充 | track='l2' 事件 → l2_weak_signal effect 收据；cards_seen 不递增；track='l1' 回归不变 |
| 迁移回归 | 存量 review_logs 日志读写不回归；sessions 四 mode 并存各持活跃会话 |

基线 1341 测试之上净增，无删除（除受影响断言的同步更新）。

---

## 十四、边界情况

| 场景 | 处理 |
|---|---|
| 用户弃会话留孤儿 pending l2 步 | 无读取路径即无害；次日新会话重新爬阶（UNIQUE 含 session_id 不冲突）；清理挂 fast-follow |
| L1 提交与 task-answer 之间 L2 行被暂停 | task-answer 时校验失败 → 步标 skipped、不写 FSRS、响应 done（409 语义见 §10.3） |
| 同步双击提交同一步 | FOR UPDATE + status 校验串行化；第二请求 409 或幂等返回 |
| L2 行存在但 due 未到 | 不出 L2 题（§三门槛 2）；该词当天 L2 由普通 L2 队列（未来）负责，P 不越权提前 |
| 词书空间未来合并（master） | steps.progress_id 为裸 uuid；切换基准词书时应用层解析 master.id 即可，schema 不动 |
| content_hash 漂移（L2 扩展后） | 既有 markL2StaleForRecheck 机制照常作用于该轨；P 无感知 |
| progressive 与 review 会话并存 | 不同 mode 各自唯一活跃索引隔离；cards_seen 各自统计 |

---

## 十五、风险与对策

| 风险 | 对策 |
|---|---|
| 干扰项质量差（LLM 生成的 synonym word 拼写怪异） | 生成侧已有 confirm 审核（ADR-0004 §6.3），入库内容即受信；运行期再加最小卫生检查（非空、长度≤40、≠目标词） |
| L2 步让单词复习时长上升 | 一词至多加一题（≤15s）；资格含 due 门槛，不会每词必出 |
| FK 解除后的引用完整性 | 应用层校验（findForUpdate 先行）+ track CHECK；weights 优化查询按 track 过滤不受影响 |
| review_logs.previous_progress_snapshot 结构在 L1/L2 间歧义 | L2 日志 metadata 加 `l2:true` 标记；undo S1 未开放前无消费方 |
| 路由复杂度 ratchet | routes 保持 ≤ 现有 review.ts 的薄度，分支逻辑全部下沉 service |

---

## 十六、验收标准（Windows PowerShell，wt-main 下）

```powershell
npm run typecheck          # 零错误
npm run test:unit          # 1341 基线之上净增，全绿，ratchet PASS
npm run api:governance     # openapi/client/contract/breaking/复杂度全过
npm run verify:engineering # 提 PR 前
```

红线自查清单（spec review 时逐项打钩）：
- [ ] P 未直接读写对方轨调度状态（L2 步经 L2ReviewService，L1 步经现有路径）
- [ ] 未给 L3 引入 FSRS（ContextSource 默认空实现）
- [ ] 无新 rating 枚举；metadata 向后兼容；track='l2' 日志符合双轨 §3.5
