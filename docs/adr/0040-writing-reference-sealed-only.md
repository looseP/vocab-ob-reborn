# ADR-0040: 写作引用的草稿边界（签字 D1-a —— 只允许 sealed，且第 5 条链只新增两个 kind）

- **Status**: Accepted（**D1-a 签字**：2026-09-23 的「未裁决」状态由本 ADR 转正）
- **Date**: 2026-09-26
- **Amends**: `docs/plan/study-notes-n2-execution-2026-09-23.md` §5.1 **D1-a**（**仅声明修订，不修改原文**）：① 获准；并**补上 D1-a 原文未覆盖的三处细节**（决策 4/5/6：两个新 kind 的 hash 输入与快照形状、存储列取舍、writingSheet 不新增 kind）
- **References**: ADR-0039（评卷 latest-wins + 派生 changed 的先例；changed 是承重路径）、ADR writing-workspace §2/W1（`writing` scope、四元数据、`UNIQUE(user_id, writing_task_id, revision_no)`、`l3_writing_feedback` 唯一质量反馈源）、`docs/plan/study-notes-n2-chain03-execution-2026-09-24.md` §3.1（K1/K3/K4/K5）、`docs/adr/study-notes-workspace.md`（N1 边界）
- **不涉及**: 已交付的第 1–4 条链的任何口径；`l3_submissions` 的 draft 自动保存 / CAS（`draft_version`）语义；写作导出已有的草稿阅读面

## Context

### 一、D1-a 真正问的是什么（先把问题缩到最小）

第 5 条链的计划名是「writingTask + writingSheet + feedback」。逐个过一遍会发现，**三个里面有两个根本不需要 D1-a 裁决**：

| 目标 | 实体性质 | D1-a 是否相关 |
|---|---|---|
| writingSheet（写作稿次） | 就是 `l3_submissions` 的 writing 行；chain03 K1 已裁决「只装载 `status='sealed'`」（`l3-study-references.repository.ts:554-570`），K3 已处理 writing 的 `revisionNo` 必填 | **无关** —— 沿 K1 即可，draft/discarded 一律 404 |
| writing_feedback（评阅） | `l3_writing_feedback`，`UNIQUE(user_id, sheet_id)`（`schema.ts:1586`），单行覆写；且反馈服务的读前置 `loadSealedSheetForRead`（`l3-writing-feedback.service.ts:115-123`）对 draft 直接 **409**：「draft 409，不是 404」同文件 `:9` 注释 | **无关** —— 反馈在业务上就不存在于草稿上；引用面只需沿用「sealed 才有反馈」 |
| writing_task（作文任务） | `l3_writing_tasks`（`schema.ts:1332`）：题面真源，`status = active \| archived`，**只归档不硬删**，改题意 = 新建任务 | **无关** —— 它根本不是草稿；可沿 chain02 的 note 先例（capture 要求 active，归档后已存引用不撤销） |

所以 D1-a 缩到只剩一个真问题：**要不要新增一种「引用写作草稿」的能力**（把 `status='draft'` 的 writing 行钉进笔记）。

### 二、为什么三个出路全是下坡（证据逐条）

写作草稿有两个结构事实，其它 venue 都没有：

1. `draft_version` 是 CAS 乐观锁（`schema.ts:1378-1383`，普通题纸恒 0），**每次防抖自动保存都 +1**。
2. 同一 task 同一时刻至多一张 draft（部分唯一索引 `(user_id, scope_key) WHERE status='draft'`，ADR writing-workspace §2），`revision_no` 在 draft 期为 NULL（同文件 `:34`）—— 草稿**没有稳定序号**。

| 出路 | 代价（代码证据） |
|---|---|
| ② 草稿可引用，hash 吃当前正文 | `changed` 从「改判/改稿警示」退化成「打字计数器」：用户写两段话，笔记里就多一条 changed。ADR-0039 决策 5 刚把 changed 立为承重路径，② 会在第一周就把它稀释掉 |
| ③ 把 `draft_version` 纳入身份 | 身份随每次保存失效 ⇒ 引用在继续打字后立刻悬空。这是用活引用的形状装一次性快照，违背 chain03 K5「不做身份兜底/退化」的精神；且悬空引用没有可解释的修复路径（让用户「重新钉」等于承认它从来不是引用） |
| ① 只允许 sealed（签字项） | 代价唯一且明确：钉不住「此刻正在写的那一版」。但这份代价**已经被别的面付过了**：`l3-writing-export.service.ts:207-209` 对 draft 的读面标注是「含草稿，**仅供此刻阅读**：`draftVersion=N`」—— 仓库已经用诚实文案表达了「草稿只配快照式阅读」，引用系统不需要再发明第二种说法 |

## Decision

1. **D1-a 转正：只允许引用 sealed 稿次；draft / discarded 一律 404（不是 409）** —— 沿 chain03 K1 的字面理由：draft 不是「冲突」，是不存在的合法目标。**草稿态引用语义不实现，且不允许先放宽后收紧**（执行文档原话，本 ADR 转正）。
2. **②③ 经核算否决**，理由入 Context 二 —— **目的是让后来者不必重新推导一遍**。尤其 ②：任何「hash 吃高频变化字段」的提案，默认用「changed 信号完整性」这一条驳回，不必重开 ADR（除非能证明 changed 已不再是承重路径）。
3. **writingSheet 不新增 kind**：复用已有 `sheet`（身份 `{submissionId, revisionNo}`，D1-1/D1-2；writing 的 revisionNo 必填是 K3 已有约束）。第 5 条链**只新增两个 kind**：`writing_task`、`writing_feedback`。
4. **两个新 kind 的 hash 输入与快照**（本条是 D1-a 原文**未覆盖**的细节，签字时必须定死；口径全部沿既有先例，不发明新形状）：
   - `writing_task`：身份 `{taskId}`；hash = `{title}` 固定键序 JSON —— 沿 `noteFieldText`（`service:98-100`，只取内容字段）；**不含 `status` / `updated_at`**（沿同文件 `:95-97` 的理由：归档与时间变化不应让引用转 changed）。快照 = `{title, taskKind, direction}`（`l3_writing_tasks` 的三个人可读字段；题干另有 `question` kind 可引，不在这里 JOIN 拼第二份真源）。capture 要求 `status='active'`（沿 `note` 合同 `service:543-551`）；归档后**已存引用不撤销**，resolve 仍按 hash 出 current/changed（同 `note` 注释）。
   - `writing_feedback`：身份 `{sheetId}`（`UNIQUE(user_id, sheet_id)` 使一纸恰一行，latest-wins 同款）；hash = `feedback` jsonb 的**键序稳定化**全文（沿 `attemptFieldText` 的 `canonicalJson`，`service:109-123`：PG jsonb 键序是实现细节，直接 stringify 会把「同一份反馈换个键序」误判成 changed）；**不含 `version` / `last_editor` / `updated_at`**（CAS 计数器与归属事实不是内容；沿 ADR-0039 决策 3 的 `graded_by` / `graded_at` 同款理由）。快照 = `{summary（全文，≤1000）, excerpt（四维度评论拼成的前 280，STUDY_FEEDBACK_EXCERPT_MAX）}`。**快照与 UI 不得伪造分数**：`writingFeedbackSchema`（`l3-writing.ts:115-137`）显式「无 numeric score、无 correct/partial/wrong」，任何把评阅渲染成「得分/判定」的设计都是编造数据。
5. **存储列取舍**：`writing_task` 新增 `writing_task_id uuid` **一列** —— 无既有列可复用（`target_note_id` 背着指向 `l3_study_notes` 的 RESTRICT FK，借来装 task id 会污染删除 blocker 语义）；`writing_feedback` **复用 `submission_id`**（沿 grading 先例：身份即 sheet，能复用就不新增）。两个 kind 均为非 quote 型（offset/quote 列全空）。
6. **`changed` 在 feedback 链同样是承重路径**（与 grading 同款：单行覆写 ⇒ 改判必然可达）。引用卡片必须能表达「此评阅已被更新」；task 链的 changed 只在改标题时可达（低频，沿 note）。
7. **K4 回归锁**：`draft_version` 不进**任何** writing 相关引用的 hash —— 它是 CAS 锁不是版本（chain03 K4）。writingSheet 沿 `sheetFieldText`（已排除，`service:132-138`）；本链新增的两个 kind 天然不含它（决策 4 的白名单里没有它的位置）。
8. **封闭联合反向断言**：sheet / attempt / grading 引用的快照里**不出现**任何 writing 字段；writing 相关快照里不出现 verdict/analysis（评阅不是判定，见决策 4 末段）。
9. **迁移范围**：0048 只做三处 CHECK 放宽（`kind_check` 加两值；`target_check` 加两分支：`writing_task` 要求 `writing_task_id` 必填其余目标列全空，`writing_feedback` 要求 `submission_id` 必填其余全空；`quote_check` 非 quote 数组加两值）+ 新增 `writing_task_id` 列 1 个；`schema.ts` 同步；迁移计数 48 → 49。可与第 5 条链其余变更合并进同一个 0048。
10. **测试必交矩阵**（缺一不得开放）：① task 改标题 ⇒ `changed`，快照逐字不动；② task 归档 ⇒ 已存引用仍按 hash 派生（不撤销、不自动转 unavailable）；③ feedback 任一内容字段变化 ⇒ `changed`；④ `version` / `last_editor` 变化 ⇒ **不**转 `changed`（决策 4 的另一半）；⑤ draft sheet 上的 feedback 行 ⇒ 装载侧 JOIN `l3_submissions status='sealed'` 过滤 + capture 404 双保险；⑥ 邻接 kind 快照不含 writing/verdict 互串字段（决策 8）；⑦ `draft_version` 自增 ⇒ 所有 writing 相关引用纹丝不动（K4 回归锁）；⑧ v1 对两个新 kind 422 fail-closed（`assertV1Kinds` 现为类型守卫，N1 之外自动拒绝，无需新代码）；⑨ 反馈快照/UI 无分数、无判定徽标（决策 4 末段的回归锁）。

## Tradeoffs

① **签 ① vs 做 ②（草稿可引）** —— ② 的真正成本不是多一个分支，而是 `changed` 语义的通胀。第 4 条链交付时 diff coverage 与卡片文案都建立在「changed = 值得用户看一眼」上；草稿引用会让最常见的 changed 来源变成「用户刚才打了字」。信号一旦通胀，唯一的修复是再加一个「重要 changed」的二级信号 —— 那是在为当初省下的一次签字还高利贷。

② **`writing_task` hash 只取 title 是否太窄** —— task 行的可变字段几乎只有 title（kind/direction 建时定，改题意 = 新建任务）。`updated_at` 会随归档刷新，故意排除（沿 note 先例）。若日后 task 加可变字段，按「内容进 hash、归属不进」的同一句话判定，不必重开 ADR。

③ **feedback hash 吃全文 jsonb 是否太宽** —— 评阅是低频动作（一定稿才有），全文 hash 的误报成本与 grading 同款（ADR-0039 Tradeoffs ③）。反过来只 hash `summary` 的代价是「维度评论改了无告警」，而维度评论恰恰是评阅的本体 —— 不可接受。

④ **为什么 feedback 身份是 `{sheetId}` 而不是 feedback 行 id** —— `UNIQUE(user_id, sheet_id)` 保证一纸一行，行 id 与 sheetId 一一对应；用 sheetId 做身份让「引用某稿的评阅」可读、可推导（与 grading 的 `{sheetId, questionId}` 同款可读性），且装载时天然带出 sealed 过滤。

## Consequences

- **domain**：`REFERENCE_KINDS` 加 `writing_task` / `writing_feedback`（9→10→**12**，grading 之后）；`referenceTargetSchema` 加两分支（strict，`version` 类字段拒收沿 grading 先例）；`*_EXCERPT_MAX` 加 `STUDY_FEEDBACK_EXCERPT_MAX = 280`；快照类型两份；field text 纯函数两个（`{title}` / canonical `feedback`）。
- **repository**：`LoadedWritingTaskTarget` / `LoadedWritingFeedbackTarget`；`loadTargets` 加两分支 —— task 查 `l3_writing_tasks`（白名单四列，不 JOIN）；feedback 查 `l3_writing_feedback` JOIN `l3_submissions` 且 `status='sealed'`（D1-a 在 SQL 层的落实，与 grading 的 sealed 谓词同款位置）。
- **迁移 0048**：见决策 9；`schema.ts` 同步三处 CHECK + 新列；`db:schema:drift` 预期仅此范围；迁移计数 48 → 49（`tests/scripts/verify-existing-volume-role-upgrade.test.ts`）。
- **授权**：引用创建/预览面已是 owner-only，本链**不新增面**、不改 minRole（沿 ADR-0039 Consequences）。
- **导出**：v2 承载两新 kind（target：`{taskId}` / `{sheetId}`，无版本维度）；v1 经 `assertV1Kinds` 自动 422（类型守卫，N1 之外无需逐个列举 —— 这正是 chain04 顺手改成守卫的原因）。
- **前端**：kind 中文标签（写作任务/评阅）、picker 身份键（`writing_task:<id>` / `writing_feedback:<sheetId>`，沿 grading「不只按题判等」的注释纪律）、摘录行、清单标签；**评阅卡片无分数、无判定徽标**（决策 4）；引用入口沿既有 `presetReference` 机制，不新增搜索面（search 仍只收 source/question，沿 R-2 纪律）。
- **测试**：决策 10 的 9 条矩阵 + 仓储 SQL 谓词断言（sealed JOIN、白名单列、复合键过滤）+ 0048 迁移契约 + 导出 v1/v2 + 前端空维度评论不塌摘要。
- **后续**：第 5 条链的实施按既有纪律走（纯函数先落、边界测试锚定、导出 v1/v2 分别测）；N2 计划文档的 D1-a 标签字、第 5 条链解锁。
