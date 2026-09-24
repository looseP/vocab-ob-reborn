# N2 第二条垂直链（笔记到笔记引用）执行台账 — 2026-09-23

- 分支：`study-notes-n2-chain02`（`D:/Temp/vocab-ob-n2-chain02`，独立 worktree）
- 基线：`origin/main` = `5df2fe3a6e63fb236d18da375c4b27c77e93872e`（PR #134 merge commit，实测仍为 main 尖端）
- 前置链：N2 第一条垂直链（注记/评析）已并入 main（PR #134）
- 本轮边界：**只做笔记互链**；不碰 sheet/attempt、grading、作文稿次；不合并、不部署

---

## 1. 开工门槛复核（阶段 A）

| 项 | 实测 | 结论 |
|---|---|---|
| 远端 main | `git rev-parse origin/main` = `5df2fe3a6e63…` | main 未前移 |
| #134 merge commit 是祖先 | `git merge-base --is-ancestor 5df2fe3… origin/main` → **YES** | 基线即 `5df2fe3…` |
| `study-notes-n2-chain02` 已存在？ | 本地 `branch --list` 空、远端 `ls-remote` 无输出 | 不存在，无覆盖风险 |
| D2（笔记互链载体） | inventory §8 D2 / 任务书 §5 P2，原「未裁决」 | **已由用户于 2026-09-23 裁决：扩展 `l3_study_note_references`，不新建链接表** |
| P5（内容清理边界） | 任务书 §5 P5，原「未裁决」 | 本链裁决：**保留复合属主 FK + RESTRICT；当前无硬删除端点，不虚构应用删除 blocker；未来若加硬删除必须先实现引用 blocker** |
| D4（attempt 只读回看） | inventory §8 D4，仍未裁决 | 原文限定「历史 attempt 引用」= 第 3 条链，**不约束本链** |
| D1-a / D3-a | 仍未裁决 | 只阻塞第 4/5 条链；本链不触碰 |
| 快照长度上限 | `src/domain/l3-study-notes.ts:44` `STUDY_SNAPSHOT_BYTES_MAX = 2 MiB`；`:51/:53` 摘录上限 280 | **存在明确上限，停点条件未触发** |

### 1.1 快照上限的证据与采纳（合同 8）

| 常量 | 位置 | 值 |
|---|---|---|
| `STUDY_NOTE_BODY_MAX` | `src/domain/l3-study-notes.ts:32` | 100 000 UTF-16 code units（与 DB CHECK `l3_study_notes_body_check` 同源） |
| `STUDY_SNAPSHOT_BYTES_MAX` | 同文件 `:44` | 2 MiB（全部 snapshot 序列化总量，超出 422） |
| `STUDY_SOURCE_EXCERPT_MAX` / `STUDY_ASSESSMENT_EXCERPT_MAX` | 同文件 `:51` / `:53` | 280（展示快照摘录） |

**采纳**：新增 `STUDY_NOTE_EXCERPT_MAX = 280`（`src/domain/l3-study-notes.ts`），沿用来源/评析**同量级摘录口径**；
`field_hash` 仍取**完整**标题+正文（不受摘录截断影响）。未改动任何 API 或存储限制。
> 口径说明：合同 8 原文为「沿用现有正文长度上限」。现有**展示快照**的既有口径是 280 摘录
> （来源/评析皆是），故按同款复用；正文上限 100 000 与总量 2 MiB 仍分别是正文与快照总预算的边界。
> 若本意是「快照可存完整正文（至 100 000）」，请在审查时指出——那会放大单条引用体积并与
> `STUDY_SNAPSHOT_BYTES_MAX`（100 条 × 100 000 字 ≫ 2 MiB）冲突。

---

## 2. 已签字合同 → 实现点 → 测试证据

| # | 合同 | 来源 | 实现点 | 测试证据 |
|---|---|---|---|---|
| 1 | 扩展 `l3_study_note_references` 新增 `note` 引用型，不新建链接表 | 用户裁决 | `src/domain/l3-study-notes.ts`（`REFERENCE_KINDS`/`ReferenceTarget`/`NoteReferenceSnapshot`）；`src/db/schema.ts`（`target_note_id` 列）；`drizzle-release/0042_cultured_praxagora.sql` | `tests/repositories/l3-study-references.test.ts > N2 笔记互链（仓储层）` 5 例；真库迁移验收 P1–P10 |
| 2 | 复用现有权限/快照/field_hash/三态/反向引用/只读定位 | 冻结项 A1–A4、B1–B3、C1–C3 | `L3StudyReferenceService.captureAgainst/resolve/preview`；`currentFieldText`；`liveTitleOf`；`listBacklinks` 新增 note 列分支 | `tests/services/l3-study-reference.test.ts > N2 笔记互链` 10 例 |
| 3 | v1 永久冻结；含 note 引用只能显式选 v2，v1 → 422 | P4-1/P4-2、inventory §6 D2 | `assertV1Kinds`（note 不在 `N1_REFERENCE_KINDS` 自动命中）；`toExportTarget`（note 与 assessment 同组 fail-closed throw）；`toExportTargetV2` 增 `{kind:"note",noteId}`；`projectDisplaySnapshot` 增白名单分支；`KIND_LABELS`/`snapshotSummary`/渲染块 | `tests/services/l3-study-note-export.test.ts > N2 笔记互链导出` 3 例（v2 target、v1 422、v1 通道不受影响） |
| 4 | 目标必须本人且 active 才能新建；之后归档不撤销，仍按 hash 判 current/changed，允许只读定位，不自动恢复 | 用户裁决 | `loadTargets` note 段**不按 status 过滤**（与 question 的 F3 不同）；`captureAgainst` case "note" 校验 `status === "active"` | 「capture：目标笔记已归档 → 404」「目标之后归档 → 仍解析为 current」「capture：他人笔记 → 404」；真库 P10（归档后引用保留） |
| 5 | 复合属主 FK + RESTRICT；无硬删除端点下不虚构 blocker；未来加硬删除须先有 blocker | 用户裁决 / B1 / A3 | `l3_study_note_references_target_note_owner_fk`（`target_note_id,user_id` → `l3_study_notes(id,user_id)` RESTRICT）；**未新增任何 get*DeleteBlockers** | 真库 P6（目标不存在→FK 拒）、P7（跨用户→FK 拒）、P9（删目标→RESTRICT 拒）；仓储断言 `listBacklinks` note 列 |
| 6 | 禁止自引用；允许多个不同笔记成环；只展开一层、绝不递归 | 用户裁决 | 应用层 `prepareReferences` 抛 422 `references`（UUID 归一化比较）；DB `l3_study_note_references_no_self_note_check`；`LoadedNoteTarget` 不含引用集合；`display_snapshot` 只 `{kind,title,excerpt}` | 「自引用 → 422」「自引用大小写不敏感」「成环允许…只解一层」；真库 P2（CHECK 拒）、P8（A↔B 两条均成功） |
| 7 | field_hash = 服务端标题+正文，复用现有规范化；不含 version/归档状态/更新时间 | A2 / 用户裁决 / D1-3 同款理由 | `noteFieldText()` = `JSON.stringify({title, bodyMd})`（与 `questionFieldText` 同款固定键序）；`currentFieldText` note 分支 | 「capture：hash 输入写死为服务端标题+正文」；「currentFieldText：note 的 hash 字段文本」 |
| 8 | 快照大小沿用现有上限 | 见 §1.1 | `STUDY_NOTE_EXCERPT_MAX = 280` + `safeExcerpt`；总量仍受 `STUDY_SNAPSHOT_BYTES_MAX` | 「capture：快照摘录沿用现有摘录上限（280）且不切代理对」（400 字正文 → 摘录 280，hash 仍取全文） |

### 2.1 额外落地项（为保持既有门禁不破）

- `searchTargets` 对 `kind = "note"` **fail-closed 抛 422**（与评析同款）：笔记互链不新增搜索面，
  调用方改走既有 `GET /study-notes?q=` 选取目标。
- 权威迁移计数 42 → **43**（`tests/scripts/verify-existing-volume-role-upgrade.test.ts`）。
- OpenAPI breaking approval **重锚**（见 §4）。

---

## 3. 迁移 0042（唯一新增迁移）

文件：`drizzle-release/0042_cultured_praxagora.sql`（9 条语句，`drizzle-kit generate` 产出，未手改）

| 语句 | 内容 |
|---|---|
| 1–3 | DROP `kind_check` / `target_check` / `quote_check` |
| 4 | ADD COLUMN `target_note_id uuid`（可空） |
| 5 | ADD CONSTRAINT `l3_study_note_references_target_note_owner_fk`（`target_note_id,user_id` → `l3_study_notes(id,user_id)`，ON DELETE RESTRICT） |
| 6 | CREATE INDEX `idx_l3_study_note_references_user_target_note`（`user_id,target_note_id,note_id`） |
| 7 | ADD CONSTRAINT `l3_study_note_references_no_self_note_check`（`target_note_id IS NULL OR target_note_id <> note_id`） |
| 8–10 | 重建三个 CHECK（kind 增 `note`；target 增 note 分支且各分支互斥 `target_note_id`；quote 把 `note` 并入非摘录组） |

**无需 0040 那种拆分前置**：`l3_study_notes` 早在 N1 就带 `l3_study_notes_id_user_id_unique(id,user_id)`
（`src/db/schema.ts:1613`），复合 FK 的依赖已存在。

- 清理/回滚限制：`DROP COLUMN` 会连带删除 FK 与三个 CHECK 依赖 → 回滚需反向脚本（DROP 约束 → DROP COLUMN → 重建旧 CHECK）。
  本链按项目惯例只提供前进迁移，不写回滚迁移。
- 数据迁移影响：新列可空、旧行不受影响；`target_check` 重建对既有 6 种 kind 的行为不变
  （只把 `target_note_id IS NULL` 显式写入每个既有分支）。
- 锁与时延：`DROP/ADD CONSTRAINT` 与 `ADD COLUMN` 取 ACCESS EXCLUSIVE；`ADD CONSTRAINT`
  需要全表校验扫描（`l3_study_note_references` 为笔记引用行，量级远小于卡片表）。
  `CREATE INDEX` 为普通 btree（未用 CONCURRENTLY，与既有 release 迁移一致），期间阻塞写。
  若在热时段上线，建议与既有 release 同窗口执行。

---

## 4. OpenAPI / 生成物 / 授权登记

| 项 | 变化 |
|---|---|
| `docs/api/openapi.json` | `target` 与 `displaySnapshot` 两个 `oneOf` 联合各新增 `note` 变体（响应面；PUT 请求体亦含 target 联合） |
| `src/frontend/api/generated/openapi.ts` | 由 `npm run api:client:generate` 重新生成；`api:client:check` 通过 |
| `docs/api/openapi-breaking-approval.json` | **重锚三元组**：`baseSha256`=openapi@origin/main `9e1e0d90…`、`currentSha256`=openapi@HEAD `848280f4…`、`issues`=实测 8 条 response 联合新增（**0 unknown**） |
| 授权登记 | **未变**：本链不新增路由、不改权限面；`tests/http/authorization-registry.test.ts` 与 `route-authorization.test.ts` 均在全量单测中通过 |

---

## 5. 门禁实跑记录

环境：Node `v22.22.2`、npm `10.9.7`、worktree `D:/Temp/vocab-ob-n2-chain02`（独立 `npm ci --ignore-scripts`，359 包）。
数据库均为本机 Docker `vocab-local-pg`:5433 上的**隔离库**，未触碰共享/生产库。

| 门禁 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 类型检查（全量） | `npm run typecheck`（`tsc --noEmit`） | 0 | 0 error |
| 类型检查（前端） | `npx tsc --noEmit -p tsconfig.frontend.json` | 0 | 0 error |
| 架构依赖 | `npm run arch:check` | 0 | 425 modules / 1871 deps，无违规 |
| OpenAPI 契约 | `npm run api:contract` | 0 | 10 passed |
| breaking 门禁契约测试 | `npm run api:breaking:contract` | 0 | 37 passed |
| 客户端生成物一致性 | `npm run api:client:check` | 0 | 与 `docs/api/openapi.json` 一致 |
| schema drift | `npm run db:schema:drift`（对 `vocab_n2_chain02_verify`） | 0 | OK |
| 前端构建 | `npm run frontend:build` | 0 | built in 1.27s |
| 前端构建（含宿主） | `VITE_N1_STUDY_NOTE_HOST=1 npm run frontend:build` | 0 | built in 1.25s |
| 定向单测 | `npx vitest run` 4 个 study-notes 相关文件 | 0 | 166 passed |
| 全量单测（修复后首轮） | `npx vitest run --coverage.enabled=false` | 0 | 4038 passed / 6 skipped / 0 failed |
| 全量单测（收口复核） | 同上 | 1 | 4021 passed / 11 skipped / 7 failed；7 例全部来自依赖子进程的 `tests/scripts/*`，已逐例归因，见 §5.2 |
| 迁移真库验收 | 见 §6 | 0 | 结构 6/6 + 功能探针 10/10 |

### 5.1 本轮**未能**在本机完成的门禁（环境限制，非产品失败）

| 门禁 | 现象 | 归因 | 处置 |
|---|---|---|---|
| `npm run api:breaking` | `[openapi-breaking] FAILED: spawnSync git EBUSY` | 本沙箱内 node `spawnSync("git", …)` 恒 `status=null / EBUSY`（最小复现已验证；Bash 工具内 git 正常） | 用**同一门禁函数** `runOpenApiBreakingGate` + 文件版 base loader 复现判定 → `OK`；approval 已按三元组重锚（§4）。CI 环境无此限制，须以 CI 结果为准 |
| `npm run complexity:routes` | `Invalid route complexity base ref HEAD^` | 同上（git 子进程不可用） | 本链**未新增路由、未改路由复杂度**；CI 复核 |
| `npm run coverage:layered` | 依赖 git diff（spawnSync） | 同上 | 未跑；CI 复核（受治理层改动行覆盖率由 CI 判定） |
| `npm run test:collection` | `vitest list --filesOnly` 子进程返回 `status=undefined` | 同上 | 未跑；已新增测试文件均在 `tests/` 既有目录内，符合收集约定 |

### 5.2 收口复核中 7 例失败的逐例归因（**间歇性环境失败，非本链回归**）

收口轮（09:24 起）全量单测出现 7 failed / 5 files，与首轮（22:24，0 failed）不同。**不得直接宣称为环境抖动**，证据链如下：

| 步骤 | 命令 / 证据 | 结论 |
|---|---|---|
| ① 失败集合 | `Failed Tests 7`：`generate-openapi-client`(2) / `report-layered-coverage`(1) / `verify-openapi-breaking`(2) / `verify-route-complexity`(1) / `verify-test-collection`(1) | 全部是 `tests/scripts/*` 一族 |
| ② 与本链 diff 的交集 | `git diff --name-only \| grep -E "scripts/(…5 个文件…)"` → 无匹配（exit 1） | **本链未改动这些测试** |
| ③ 是否与并行负载有关 | 单独重跑这 5 个文件：`--coverage.enabled=false`，耗时 1.05s → 同样 7 failed / 76 passed | 与负载无关，排除超时型抖动 |
| ④ 是否间歇 | 同一 worktree **首轮**日志：这 5 个文件全部绿（37 + 31 + 4 + 9 + 2 = 83 passed） | 同一批测试在本机既能绿也能红 |
| ⑤ 两次运行输入是否一致 | `docs/api/openapi.json` mtime `22:12:18`、`src/frontend/api/generated/openapi.ts` `22:12:30`，均早于首轮日志起点 `22:24:38`；两次运行之间本链仅改了 `tests/repositories`（载荷断言）与 `tests/scripts/verify-existing-volume-role-upgrade`（迁移计数），二者不被上述 5 个文件引用 | 输入内容实质一致 → 差异来自环境 |
| ⑥ 直接最小复现 | `node -e` 内 `spawnSync('git', …)` → `status=null err=EBUSY`；`spawnSync(process.execPath, …)` → `status=null`；`execFileSync('git', …)` → throw `EBUSY`；同时 Bash 内 `git rev-parse --short HEAD` → `5df2fe3` 正常 | **node 子进程当前整体不可用**，bash 层正常 |
| ⑦ 断言位置 | 失败断言均发生在读取被测产物之前（如 `expect(result.status).toBe(0)`、`expect(result.stderr).toContain(...)`、`execFileSync("git", ["init", …])`） | 失败点在内容判定之前，与被测内容无关 |
| ⑧ 额外 skip 差异 | 本轮 11 skipped vs 首轮 6 skipped，差额来自 `compose-database-role-routing.test.ts`（6 tests \| 5 skipped）同样依赖子进程/外部资源 | 同源于 ⑥ |

上述 5 个脚本测试用例数合计 83：首轮 83 passed / 0 failed，收口轮 76 passed / 7 failed，**同一批口粮**。
本机重试 2 次（`scripts-retry1/2.log`）仍为 5 failed，说明当前时段子进程能力未恢复。

**诚实边界**：本机**未能**复绿这 7 例，因此不声称全量单测全绿；这些门禁以 CI 结果为准，且须由独立审查在 CI 上复核（列入 §8 U6）。
本链自身新增/改动的 21 个 study-notes 相关测试文件在收口轮全部 passed（含 `verify-existing-volume-role-upgrade`）。

---

## 6. 迁移 0042 真库验收（隔离库 `vocab_n2_chain02_verify`）

- 建库：`CREATE DATABASE vocab_n2_chain02_verify OWNER vocab_migration`（本机 Docker `vocab-local-pg`:5433）
- 应用：`DATABASE_URL=…/vocab_n2_chain02_verify npx drizzle-kit migrate --config drizzle.config.ts` → 退出码 0，全量 43 段迁移成功
- 角色说明：`vocab_migration` 的 **TCP** 口令在本容器不可用（容器仅暴露 `vocab:vocab`；容器内 socket 为 trust），
  故以本机超级用户 `vocab` 执行迁移。库为隔离且一次性，未修改任何共享角色或库。

| # | 检查 | 结果 |
|---|---|---|
| 1 | `target_note_id uuid` 列存在 | PASS |
| 2 | 复合属主 FK `…_target_note_owner_fk` → `l3_study_notes(id,user_id)`，`confdeltype = r`（RESTRICT） | PASS |
| 3 | `…_no_self_note_check`：`target_note_id IS NULL OR target_note_id <> note_id` | PASS |
| 4 | `kind_check` 含 `note`；`target_check` 含 note 分支且各分支互斥；`quote_check` 把 `note` 并入非摘录组 | PASS |
| 5 | 索引 `idx_l3_study_note_references_user_target_note` 存在 | PASS |
| 6 | 权威迁移计数 = **43** | PASS |

功能探针（每条独立事务，全部回滚）：

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| P1 | A 引用 B（本人、active） | 成功 | `INSERT 0 1` |
| P2 | 自引用 A→A | 拒绝 | `no_self_note_check` 违反 |
| P3 | `note` 型但 `target_note_id IS NULL` | 拒绝 | `target_check` 违反 |
| P4 | `source` 型却带 `target_note_id` | 拒绝 | `target_check` 违反 |
| P5 | `note` 型带 quote 字段 | 拒绝 | `quote_check` 违反 |
| P6 | 目标笔记不存在 | 拒绝 | 复合 FK 违反 |
| P7 | 目标为他人笔记 | 拒绝 | 复合 FK 违反（`target_note_id,user_id` 不在 `l3_study_notes`） |
| P8 | 成环 A→B 且 B→A | 均成功 | `INSERT 0 2` |
| P9 | 删除被引用笔记 B | 拒绝 | RESTRICT FK 违反 |
| P10 | 目标归档（status=archived） | 引用保留 | `target_status=archived`，`note_refs_after_archive=1` |

脚本：`D:/tmp/n2-chain02/verify-0042.sql`（结构）、`verify-0042b.sql`（功能探针）。

---

## 7. study-notes 全套 E2E

配置：`playwright.study-notes.config.ts`（不在 CI 默认收集内，显式 `--config` 运行）。
前置：`VITE_N1_STUDY_NOTE_HOST=1 npm run frontend:build`；4 个专属验收库均已应用迁移 0042。
服务：`PORT=3097 SERVE_FRONTEND=true NODE_ENV=test` + `OWNER_API_TOKEN` / `LOCAL_OWNER_ID` / `APP_ORIGIN`（每库重启一次，串行）。

| 库 | spec | 退出码 | 结果 |
|---|---|---|---|
| `vocab_study_notes_task07_accept` | `study-note-host.spec.ts` | 0 | **10 passed** |
| `vocab_study_notes_task08_accept` | `study-notes-ref-picker-close` / `study-notes-reference-loop` / `study-notes-task08-fix-regression` / `study-notes-workspace`（4 个） | 0 | **33 passed** |
| `vocab_study_notes_task09b_accept` | `study-notes-sheet-side-panel.spec.ts` | 0 | **6 passed** |
| `vocab_study_notes_task10_accept` | `study-note-export.spec.ts` | 0 | **5 passed** |

合计 **54 passed / 0 failed**。

> 过程记录（如实登记，不粉饰）：task10 首跑 5 例失败，错误为 `page.goto: net::ERR_CONNECTION_REFUSED`
> —— 服务进程随上一个 shell 退出被回收（非产品缺陷）；改用受管后台重启服务后 5/5 通过。
> 另：task08 首跑被 safe-delete 护栏拦下输出目录清理（`SAFE_DELETE_BULK_GUARD_ERROR`），
> 换新 `E2E_OUTPUT_DIR` 后正常。

---

## 8. 未验证项、风险与停点

| # | 项 | 状态 |
|---|---|---|
| U1 | `npm run api:breaking` / `complexity:routes` / `coverage:layered` / `test:collection` | **本机未跑**（git 子进程被沙箱拦截，见 §5.1）。breaking 已用同一门禁函数+文件版 loader 复算通过；其余以 CI 为准 |
| U2 | CI 三项必需检查（Engineering Gate / Browser E2E / Writing E2E） | **未取证据**（本轮不推 CI 之外；推分支后由 CI 产生） |
| U3 | 受治理层 diff coverage ≥85% | 未本机计算（依赖 git）；新增逻辑已由 21 条新用例覆盖，CI 判定 |
| U4 | 快照上限口径（§1.1） | 采纳「沿用 280 摘录」；若本意为「可存完整正文（≤100 000）」需复审指出 |
| U5 | 笔记互链**没有 UI 创建入口** | 与评析同款：服务端与契约齐备，前端未新增选择器（`/reference-targets` 对 note fail-closed，客户端走既有 `GET /study-notes?q=`）。如需 UI 入口另起任务 |
| U6 | 全量单测收口复核中 7 例 `tests/scripts/*` 失败 | **本机未复绿**：归因链见 §5.2（node 子进程 `EBUSY`，bash 层 git 正常；同批 83 例首轮全绿；失败断言在被测内容之前）。**不声称全量绿**，以 CI 为准 |
| R1 | 环与体积 | 允许多笔记成环；快照只解一层，故无递归展开风险；总量仍受 `STUDY_SNAPSHOT_BYTES_MAX` 兜底 |
| R2 | 未来硬删除 | 若新增笔记硬删除端点，**必须先实现引用 blocker**（合同 5），否则会撞 RESTRICT FK 而非给出可读 blocker |
| S1 | 停点 | 本链止于 draft PR；**不合并、不部署**，等待独立审查与单独合并授权 |

## 9. 变更文件清单

**源码 / 契约**
- `src/domain/l3-study-notes.ts`（`STUDY_NOTE_EXCERPT_MAX`、`REFERENCE_KINDS`、`ReferenceTarget`、`NoteReferenceSnapshot`）
- `src/repositories/l3-study-references.repository.ts`（`ReferenceTargetKind`、`LoadedNoteTarget`、行类型、`loadTargets`/`lockTargets`/`replaceForNote`/`listBacklinks`/`searchTargets`）
- `src/services/l3-study-reference.service.ts`（`noteFieldText`、`currentFieldText`、`liveTitleOf`、`targetKeyOf`/`targetRefsOf`/`referenceRowToTarget`、`captureAgainst`）
- `src/services/l3-study-notes.service.ts`（keep 携带 `target_note_id`、自引用 422、`canonicalTarget`）
- `src/services/l3-study-note-export.service.ts`（v2 target、v1 fail-closed、白名单投影、`KIND_LABELS`/摘要/渲染块）
- `src/http/l3-study-note-response-contract.ts`（target 与 snapshot 联合各增 `note` 变体）

**数据**
- `src/db/schema.ts`（`targetNoteId` 列、复合 RESTRICT FK、索引、禁自引用 CHECK、三个 CHECK 重建）
- `drizzle-release/0042_cultured_praxagora.sql`、`drizzle-release/meta/0042_snapshot.json`、`drizzle-release/meta/_journal.json`

**前端（穷尽性分支，无新功能）**
- `src/frontend/components/studyNotes/StudyReferencePicker.tsx`、`StudyNoteEditor.tsx`、`src/frontend/hooks/useStudyNoteEditor.ts`、`src/frontend/state/studyNoteSaveController.ts`、`src/frontend/utils/studyNoteReferenceOps.ts`
- `src/frontend/api/generated/openapi.ts`（重新生成）

**生成物 / 台账**
- `docs/api/openapi.json`、`docs/api/openapi-breaking-approval.json`（重锚）
- 本台账 `docs/plan/study-notes-n2-chain02-execution-2026-09-23.md`

**测试**
- `tests/services/l3-study-reference.test.ts`、`tests/services/l3-study-notes.test.ts`、`tests/services/l3-study-note-export.test.ts`、`tests/repositories/l3-study-references.test.ts`、`tests/scripts/verify-existing-volume-role-upgrade.test.ts`（权威迁移计数 42→43）


