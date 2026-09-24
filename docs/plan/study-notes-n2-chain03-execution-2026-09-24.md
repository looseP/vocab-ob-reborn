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
