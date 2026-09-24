# N2 第三条垂直链任务书（精确 sheet + attempt 引用）— 2026-09-24

> 分支：`study-notes-n2-chain03` @ `82b0f0b45f33d12f8c66264a0b23d1d3e245fa51`（= main 尖端 = PR #135 merge commit）
> 前置链：chain01（评析 `assessment`）/ chain02（笔记互链 `note`）**均已并入 main**。
> 上游：N2 盘点 `study-notes-n2-inventory-2026-09-23.md`、N2 任务书 `study-notes-n2-execution-2026-09-23.md`
> （§2 接入顺序第 3 项、§3 五件套、§5.1 D1/D3/P4、§6 验收矩阵 V-1…V-15）。
> **本文件先于实现**：按硬边界，合同未写入并自检前不动 `src/`、迁移与生成物。

---

## 1. 范围与停点

- 本链只做**两类新目标**：`sheet`（= `l3_submissions` 的 sealed 稿次）、`attempt`（= `l3_question_attempts` 的作答记录）。
- 不动 D1-a / D3-a 之外的话题；**不启动 chain04（grading）/ chain05（writing）**；不碰 `#129`；不部署。
- 停点：产出 draft PR 后停止，交独立审查；未收到单独合并授权前不转 ready / 不合并 / 不部署。

## 2. 实体事实（代码证据）

| 事实 | 证据 |
|---|---|
| sheet = `l3_submissions`；`status ∈ {draft, sealed, discarded}`；sealed 后 PATCH 恒 409 | `src/db/schema.ts:1364-1421` |
| 已有跨表属主复合外键所需唯一键 `l3_submissions_id_user_id_unique(id,user_id)` | `src/db/schema.ts:1391` |
| `l3_submissions_own_all` RLS（permissive, all, auth.uid()=user_id） | `src/db/schema.ts:1414` |
| writing 身份必带 `revision_no > 0`；非 writing 恒 NULL | CHECK `l3_submissions_writing_revision_check` `:1418` |
| attempt = `l3_question_attempts`；**软删**（`status ∈ {active, deleted}` + `deleted_at`），行不可变 | `:1428-1449`；注释「attempt 行不可变，串行即天然快照」`:1426` |
| attempt **无** `(id,user_id)` 唯一键 → 复合属主 FK 需先补唯一键（同 chain01 迁移拆分教训） | `:1440-1445` 仅索引 |
| attempt 的 `sheet_id` **可空**且对 sheet `ON DELETE SET NULL` | `:1432` |
| **存在** attempt 删除端点 `DELETE /api/l3/attempts/:id`（服务侧为软删） | `src/http/operations.ts:554`、`src/services/l3-sheets.service.ts:298` |
| sheet **无**删除端点：writing 仅有 `discard`，且**只允许 draft 丢弃**（sealed 不可弃） | `operations.ts:569`、`src/services/l3-writing-sheet.service.ts:377` |
| 只读面已存在：`GET /api/l3/sheets/:id`、`GET /api/l3/attempts`（list，非 per-id） | `operations.ts:548`、`:553` |
| v1 收口为 N1 五种白名单断言 → 新 kind 自动 422，无需改 v1 通道 | `l3-study-note-export.service.ts:416` |

## 3. 本链合同（签字项）

### 3.1 D1-a 裁决落地 — **只允许 sealed 稿次被引用**

- **K1** 引用目标是 sheet 时，`l3_submissions.status` 必须等于 `sealed`；`draft` / `discarded` 一律 `404 StudyReferenceTarget`
  （**不是 409**：draft 不是「冲突」，是不存在的合法目标）。
- **K2** 「submitted」在本 schema 中不存在（只有 draft/sealed/discarded）；**不得**把 draft 当作稳定身份，
  **不得**先按「draft 可引用」实现留待日后收紧。
- **K3** 身份遵循 D1-1 / D1-2：writing 稿次 = `{ submissionId, revisionNo }`（`revisionNo` 必填，>0）；
  非 writing（file / paper）= `{ submissionId }`，`revisionNo` 为 NULL。引用行**落库存 `submission_revision_no`**，
  在引用行**落库存 `submission_revision_no`**，让「同一稿次不同 revision」的情况在未来可被察觉而不是静默错配。
- **K4** `draft_version` **不进**身份、不进 `field_hash`（沿用 D1-3：它是 CAS 乐观锁，不是版本）。
- **K5** 不得用「所属 writing task」「parent sheet」「题目」「最近一次稿次」兜底匹配身份（D1-5 同款）。

### 3.2 D3-a 裁决落地 — **只支持当前评卷，不伪造历史 grading version**

- **K6** 本链不引入任何 grading 目标；不为 `l3_grading_results` 虚构 `version` / 历史列 / 历史表。
- **K7** 引导性问题必须在别处消化：sheet / attempt 引用**不携带**评卷结果、verdict 或评分数据；
  快照白名单显式排除 `l3_grading_results` 的任何字段。
- **K8** 第 4 条链（grading）开工条件维持不变：若要支持「某次具体评卷」，须**先补版本列 + 迁移 + 签字**。

### 3.3 D4 / P5 冻结 — attempt 身份、历史语义、归档与删除

- **K9** attempt 身份 = `{ attemptId }` **单值**，不拼接 question / sheet / venue。
  装载与加锁一律按 `attempt:<uuid>` 取件，**不存在**「按题目找最新一次 attempt」的回退路径。
- **K10** attempt 只在其 `status = 'active'` 时可被新建引用；装载（capture/resolve 同依赖）同条件过滤 deleted。
  被软删后：引用**保留**，状态按 `unavailable` 呈现并保留已存快照与 `capturedAt`（C1 占位块语义）。
- **K11** **删除登记（P5 / A3）**：attempt 的删除端点真实存在（软删），故本链必须登记 **attempt blocker**——
  删除前查引用，命中则返回既有 409 blocker 列表（`DeleteBlockerRow` 同款：note 去重 + 计数），由用户先清理引用再删。
  这是既有快捷路径的延伸，**不是**虚构阻塞面。sheet 侧**无**删除端点、sealed 不可弃（证据 §2），
  因此**不新增 sheet blocker**——不虚构不存在的删除面（chain02 同款纪律）。
- **K12** attempt 行不可变 → `field_hash` 写死为「快照所用字段」的规范化文本；
  实际不可变意味着 **`changed` 不可达**，这是**承认的事实**而非缺陷（测试需锚定「永不变为 changed」）。

### 3.4 快照 / 变更提示 / 导出

- **K13** 快照沿用既有摘录预算族：新增 `STUDY_SHEET_EXCERPT_MAX = 280`、`STUDY_ATTEMPT_EXCERPT_MAX = 280`
  （与 `STUDY_SOURCE/ASSESSMENT/NOTE_EXCERPT_MAX` 同量级，**不改** `STUDY_NOTE_BODY_MAX` 与 `STUDY_SNAPSHOT_BYTES_MAX`）。
- **K14** sheet 快照 = `{ scope, summaryExcerpt }`（`summary` 截断，不切代理对）；
  attempt 快照 = `{ venue, answerExcerpt }`（`answer` 规范化 JSON 文本截断）。
  **两者都不落标准答案 / 解析 / evidence / 评卷字段**（V-14 同款）。
- **K15** `field_hash` 输入写死（A2）：sheet = `{ status:'sealed'?…}` —— 具体为 `{ scope, revisionNo, summary }`；
  attempt = `{ venue, answer }`（不含 `deleted_at`、`created_at`、`self_assessment`）。
- **K16** 导出：新 kind 自动被 `assertV1Kinds` 拒 422（不静默降级、不悄悄回 v1）；
  v2 增加 `sheet` / `attempt` 两个判别变体，target 形状分别为 `{ kind:"sheet", submissionId, revisionNo|null }`、
  `{ kind:"attempt", attemptId }`；**无**新前端出口（沿用 P4-2 显式传 `schemaVersion=2` 的既有通道）。

### 3.5 锁键

- **K17** 事务级 advisory 锁沿用既有命名：<code>l3_submission:`<uuid>`</code>、<code>l3_attempt:`<uuid>`</code>。
  attempt 锁同时保护「capture」与「软删」串行化（否则删除与引用会排到 FK / 软删之后）。

## 4. 数据模型决策

`l3_study_note_references` 继续扩展（列式 target + CHECK 收口，无自由 JSON）：

| 项 | 决策 |
|---|---|
| 新增列 | `submission_id uuid`、`submission_revision_no integer`、`attempt_id uuid`（三者可空） |
| kind_check | 增 `sheet` / `attempt`（枚举 7 → 9） |
| target_check | 增两支：sheet → `submission_id NOT NULL` 且其它 target 列 NULL；attempt → `attempt_id NOT NULL` 且其它 NULL；既有六支追加两个新列 `IS NULL`，行为不变 |
| quote_check | `sheet` / `attempt` 并入非摘录组（三字段全 NULL） |
| 新增 CHECK | `submission_revision_no IS NULL OR submission_revision_no > 0` |
| FK | `(submission_id,user_id) → l3_submissions(id,user_id)` RESTRICT；`(attempt_id,user_id) → l3_question_attempts(id,user_id)` RESTRICT |
| 索引 | `(user_id,submission_id,note_id)`、`(user_id,attempt_id,note_id)`（反向引用查询与 note 归属同款） |
| 迁移编号 | **0043** 先补 `l3_question_attempts(id,user_id)` 唯一键（drizzle 会把复合 FK 排到依赖 UNIQUE 之前 → 真库红，chain01 教训）；**0044** 再加列 / FK / CHECK / 索引。权威迁移计数 **43 → 45** |

> 若实际 `db:generate` 产出的单文件在真库一次性通过（可能性低），仍以「两个迁移、顺序 0043→0044」为准，
> 且在真库按 A/B 两顺序验证。

## 5. 状态语义（本链冻结）

| 目标 | current | changed | unavailable |
|---|---|---|---|
| sheet（sealed） | 常态：快照与其 <code>field_hash</code> 一致 | sealed 稿不可变 → **不可达**；若日后出现变更路径，必须能被显式察觉（不得静默改判） | 目标不属该用户 / 不存在 |
| attempt | 常态 | attempt 行不可变 → **不可达** | 目标不属该用户 / 不存在 / 已软删 |

## 6. 验收矩阵（延续 task book §6 编号）

| # | 条目 | 验证方式 |
|---|---|---|
| V-16 | draft 稿次引用被拒（404），discarded 同样被拒；仅 sealed 可建 | 服务层用例 + 真库 CHECK 探针 |
| V-17 | writing 稿次 target 必带 `revisionNo>0`；缺失/为 0 → 422 | 域层用例 + DB CHECK 探针 |
| V-18 | 非 writing 稿次不落 revision（NULL），不存在以 revision 拼身份的路径 | 仓储/服务用例 |
| V-19 | attempt 引用只按 `attemptId` 解析；按 question / sheet 兜底的替身**必须取不到**（P1-1 同款防复发） | 忠实装载替身 + 断言装载请求含 `{kind:"attempt",id}` |
| V-20 | attempt 软删后：引用保留、状态 `unavailable`、快照/时间逐字节不变 | 服务层用例 |
| V-21 | `DELETE /api/l3/attempts/:id` 命中引用 → 409 + blocker 列表；未命中 → 204 不变 | http 用例 + 既有删除用例回归 |
| V-22 | sheet 无删除面 → **不新增** sheet blocker（迁移 diff 与路由 diff 复核） | 生成器复核 |
| V-23 | 快照白名单不含 grading / 答案 / 解析 / evidence | 白名单断言 |
| V-24 | v1 对含 `sheet` / `attempt` 的笔记 → 422；v1 通道对纯 N1 笔记不受影响 | 导出用例正/反 |
| V-25 | v2 target 带 `kind` 判别，且 `revisionNo` 允许 `null` | 契约 + 运行时解析用例 |
| V-26 | 无新前端出口（grep 前端调用方 + 手工回归：UI 导出仍走显式 v2 通道） | 前端用例 |
| V-27 | 迁移 0043/0044 在隔离 PostgreSQL 应用 + 结构探针 + 功能探针 + replay no-op | 真库脚本 |
| V-28 | `field_hash` 计算与 D1-3 一致：`draft_version` 变更不影响 `current` | 服务层用例 |

## 7.0 TDD 第 1 步红测记录（2026-09-24，实现前）

| 红测 | 落点 | 失败原因（这就是红） |
|---|---|---|
| 10 条迁移静态契约（0043/0044 存在性与顺序、三列、两个复合 RESTRICT FK、kind_check 9 值、target_check 两支互斥、quote_check 分组、revision 正值 CHECK、两个索引、journal 顺序、不 DROP TABLE、**RLS 不退坡**、schema.ts 权威同步） | `tests/scripts/l3-study-reference-sheet-attempt-migration.test.ts`（新增） | `missing 0043/0044`、断言所需 SQL 不存在 |
| 权威迁移计数 43 → **45** | `tests/scripts/verify-existing-volume-role-upgrade.test.ts:54` | `expected 45, received 43` |
| 2 条 attempt 软删 blocker（按 `attempt_id` 聚合、逐笔记计数含归档、**禁止** question/submission 兜底） | `tests/repositories/l3-study-references.test.ts`（新增 describe） | `repo.getAttemptDeleteBlockers is not a function` |

命令与退出码：
`npx vitest run tests/scripts/l3-study-reference-sheet-attempt-migration.test.ts tests/repositories/l3-study-references.test.ts tests/scripts/verify-existing-volume-role-upgrade.test.ts --coverage.enabled=false`
→ **退出码 1**，`Test Files 3 failed (3)`，红测 **13 条全红**（预期），同批次既有 25 条仍绿。

**说明**：RLS 方面本链**不新增表、不改策略**（`l3_submissions_own_all` / `l3_question_attempts_own_all` /
`l3_study_note_references_own_all` 沿用），故 0043/0044 的 RLS 面为**护栏式断言**（禁止 DISABLE RLS / DROP POLICY / CREATE TABLE），
真实验收由 §6 V-27 的隔离真库探针承担。

## 7.0.1 实现阶段 1–6 记录（2026-09-24）

**迁移（顺序由两趟 `db:generate` 保证，非手工编辑）**
- 第一趟只加 `unique("l3_question_attempts_id_user_id_unique")` → `0043_warm_banshee.sql`（1 条语句，仅唯一键）
- 第二趟加三列 + 两个复合 RESTRICT FK + 三个 CHECK 重建 + `revision_no_check` + 两个索引 → `0044_cold_the_spike.sql`（13 条语句）
- journal 顺序 0043 → 0044；权威计数 **43 → 45**（`db:generate` 与 journal 均由工具产出）

**隔离真库验收（一次性库 `vocab_n2_chain03_verify`，Docker `vocab-local-pg`:5433，以本机超级用户 `vocab` 应用）**
- `npx drizzle-kit migrate` → 退出码 0，45 段迁移全应用成功
- 结构探针 **S1–S7 全通过**：唯一键、三列、两个 RESTRICT 复合 FK、kind_check 含 sheet/attempt、revision CHECK、两个索引、迁移计数 45
- 功能探针 **F1–F10 全符合预期**：F1/F2 正常写入；F3 空 submission、F4 attempt+submission 并存、F5 attempt 带 quote、F6 revision=0 均被 CHECK 拒；F7 不存在目标、F8 他人目标被复合 FK 拒；**F9 软删 UPDATE 1 通过（证明软删不撞 RESTRICT → blocker 必须在应用层）**；F10 硬删被引用稿次被 RESTRICT 拒
- 探针脚本：`D:/tmp/n2-chain03/verify-0044.sql`

**blocker 与删除链路**
- `getAttemptDeleteBlockers`：只按 `r.attempt_id` 聚合，逐笔记计数、含归档、无 status 过滤、无 question/submission 兜底
- `L3SheetService.deleteAttempt`：先 `lockTargets([{kind:"attempt",id}])`（`l3_attempt:<uuid>` 事务级 advisory）→ 查 blocker → 命中抛 409 `ConflictError`（payload 与 N1 `questionStudyNoteConflict` 同款）；软删不执行
- 新增用例：仓储 2 条（红转绿）、服务 3 条（含锁键断言、409 payload 断言、软删未执行）、HTTP 1 条（409 → `details.blockers.studyNotes`）

**OpenAPI / 生成物 / breaking（R-1 实测）**
- `npm run api:openapi` → **openapi.json 与 main 字节一致（零 diff）**；`api:client:generate` + `api:client:check` 均 0；`api:contract` 10 passed
- 原因：`DELETE /api/l3/attempts/{id}` 的文档响应集**本来就含 409**（200/201/204/400/401/403/404/409/413/415/422/429），新增 409 语义不构成契约变更
- `npm run api:breaking` 本机不可用（`spawnSync git EBUSY`）→ 改用**同一门禁函数** `runOpenApiBreakingGate` + 文件版 base loader 实测：**`GATE_ISSUES=0`、`UNKNOWN_COUNT=0`** → **R-1 未触发**，无需重锚 approval、无需扩展判定器
- approval 文件与主线上一致未改动（gate 走「approval 未变更即早退」分支）

**回归与门禁（本机）**
- `npm run typecheck` **0**（过程中修正一处：测试从 `@/repositories/interfaces` 导入未导出的 `IL3StudyReferenceRepository`，改为从定义处导入）
- `npx tsc --noEmit -p tsconfig.frontend.json` 0；`npm run arch:check` 0（无违规）；`npm run frontend:build` 0
- 定向测试 9 文件全绿（l3-sheets / study-reference / study-notes / export / references 仓储 / l3-sheet http / study-notes http / 迁移契约 / 权威计数）
- **环境限制**：`npm run db:schema:drift` 与 `npm run api:breaking` 的 CLI 均因 node 子进程 `spawnSync` 恒 `EBUSY` 无法运行；drift 的**实质**已由 `npx drizzle-kit generate` 直跑（`No schema changes`，退出码 0）+ 真库 45 段迁移 + S1–S7 探针三路佐证，CI 上再复跑脚本版

## 7.0.2 步骤 A 收口复跑（2026-09-24，第一个提交前）

**工作区快照**：HEAD `82b0f0b45f33d12f8c66264a0b23d1d3e245fa51`，分支 `study-notes-n2-chain03`；
8 个 M + 6 个 ??；`git diff --stat` = 8 files changed, 252 insertions(+), 13 deletions(-)。

**归一**：`l3QuestionAttempts` 上方表注释被误加了一个制表符缩进，已还原为列 0（纯空白，schema 语义不变，
diff 收敛为 `src/db/schema.ts` **+35/-3**）。

**复跑（均记录退出码）**

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/scripts/l3-study-reference-sheet-attempt-migration.test.ts tests/scripts/verify-existing-volume-role-upgrade.test.ts --coverage.enabled=false` | **exit 0**，2 files / **19 passed** |
| `npx vitest run tests/repositories/l3-study-references.test.ts tests/services/l3-sheets.test.ts tests/http/l3-sheet.test.ts --coverage.enabled=false` | **exit 0**，3 files / **78 passed** |
| `npm run typecheck` | **exit 0** |

**隔离真库复现（一次性库 `vocab_n2_chain03_a`，Docker `vocab-local-pg`:5433，超级用户 `vocab`）**

- `DATABASE_URL=…/vocab_n2_chain03_a DB_SSLMODE=disable npx drizzle-kit migrate` → **exit 0**，45 段全应用
- S1–S7 **全通过**：唯一键 `l3_question_attempts_id_user_id_unique`=1；三列=3；两个复合 FK 均
  `confdeltype=r`（`submission_owner_fk`→`l3_submissions`、`attempt_owner_fk`→`l3_question_attempts`）；
  kind_check 含 `sheet`/`attempt` 均 t；`revision_no_check`=1；两索引=2；迁移计数=**45**
- F1–F10 **全符合预期**（F3–F8、F10 均按预期被 CHECK/FK 拒；**F9 软删 `UPDATE 1` 通过** → 软删不撞 RESTRICT，
  blocker 必须在应用层）
- **RLS 实查**：`l3_study_note_references` / `l3_question_attempts` / `l3_submissions` 三表
  `relrowsecurity=t`，各有 1 条策略；0043/0044 未触碰任何策略（迁移内亦无 `DISABLE ROW LEVEL SECURITY`/`DROP POLICY`）
- 探针脚本 `D:/tmp/n2-chain03/verify-0044.sql`

**字节卫生**：14 个改动文件 CRLF=0、无 BOM（node 直读统计，非 `grep -c $'\r'` 误报口径）。

## 7.0.3 步骤 B–D 实现与验证（2026-09-24，提交 2–4）

**B · 领域层（红测先行）**

- 红：`npx vitest run tests/domain/l3-study-notes.test.ts tests/services/l3-study-reference.test.ts --coverage.enabled=false`
  → **exit 1，17 failed / 88 passed**。失败原因逐条核对均为合同未实现（`REFERENCE_KINDS` 仅 7 值、schema REJECT
  未知 kind、`STUDY_SHEET/ATTEMPT_EXCERPT_MAX` undefined、`targetKeyOf` 对新品类 TypeError），**非测试缺陷**；
  既有 88 条保持通过 → 红测未破坏现有行为。
- 绿：同命令 → **exit 0，105 passed**。
- 实现点：`STUDY_SHEET_EXCERPT_MAX/STUDY_ATTEMPT_EXCERPT_MAX=280`；`REFERENCE_KINDS` 7→**9**；
  `ReferenceTarget` 增 `sheet{submissionId, revisionNo?}` 与 `attempt{attemptId}`（均 `.strict()`）；
  `SheetReferenceSnapshot{scope, summaryExcerpt}` / `AttemptReferenceSnapshot{venue, answerExcerpt}`。
- 类型收口：`npm run typecheck` 首轮 20+ 错误（`LoadedTarget` 联合扩型后各处 switch 缺穷尽分支、
  插入行/返回行缺三列）→ 逐处补齐（export / service / frontend 五处 switch + 三处 refRow）→ **exit 0**；
  `npx tsc --noEmit -p tsconfig.frontend.json`（首轮 3 处 TS2366）→ 补分支后 **exit 0**。

**C · 仓储与服务（同源 target key）**

- `loadTargets` 两段 SQL 均带 `user_id = $1::uuid`（sheet 段另加 `status = 'sealed'`，attempt 段加 `status = 'active'`）；
  `lockTargets` 增 `l3_submission:<uuid>` / `l3_attempt:<uuid>` 两把事务级 advisory 锁；
  `listBacklinks` 的 `targetColumn` 显式映射 sheet→`r.submission_id`、attempt→`r.attempt_id`；
  `searchTargets` 对 sheet/attempt 抛 `ValidationError`（fail-closed，不静默返回空）。
- `targetKeyOf` / `targetRefsOf` 共用同一键式（`sheet:<id>` / `attempt:<id>`），**无兜底**：不通过题目、
  sheet 或当前 attempt 反推身份（`targetRefsOf` 返回类型收紧为 `{kind, id}[]`）。
- 服务装配层新增 4 条真实用例（`tests/services/l3-study-notes.test.ts`，含 `faithfulLoadTargets`
  **忠实装载替身**——只返回实际请求的目标，不做无条件全量建键）→ 该文件 **57 passed**。
- 未使用 `mock ConflictError` 证明生产链路；attempt unavailable / sheet sealed 均以真实服务断言覆盖。

**D · 导出与契约**

| 命令 | 结果 |
|---|---|
| `npm run api:openapi` | **exit 0**（`docs/api/openapi.json` +472） |
| `npm run api:client:generate` | **exit 0**（`src/frontend/api/generated/openapi.ts` +106） |
| `npm run api:client:check` | **exit 0** |
| `npx vitest run tests/http/… api:contract 相关` | **exit 0，10 passed** |
| breaking 探针（文件版 base loader 复算） | RAW_ISSUES=**8** 全 breaking，**UNKNOWN_COUNT=0** |
| 重锚 approval 后门禁 | GATE_ISSUES=**0** / UNKNOWN_COUNT=**0** |

- **R-1 硬门槛未触发**（实测非 UNKNOWN）：8 条 issue 全部被判定器识别为「响应联合变体新增」，
  按用户裁决 A 属可豁免 response 类；三元组已重锚（`baseSha256=848280f4…`、`currentSha256=8dc9465d…`，
  issues 8 条不变）。若判定为 UNKNOWN 本应停下，此处**无需停下**，但结论基于实测而非假定。
- 导出：v2 增 `sheet` / `attempt` 判别变体；**v1 对两个新 kind 继续 422**（`assertV1Kinds` fail-closed）；
  `projectDisplaySnapshot` 补齐两支白名单重建（缺支曾抛「引用快照 kind 非法」）。导出测试 **49 passed**。
- 生成物由命令产出，**未手改**。

## 7.0.4 步骤 E 验证记录（2026-09-24）

**E-1 静态与定向测试**

| 项 | 结果 |
|---|---|
| `npm run typecheck` | **exit 0** |
| 定向 9 文件（domain / repositories / services×4 / http / scripts×2） | **exit 0，9 files / 315 passed** |

**E-2 隔离真库**（`vocab_n2_chain03_a`，45 段）：见 §7.0.2（S1–S7、F1–F10、RLS 结构三表 `relrowsecurity=t`）。

**E-3 RLS 运行时隔离**（双用户探针 `verify-rls.sql`）

- R1 用户 A 可见引用行 2 / sheet 1 / attempt 1；R2 切 B 后**全 0**，且 A 的具体行按 id 精确查也**全 0**；
- R3 B 插入「属主为 A」的行被 RLS `WITH CHECK` 拒；R4 空身份全 0；
- 负对照：B 自己的 attempt 仍可见（1）→ 证明 R2 的 0 来自属主隔离而非装载条件。

**E-4 变异验证（6/6 全部被捕获 → RED）**

| 编号 | 变异 | 结果 |
|---|---|---|
| M1 | sheet/writing 忽略 revisionNo | **caught** |
| M2 | 装载侧放行 draft / discarded | **caught**（首轮未捕获 → 新增「装载侧若放宽，capture 仍按 sealed 断言」用例后 RED） |
| M3 | attempt 软删放行（blocker 漏计） | **caught** |
| M4 | attempt 装载放宽（deleted 可见） | **caught** |
| M5 | sheet 装载放宽 | **caught** |
| M6 | v1 闸门放行 sheet/attempt | **caught** |

**E-5 study-notes E2E（7 spec / 54 tests，全部 exit 0）**

7 个 spec 各自绑定**专属验收库**（spec 内显式断言库名），故按库分批、每批重启服务并换新 `E2E_OUTPUT_DIR`。
前置：`VITE_N1_STUDY_NOTE_HOST=1 npm run frontend:build` → **exit 0**；四个库均 `drizzle-kit migrate` 至 **45 段**。

| spec | 库（迁移后段数） | 结果 |
|---|---|---|
| `study-note-host.spec.ts` | `…task07_accept`（45） | **10 passed** |
| `study-notes-ref-picker-close.spec.ts` | `…task08_accept`（45） | **3 passed** |
| `study-notes-reference-loop.spec.ts` | `…task08_accept`（45） | **4 passed** |
| `study-notes-task08-fix-regression.spec.ts` | `…task08_accept`（45） | **3 passed** |
| `study-notes-workspace.spec.ts` | `…task08_accept`（45） | **23 passed** |
| `study-notes-sheet-side-panel.spec.ts` | `…task09b_accept`（45） | **6 passed** |
| `study-note-export.spec.ts` | `…task10_accept`（45） | **5 passed** |

合计 **54 passed / 0 failed**（task08 四 spec 合批 `33 passed (3.9m)`；host `10 passed (59.0s)`；
side-panel `6 passed (21.5s)`；export `5 passed (23.0s)`）。

**E-6 环境限制（基线对照登记，不写伪通过）**

- `npm run db:schema:drift` / `api:breaking` / `complexity:routes` / `coverage:layered` / `test:collection`
  的**脚本版**在本机恒失败：node 内 `spawnSync` 子进程返回 `status=null`（EBUSY），与基线分支同样表现 →
  **非本链回归**；其实质已分别由 `drizzle-kit generate`（`No schema changes`，exit 0）、真库 45 段迁移、
  文件版 base loader 复算三路佐证，最终以 CI 证据为准。
- E2E 一次全跑会失败（7 spec 绑 4 个不同库）→ 按库分批是本仓既有约束，非本链引入。

## 7. TDD 顺序（不得跳跃）

1. 红：迁移/RLS/FK/CHECK/索引（真库探针脚本 + `db:schema:drift`）
2. 红：领域类型与 target key（`ReferenceTarget`、`targetKeyOf`、`targetRefsOf`）
3. 红：仓储 `loadTargets` / `lockTargets` / `listBacklinks` / `getAttemptDeleteBlockers`
4. 红：`captureAgainst` / `currentFieldText` / `resolve` / `preview`
5. 红：导出 v2 + HTTP 契约 + client 生成物一致性
6. 最小实现转绿
7. **变异验证**（必须）：身份比较写宽（忽略 revisionNo）→ 红；draft 放行 → 红；blocker 漏计 → 红；
   loader 允许 deleted → 红；v1 对新品类放行 → 红

## 8. 已知风险与待观测

- **R-1（提前登记）**：新增 attempt blocker 会给既有 `DELETE /api/l3/attempts/:id` 增加 **409 响应**，
  属 OpenAPI 现有路由新增响应分支。`verify-openapi-breaking` 判定器对该形态可能判 UNKNOWN（**不可豁免**）。
  届时必须先**实测**判定结果：若 UNKNOWN → 带证据停下请示（选项：扩展判定器 / 重锚 approval / 改设计），
  **不代签**。
- **R-2**：attempt 无 per-id 只读 GET → attempt 引用卡片不提供深链（sheet 深链走既有 `/l3?sheet=`）。
  不新增路由、不新增前端出口；登记为 U 项。
- **R-3**：本机 `tests/scripts/*` 子进程 EBUSY 环境限制仍可能存在 → 一律以基线对照 + CI 证据区分，不写伪通过。
  （实测已确认：非本链回归，见 §7.0.4 E-6。）

## 9. 未覆盖项（本链显式登记，非遗漏）

| 编号 | 项 | 说明 |
|---|---|---|
| U-1 | chain02 的 `note` 型引用**未进 schema 层唯一性** | 沿用 chain02 既有合同，本链不改写；不扩大范围 |
| U-2 | attempt **无 per-id 深链**（R-2） | 无只读 GET → 引用卡片不提供深链，不新增路由/前端出口 |
| U-3 | sheet / attempt **不进搜索枚举** | `searchTargets` 显式 fail-closed 抛错，不静默返回空 |
| U-4 | `listBacklinks` 的 assessment 分支仍落 `question_id` 兜底 | chain01 既有行为，本链不动（新增 sheet/attempt 已显式映射） |
| U-5 | grading / writingTask / writingSheet / feedback 四类引用 | 属第四、第五条链，本链不启动 |

## 10. 提交划分（5 个）

1. `cb62c3a` 阶段 1–6 数据层与 attempt 删除 blocker（schema / 迁移 0043+0044 / 仓储 blocker / 服务 409 / HTTP）
2. `0219a88` 领域类型与 target key（domain types / 快照投影 / schema 校验两支 / 仓储装载与锁键 / 前端穷尽分支）
3. `3a8822e` 响应契约与生成物（HTTP contract / openapi.json / generated client / approval 重锚）
4. `8e2d7e3` 服务装配层 / 导出 v2 变体 / v1 冻结用例
5. （本提交）测试、台账与证据（M2 补测 + §7.0.3 / §7.0.4 / §9 / §10）

## 11. 停止条件声明

本链创建 draft PR 后即停止：**不转 ready、不合并、不部署**；不启动 N2 第四、第五条链；
不处理 #129。独立审查与单独合并授权前保持 draft。

## 12. 审查结论与观察登记（2026-09-24）

**审查结论（独立审查者）**：**无 P0、无 P1，建议合并（READY FOR MERGE）**。确认点：

- 0043/0044 迁移顺序、复合 FK、CHECK、索引与 RLS 护栏符合合同；
- `sheet` 仅允许 sealed，writing 稿次校验 `revisionNo`；`attempt` 仅按 `attemptId` 装载；
- attempt 删除先加锁、查询 blocker，再决定软删，409 payload 与既有合同一致；
- v1 对新类型继续 422，v2 schema 与快照白名单包含 `sheet`/`attempt`；
- 解析逻辑使用同源 target key，软删 attempt 保留快照并返回 `unavailable`；
- 本地 `npm run typecheck` exit 0，`git diff --check` 通过，工作区 clean。

**非阻塞观察（P3，本链不处理，登记后续项）**

| 编号 | 观察 | 处置 |
|---|---|---|
| P3-R1 | `targetKeyOf(sheet)` 只含 `submissionId`，`revisionNo` 由 capture 校验并纳入 hash；**resolve 侧缺一条 revision 不匹配回归测试** | 登记为 chain03 后续项；属测试加固，不改行为，不阻塞本链 |
| P3-R2 | HTTP 409 用例 mock 了 service，真实删除顺序由 service 测试覆盖；**可补一条更接近生产装配的链路测试** | 登记为 chain03 后续项；本链 service 层已有真实顺序断言，不阻塞 |
| P3-R3 | 审查者本机 Vitest 受 `node_modules/.vite-temp` Windows `EPERM` 阻止启动 | **环境问题，非代码失败**；与 §7.0.4 E-6 同类，以 CI 证据为准（本链三项必需检查全绿） |

**远端只读核验补证（2026-09-24，审查者因网络凭据未能自查，由实现方代查，只读）**

- PR #136：`headRefOid=8925b8291fe00d5bfc6c9b01727cc09522867880`（= 本地 HEAD）、`isDraft=true`、
  `state=OPEN`、`mergeable=MERGEABLE`、`reviews=[]`（审查为线下进行，无 GitHub review 记录）；
- CI（同一 head `8925b82`）：`CI` run `35981670021` success（内含 Engineering Gate + Migration Rehearsal、
  Browser E2E 两 job 均 success）、`Writing E2E` run `35981670033` success。

**状态**：审查结论为「建议合并」，但**单独合并授权尚未发出**——按 §11 纪律，本提交仅做观察登记，
不转 ready、不合并、不部署。等待单独合并授权指令。
