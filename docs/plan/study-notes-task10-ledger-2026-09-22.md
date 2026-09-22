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

## 3. 门禁实测结果（本批如实记录）

> 下列结果由本批交付指令**给定**为真实门禁结果，逐条登记；**本轮未重跑**
> `verify:db` 与 Playwright（原因见 §4），故**不计入「本轮已实跑通过」**。

| # | 命令 | 退出码 | passed | failed | skipped | retried | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | `npm run verify:engineering` | **0** | 265 | — | 1 | — | ✅ 通过 |
| G2 | `npm run verify:db` | **1** | — | — | — | — | ❌ **失败**（未提供失败明细） |
| G3 | `npx playwright test`（默认套件 + study-notes 套件） | **1** | — | — | — | — | ❌ **失败**（未提供失败明细） |

`npm run verify:engineering` 的脚本构成（`package.json:98`）为
`typecheck && arch:check && test:unit && db:schema:drift && api:governance && frontend:build
&& runtime:verify && alerting:verify && release:acceptance:contract
&& secret-rotation:evidence:contract && release:workflow:verify`。

`npm run verify:db` 的脚本构成（`package.json:100`）为
`test:db-release && test:integration && test:db-roles && test:capacity`。

> **G2/G3 失败原因未定位。** 简报只给出 `exit=1` 与全 `null` 计数，未给失败用例名、
> 失败模块或 stderr 摘要。台账**不猜**根因：既不记为「环境噪声」，也不记为「产品缺陷」。
> 未覆盖项据此登记在 §5。

### 3.1 本轮实际执行的命令（仅限本台账写作所需的只读核对）

| 命令 | 结果 |
| --- | --- |
| `git -C D:/Temp/vocab-ob-t10-clone status --porcelain` | 接管时 1 行；提交后 0 行 |
| `git -C … rev-parse HEAD` | `923ff4d…`（提交后 `d9eb2ac…`） |
| `git -C … ls-remote --heads origin study-notes-n1-task10` | `48d7f60…`（接管时；推送后见 §4） |
| `git -C … show --name-only 923ff4d` | 27 行，见 §2.1 |
| `git -C … merge-base HEAD origin/main` | `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` |
| `gh pr list --head study-notes-n1-task10 --state all` | `[]`（无既有 PR） |

---

## 4. 环境限制

1. **本机 Node 默认 `v24.15.0`**，而 Task 09B 台账登记的执行运行时为
   `v22.22.2`（`D:/Temp/node22-runtime/node-v22.22.2-win-x64`，不在系统 PATH）。
   `verify:db` / Playwright 对 Node 版本与 DB 连接敏感，**版本漂移是本轮 G2/G3 未复跑的
   原因之一，但未定位为根因**。
2. **`verify:db` 需要真库环境变量。** 集成用例（`tests/l3-study-note-export.integration.test.ts:10`）
   规定 `TEST_DATABASE_URL` / `TEST_APP_DATABASE_URL` 缺失即失败、**不 skip**；
   克隆内无 `.env.local`。本机 `vocab-local-pg`（5433）可达，且已存在
   `vocab_study_notes_task10_verify` 与 `vocab_study_notes_task10_accept` 两库，
   但**本轮未据此重跑 G2**。
3. **Playwright 需要启动真实栈**（E2E 服务端口 + `SERVE_FRONTEND=true`），
   且 `e2e-study-notes/study-note-export.spec.ts:20` 要求库名为
   `vocab_study_notes_task10_accept`（`STUDY_NOTES_E2E_DB` 可覆写）。
   本轮未启动栈，未复跑 G3。
4. **`build-analysis/` 不在克隆内**（`D:/Temp/vocab-ob-t10-clone/build-analysis` 不存在）——
   与任务书文首「盘点文件位置说明」一致。

---

## 5. 未覆盖项（如实列出，不计入通过）

| # | 项 | 状态 | 原因 |
| --- | --- | --- | --- |
| U1 | `npm run verify:db` 通过 | ❌ **未通过**（exit=1） | 真实门禁失败；失败明细未提供，根因未定位 |
| U2 | Playwright（默认 + study-notes）通过 | ❌ **未通过**（exit=1） | 同上 |
| U3 | 任务书 C1–C11 逐条门禁 | ⚠️ **未逐条实跑** | 仅 `verify:engineering`（含 C1/C2/C3 面、C5/C6/C7/C8 面）有聚合通过结果；C4（`coverage:layered` + `test:collection`）、C9（真库集成）、C10（浏览器）、C11（授权登记独立跑）**未逐条实跑**，不得据聚合结果推断为已跑 |
| U4 | 覆盖率 diff ratchet（受治理文件 lines ≥85% / branches ≥75%） | ⚠️ **未核** | `verify:engineering` 的 `test:unit` 通过不等于 ratchet 达标数值已核验 |
| U5 | 变异检查 M1–M10（任务书 §4.2）留痕 | ⚠️ **未核** | 本轮未逐条实跑变异并留痕 |
| U6 | 真库只读性 B9/B10/B12（`submissions` / `l3_question_attempts` / notes·venues·topics·refs 零写） | ⚠️ **用例已写，未在真库实跑** | 依赖 U1；用例存在于 `tests/l3-study-note-export.integration.test.ts:200,216,224` |
| U7 | 主线 CI | ⚠️ **未触发** | 分支未合并，仍为以后合并门禁，**不得记为已通过** |

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

---

## 7. 停止状态

按交付指令停在 **PR 合并前**：未合并、未部署、未推 main、未使用 `reset` / `clean` / 强推。
命中 §5 的 U1–U3 门禁未过，**不宣告 Task 10 验收通过**。
