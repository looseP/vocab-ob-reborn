# Task 10 执行台账 — 导出与生命周期闭环（2026-09-22）

> 性质：**执行台账**。记录接管核对、提交序列、门禁实测结果与**未覆盖项**。
> 任务书（验收矩阵、P1–P7 决策、实现边界）：`docs/plan/study-notes-task10-execution-2026-09-22.md`。
> 范围纪律：只做 Task 10 导出。不合并、不部署、不推 main、不使用 `reset` / `clean` / 强推。
> 独立验收库：**`vocab_study_notes_task10_verify`**（`vocab-local-pg` 容器，5433）。

---

## 0. 接管核对（2026-09-22）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| 执行目录 | `D:/Temp/vocab-ob-t10-clone`（独立 clone） | 独占 |
| 分支 | `study-notes-n1-task10` | 与任务书一致 |
| 任务书基线 SHA | `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` | 与任务书 §5 一致 |
| 功能提交 | `923ff4d8e06a4912f12ac8d1cef7423d5f1e8160` `feat(notes): export portable notes with citation evidence` | 任务书 §P7 指定文案，已存在 |
| 功能提交父提交 | `3cab33f`（任务书 `docs(plan)`） | 提交链正确（功能提交紧接任务书） |
| `merge-base HEAD origin/main` | `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` | 分支仅含 Task 10 增量 |
| 远端分支（接管时） | `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` | **落后**本地一个提交（功能提交未推） |
| 工作区（接管时） | 1 行：` M tests/frontend/l3-papers.test.tsx` | 非 clean，见 §1 |
| 现有 PR（head=`study-notes-n1-task10`） | **无**（`gh pr list --head` 返回 `[]`） | 需新建 draft PR |

---

## 1. 工作区未提交变更（接管时实测，非推断）

接管时 `git status --porcelain` 输出恰一行：

```
 M tests/frontend/l3-papers.test.tsx
```

内容为**测试加固，非生成物**：`I3/C 原卷作文入口与返回恢复` 用例中，原先直接
`fireEvent.click(screen.getByRole("button", { name: /重试进入写作/ }))`；改为先
`await waitFor(() => screen.getByRole("button", …))` 再点击。原因（提交信息原文）：
重试提示是副作用先于 React 提交渲染，慢机器上会取到提交前的帧而 `getByRole` 抛错，
与本用例要验证的语义无关。

> **口径澄清（如实记录）**：简报预期未提交内容可能是「治理步骤重新生成的 `openapi.json`
> 或客户端产物」。**实测不是**——`git diff --numstat` 只有 `tests/frontend/l3-papers.test.tsx`
> 一行（`4 1`），`docs/api/openapi.json` 与 `src/frontend/api/generated/openapi.ts` **均无改动**
> （它们已在功能提交 `923ff4d` 内）。故按「未提交变更」分支处理：**按文件名暂存**并另行提交，
> 未使用 `git add -A`。

---

## 2. 提交序列

| SHA | 内容 | 文件 |
| --- | --- | --- |
| `3cab33f` | `docs(plan): Task 10 任务书 — 导出与生命周期闭环` | `docs/plan/study-notes-task10-execution-2026-09-22.md` |
| `923ff4d` | `feat(notes): export portable notes with citation evidence` | 27 文件（见 §2.1） |
| `d9eb2ac` | `test(l3): await retry button before clicking in writing-entry retry case` | `tests/frontend/l3-papers.test.tsx` |

### 2.1 功能提交 `923ff4d` 变更清单（`git show --name-only`）

```
docs/api/openapi.json
e2e-study-notes/study-note-export.spec.ts
src/frontend/api/browserRequest.ts
src/frontend/api/generated/openapi.ts
src/frontend/api/studyNotesClient.ts
src/frontend/components/studyNotes/StudyNoteEditor.tsx
src/frontend/components/studyNotes/StudyNoteExportButton.tsx
src/frontend/components/studyNotes/StudyNoteSidePanel.tsx
src/frontend/hooks/useStudyNoteEditor.ts
src/frontend/state/sheetLeaveBarrier.ts
src/frontend/state/studyNoteExportFlusher.ts
src/http/operations.ts
src/http/routes/l3/study-notes-export.ts
src/http/server.ts
src/repositories/l3-study-notes.repository.ts
src/schemas/http/index.ts
src/services/index.ts
src/services/l3-study-note-export.service.ts
tests/frontend/browser-request.test.ts
tests/frontend/study-note-export-flusher.test.ts
tests/frontend/study-note-export.test.tsx
tests/frontend/study-notes-client.test.ts
tests/http/authorization-registry.test.ts
tests/http/study-note-export.test.ts
tests/l3-study-note-export.integration.test.ts
tests/repositories/l3-study-notes.test.ts
tests/services/l3-study-note-export.test.ts
```

共 27 文件、`+4552 / -32`。

---

## 3. 门禁实测结果（第二轮，全部为本轮实跑）

> **本节已于收口轮重写。**第一版 §3 登记的是交付指令**给定**的数字（G1 计 265/1），
> 未实跑 G2/G3 且未定位失败原因；该口径已作废。下列每一行都来自本机**实跑日志**，
> 环境为隔离库，执行运行时 `D:/Temp/node22-runtime/node-v22.22.2-win-x64`（node v22.22.2 / npm 10.9.7）。
> 计数取自各命令 stdout 的 vitest / Playwright 汇总行。

| # | 命令 | 退出码 | passed | failed | skipped | retried | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | `npm run verify:engineering` | **0** | 3973 | 0 | 6 | — | ✅ 通过（聚合入口） |
| G2 | `npm run verify:db` | **1** | 161 | 1 | 0 | — | ❌ 失败（既有环境问题，见 §3.2） |
| G3a | `npx playwright test`（默认套件） | **1** | 1 | 13 | 7 | 0 | ❌ 失败（既有环境问题，见 §3.2） |
| G3b | `npx playwright test --config playwright.study-notes.config.ts`（全 7 spec） | **0** | 54 | 0 | 0 | 0 | ✅ 通过 |

G1 明细（`test:unit` 段，**收口轮新增 C12 用例后的实测值**）：Test Files 266 passed / 1 skipped（共 267）；
Tests 3973 passed / 6 skipped（共 3979）。分层覆盖率与本批 diff 覆盖率：

```
Baseline ratchet gate: PASS
Final target status:   PASS
Diff coverage (>=85%): 92.7% (PASS)
Diff coverage scope: base ref 48d7f6…；changed src files 16（governed 6 / outside 10）；
                     changed executable lines 356（covered 330）；uncommitted src files 0
| domain | 98.18% | service | 95.11% | repository | 93.84% | http | 91.71% |  ← 四层 baseline 全 PASS
```

G3b 明细（全 7 spec，`ok` 计数）：导出 5 / host 10 / 引用选择器关闭 3 / 引用回路 9 /
卷面侧栏 6 / Task08 回归 3 / 工作区 18 ＝ **54**，failed 0，skipped 0。

### 3.1 双重口径（聚合入口非 0 ↔ 主线 CI 全绿）

G2/G3a 在本机非 0，但**同一 commit 的主线 CI 三项必需检查全部通过**：

| CI 检查 | 结论 | 运行 |
| --- | --- | --- |
| Engineering Gate + Migration Rehearsal | pass（6m52s） | run `35721275373` |
| Browser E2E (Playwright) | pass（1m50s） | run `35721275373` |
| Writing E2E（真环境闭环 + 故障矩阵） | pass（2m12s） | run `35721275291` |

两个口径**并存且都如实登记**，不得任取其一：
- CI 通过说明：在 CI 的规范供给环境（迁移镜像建库 + 角色引导）里，聚合门禁与浏览器 E2E 是绿的；
- 本机非 0 说明：本机手建隔离库不满足 G2/G3a 的**前置供给**，与产品代码无关（§3.2 已用基线对照证明）。
- 因此本台账**既不**把 CI 全绿当作「本机聚合门禁已通过」，**也不**把本机非 0 当作 Task 10 回归。

### 3.2 G2 / G3a 失败根因（基线对照实验，已定位）

**结论：两项均为既有环境问题，不是 Task 10 引入的回归。** 证明方式为基线对照——
把未改动的基线提交 `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` 单独检出为 worktree 并配独立库重跑。

| 项 | 症状 | 基线对照结果 | 本批是否触碰 |
| --- | --- | --- | --- |
| G2 | `tests/db/transaction-rls.integration.test.ts:138` → PG `23503`（`daily_forecast_snapshots_user_id_fkey`），161/162 通过 | **在 `48d7f60` 上逐字重现同一失败** | `git diff --stat origin/main..HEAD -- tests/db/ scripts/` **为空** |
| G3a | 13/14 用例在 `e2e/fixtures.ts:20` 抛 `Browser session login failed: 500` | **在 `48d7f60` 上同样 13 例同样报错** | `git diff --stat origin/main..HEAD -- e2e/` **为空**；本批只在 `e2e-study-notes/` **新增** 1 个 spec |

根因属**建库供给**而非代码：G2 的 `transaction-rls.integration.test.ts:17` 要求其**专属**已播种
RLS 验收库（`RLS_ACCEPTANCE_DATABASE_URL`），本机手建库不满足；G3a 的默认套件需
`e2e/global-setup.ts:10,16` 播种 `users`/`profiles` 后登录才返回 201。
另注：`test:db-roles` 断言的是**精确**权限矩阵，用 `GRANT … ON ALL TABLES` 宽授权会被正确拒绝，
须走仓内 `scripts/bootstrap-database-roles.ts`（prepare + converge）与 `db-roles:acceptance` 受控供给。

> 组织上仍以本机聚合入口为交付判据，故 G2/G3a **不计为通过**，如实留在 §5 未覆盖/未通过项；
> 但按上述对照实验，也**不记为 Task 10 缺陷**。

### 3.3 收口轮实跑的命令（本台账全部数字的来源）

| 命令 | 结果 |
| --- | --- |
| `npm run verify:engineering`（三基线 ref 均设为 `48d7f60…`） | exit **0**；3973 passed / 6 skipped；diff coverage 92.7% PASS |
| `npm run verify:db`（隔离库，admin 连接播种） | exit **1**；161 passed / 1 failed（`transaction-rls`） |
| `npx playwright test`（默认套件） | exit **1**；1 passed / 13 failed（登录 500）/ 7 skipped |
| `npx playwright test --config playwright.study-notes.config.ts`（全 7 spec） | exit **0**；**54 passed** / 0 failed / 0 skipped |
| `tests/http/study-note-export-version-chain.test.ts` | exit **0**；5 passed |
| 同上，**变异**（短路 `note.version !== expectedVersion`） | exit **1**；**2 failed** / 3 passed |
| 同上，**还原后** | exit **0**；5 passed；`git diff --stat` 空（逐字还原） |
| `git -C … rev-parse HEAD` / `ls-remote` | 本地＝远端＝PR head（见 §7） |
| `git -C … fsck` | exit 0（仅 2 个 dangling commit，无损坏） |
| `gh pr checks 132` | 三项必需检查全 pass |

---

## 4. 环境限制（收口轮更新）

1. **执行运行时须显式指定。** 本机默认 Node 为 `v24.15.0` / npm 11.12.1，不符合仓内
   `engines`（`>=22.22.0 <23` / npm `>=10.9.0 <11`）。全部实跑使用
   `D:/Temp/node22-runtime/node-v22.22.2-win-x64`（node v22.22.2 / npm 10.9.7）。
2. **Windows 上 `npm` 不能直接 spawn。** npm 是 `.cmd` 垫片，直接调用报
   `spawn … npm ENOENT`；须经 `cmd /c cd /d <clone> && <...>/npm.cmd …`。
   `world.run` 以工作区根为 cwd，不 `cd /d` 会把 npm 解析到无 `package.json` 的目录（ENOENT -4058）。
3. **门禁输出超harness单流上限。** `verify:engineering` 实测 stdout 87KB、**stderr 392KB**，
   超过 256KB 上限，故实跑一律 `> log 2>&1` 后读取有界摘要。
4. **`verify:db` 需要发布级供给的库**，不是「建库 + 手写授权」：`test:db-roles` 断言**精确**权限矩阵，
   宽授权（`GRANT … ON ALL TABLES`）会被正确拒绝；须走 `scripts/bootstrap-database-roles.ts`
   （prepare + converge）或 `db-roles:acceptance` 受控 Compose 供给。
5. **本机有两个 postgres 实例**：`vocab-local-pg`（127.0.0.1:**5433**，本批隔离库所在）与
   `vocab-observatory-postgres-1`（127.0.0.1:**5432**，另一实例、角色口令不同）。
   首次误连 5432 曾得到 PG `28P01`；隔离库一律固定在 5433。
6. **`build-analysis/` 不在克隆内**——与任务书文首「盘点文件位置说明」一致。

---

## 5. 未覆盖 / 未通过项（如实列出，不计入通过）

| # | 项 | 状态 | 原因 |
| --- | --- | --- | --- |
| U1 | `npm run verify:db` 聚合通过 | ❌ **未通过**（exit=1，161/162） | `tests/db/transaction-rls.integration.test.ts` 需其**专属已播种 RLS 验收库**；本机手建库不满足。**基线对照已证明在 `48d7f60` 上逐字重现**；本批未触碰 `tests/db/`（diff 为空）。见 §3.2 |
| U2 | 默认 Playwright 套件通过 | ❌ **未通过**（exit=1，1/14） | 13 例在登录处 500；需 `e2e/global-setup.ts` 播种后登录。**基线对照同样重现**；本批未触碰 `e2e/`（diff 为空）。见 §3.2 |
| U3 | 任务书 C4（`coverage:layered` + `test:collection`）/ C6（`api:governance`） | ✅ **已随 G1 实跑**（原记「未逐条实跑」有误，已更正） | 二者均在 `verify:engineering` 的 `test:unit` / `api:governance` 段内，G1 exit=0 即已实跑；C4 的数值见 §3 的 ratchet 与 diff coverage 输出 |
| U4 | 覆盖率 diff ratchet 具体数值 | ✅ **已核**（原记「未核」） | `92.7% (PASS)`，四层 baseline 全 PASS，changed executable lines 356（covered 330），见 §3 |
| U5 | 变异检查留痕 | ⚠️ **部分** | 本批留痕 **M2（版本校验）** 与 **stale-download 守卫** 两组红→绿→还原；任务书 §4.2 的 M1/M3–M10 未逐条实跑 |
| U6 | 真库只读性 B9/B10/B12 | ✅ **已实跑** | `tests/l3-study-note-export.integration.test.ts` 6/6 通过（含 submissions / attempts 行数不变）；另有一次性驱动脚本对 11 张表前后计行一致 |
| U7 | 主线 CI | ✅ **已完成**（原记「未触发」） | PR #132 三项必需检查全 pass（run `35721275373` / `35721275291`）；分支仍未合并，**不得据此记为已合并** |
| U8 | HTTP 层版本冲突**真实链路** | ✅ **已补齐并证明有牙齿**（收口轮 C1） | 新增 `tests/http/study-note-export-version-chain.test.ts`；短路版本校验后 2 failed（exit=1），还原后 5 passed。**原 mock 注入版无效**：变异下仍通过，已在 §3.3 与 PR 中说明 |

> 更正说明：上一版 U3/U4/U6/U7 记为「未实跑/未核/未触发」，是**第一轮未复跑**时的保守登记，
> 与收口轮实跑结果不符，现按实测更正。U1/U2 仍**不通过**，但已用基线对照定位为既有环境问题。

---

## 6. 实读证据（源码，供评审直接核对）

以下为本台账写作时**实读**的行号，用于支撑 PR body 的契约/锁/hash/引用/flush 五组证据。

| 证据面 | 位置 |
| --- | --- |
| 端点与四件响应头 | `src/http/routes/l3/study-notes-export.ts:29-42` |
| 路由注册顺序（固定段先于 `/:noteId`） | `src/http/server.ts`；说明见 `study-notes-export.ts:9-13` |
| `lockForShare`（FOR SHARE） | `src/repositories/l3-study-notes.repository.ts:186-194` |
| 保存路径 `lock`（FOR UPDATE，**未改**） | `src/repositories/l3-study-notes.repository.ts:175-183` |
| 导出事务调 `lockForShare`（非 `lock`） | `src/services/l3-study-note-export.service.ts:506` |
| 双段渲染 / hash 可复算 | `src/services/l3-study-note-export.service.ts:468-475`、`:433` |
| 末尾 JSON 块 + 自适应围栏 | `src/services/l3-study-note-export.service.ts:461-464`、`fenceFor` `:243-247` |
| 无标准答案字段（白名单投影） | `src/services/l3-study-note-export.service.ts:143-151`、`projectDisplaySnapshot` `:164-211` |
| 安全文件名 | `src/services/l3-study-note-export.service.ts:586` |
| flush → GET 顺序 | `src/frontend/state/studyNoteExportFlusher.ts:146-188`（`await deps.flush()` `:156` → `exportNote(…, receipt.version)` `:169`） |
| 版本比较真实链路证据（收口轮 C1） | `tests/http/study-note-export-version-chain.test.ts`（真实 `L3StudyNoteExportService` 接 app，只替换底层仓储；短路 `src/services/l3-study-note-export.service.ts:517` 后 2 failed） |

---

## 7. 停止状态

按交付指令停在 **PR 合并前**：未合并、未部署、未推 main、未使用 `reset` / `clean` / 强推。

- 分支 `study-notes-n1-task10`；本机聚合入口 G2/G3a 未过（**既有环境问题，已基线对照定位**，见 §3.2），
  G1 与 study-notes 全 E2E 套件（54/54）通过；主线 CI 三项必需检查全 pass（§3.1 双重口径）。
- 收口轮已补齐 C1（真实链路版本冲突测试＋变异证明有牙齿）、C3（全 7 spec 复跑）、
  C2（§3/§4/§5 按实跑日志重写、C4/C6 矛盾更正）。
- **不宣告 Task 10 验收通过**；待正式审查后再决定合并。
