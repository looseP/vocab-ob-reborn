# Task 10 任务书 —— 导出与生命周期闭环（2026-09-22）

> **【实现轮回填 — 2026-09-22】执行台账见 `docs/plan/study-notes-task10-ledger-2026-09-22.md`**：
> 提交序列、门禁实测（`verify:engineering` exit 0 / `verify:db` exit 1 / Playwright exit 1）、
> 独立验收库 `vocab_study_notes_task10_verify`、未覆盖项 U1–U7。**本任务书 §3 矩阵中标记
> 「待实现轮实跑」的行，终态以台账为准；门禁未过，本任务不宣告验收通过。**
> 回填口径（如实）：§3.3 的 C1–C11 **未逐条实跑**，仅有 `verify:engineering` 的聚合通过
> 结果；不得据聚合结果推断 C4/C9/C10/C11 已跑。
>
> **本文件性质：任务书（开工前定稿）**。只做决策与验收定义，**不含实现代码**。
> **本轮提交纪律**：本文件是 Task 10 分支的**第一个提交**且**只含本文件**（`docs(plan)`），
> 不含任何功能代码、schema/HTTP 合同变更、客户端 stub 或 openapi 生成物改动。
> **基线**：分支 `study-notes-n1-task10`，HEAD `48d7f60180cfee94f905a5f20c88cc62f9ceb83d`（`Merge pull request #131 from looseP/study-notes-n1-task09b`）。
> **不 push、不改 main**（本文件只落在 Task 10 分支）。

**素材来源（开工前实读）**

| 来源 | 用途 |
| --- | --- |
| `build-analysis/status-2026-09-21/TASK10-READONLY-PLAN.md`（只读盘点；其 §5 = 本任务书要拍板的 P1–P7；§0/§1/§2/§3 提供接口与先例事实） | 决策输入 |
| `docs/plan/study-notes-execution-plan-2026-09-18.md` §Task 10（`:303-313`）：Files / Interfaces / 五条验收条目 / commit 文案 | 合同真源 |
| `docs/plan/study-notes-frontend-tasks-2026-09-20.md` §0.1（`:35`）：未实现端点与「不得预留成功假象接口」 | 前端纪律 |
| `docs/adr/study-notes-workspace.md` §2/§3/§5/§6 与 Consequences（`:26-28`、`:34`、`:44`、`:63`） | 引用快照、锁序、owner-only、导出以已存快照输出 |
| `src/services/l3-sheet-export.service.ts`（643 行，先例 v2）与 `src/services/l3-writing-export.service.ts`（263 行，先例 v1） | 渲染/双段 hash/fence/响应头先例 |

> **盘点文件位置说明（如实记录）**：`build-analysis/` 在仓库中**未被跟踪**（`git ls-files build-analysis` 输出 `0` 行，`git check-ignore build-analysis` 退出码 1——既未跟踪也未被忽略），且**不存在于 Task 10 克隆内**（`D:/Temp/vocab-ob-t10-clone/build-analysis/` 不存在）。本任务书从工作区 `D:/Temp/Myawesomeapp/vocab-ob'/build-analysis/status-2026-09-21/TASK10-READONLY-PLAN.md` 实读其全文（132 行），并**不**把该目录带入本提交。

---

## 1. P1–P7 最终决策（每条一句理由）

| 编号 | 决策 | 理由（一句） |
| --- | --- | --- |
| **P1** 引用块与来源清单版式 | **按 `kind` 分五型渲染引用块，仅对顶层 paragraph 且 text 完全等于 `[[ref:<uuid>]]` 的位置替换**；每块含 `kind` 标签、来源标题（`displaySnapshot.title` / `sourceTitle`）、已存快照摘要、`capturedAt`（标「引用时间」）、`status`（`current`/`changed`/`unavailable`）；**`unavailable` 保留占位块**（写明「目标已不可用，以下为引用时摘录」）而非删除或改写；文末追加「来源清单」按 `capturedAt` 升序、`referenceId` 去重。 | 与 domain 单一真源 `matchReferenceMarkerText`/`parseReferenceIds`（`src/domain/l3-study-notes.ts:276,290`）同语义，且 `unavailable` 必须与编辑器占位卡行为一致（ADR `:28`、`:40`：保留原摘录、不以旧 offset 套新文本）。 |
| **P2** 末尾 JSON 块 schema 与「无标准答案字段」边界 | **JSON 块字段冻结为 `exportSchemaVersion`(1) / `kind`(`"study-note"`) / `exportedAt` / `note`{`id,title,status,pinned,version,venues`} / `references[]`{`referenceId,kind,status,capturedAt,displaySnapshot,target{sourceId\|questionId,optionKey,startOffset,endOffset},liveTitle`} / `bodyMd` / `bodySha256`**；`displaySnapshot` **原样序列化**（其类型 `QuestionReferenceSnapshot` 字段为 `{stem,options,questionType,sourceTitle}`，`options` 为 `L3QuestionOption[]`）；**导出器不得自造新字段**，尤其不得输出 `answer`/`answerIndex`/`explanation`/`evidence`/`correctOption` 等标准答案面字段。 | 快照生成侧已「服务端白名单组装（不含标准答案/explanation/evidence）」（`src/domain/l3-study-notes.ts:116` 注释），导出只需**独立断言**这一既有边界、不得回填（盘点 §5 P2 明示「编辑器预览已排除；导出需独立断言」）。 |
| **P3** `expectedVersion` 缺失/旧版的状态码 | **缺失/非数字 → 422（`ValidationError.httpStatus`，字段 `expectedVersion`）；与当前 `note.version` 不一致 → 409（带 `meta.currentVersion`，不回传服务器正文）**；`expectedVersion` 携带即核，不因 note 状态（含归档）豁免。**收口轮更正：原写 400，实现为 422（`src/errors/index.ts:52`），与题纸先例同口径。** | 先例 `l3-sheet-export.service.ts:585-596` 即「缺失拒/旧版 409」，且笔记侧 409 语义已冻结为「只返回 currentVersion，不自动返回内容」（frontend-tasks §0.2 `:40`）。 |
| **P4** 导出按钮生效范围 | **仅在页面版编辑器 `StudyNoteEditor.tsx` 工具栏（`insert-reference-button` 同行）新增 `export-note-button`；09B 卷面/阅读侧栏编辑器本任务不新增出口**。 | 侧栏的职责是「不触发题纸 flush/seal/openSheet」（execution-plan `:298`）；导出若在侧栏出现就必须在同处 await flush，会把副作用面引入侧栏，收益不抵风险，故收窄并在验收中显式断言。 |
| **P5** 归档 note 可导出 | **允许导出，且 200**：归档只影响列表可见性与编辑入口，不影响只读导出；导出页眉/JSON 显式标注 `note.status = "archived"`（不静默把归档伪装成活动笔记）。 | ADR `:20` 明确「笔记/专题只有归档恢复、无硬删入口」，无删除态可拒；execution-plan 验收①本身要求测试归档导出，故按允许落地并用测试固化。 |
| **P6** FOR SHARE 锁 | **新增独立方法 `lockForShare(userId, noteId)`（`... FOR SHARE`），导出事务调用它；保存路径现有 `FOR UPDATE` 锁 `lock()`（`src/repositories/l3-study-notes.repository.ts:166-171`）一律不改、不改名、不加参数。** | 导出是只读事务，锁语义应与读面匹配（规格原文「service 在同一 actor 事务锁 note FOR SHARE」，execution-plan `:310`）；**改保存路径的锁是并发保存正确性的回归面，本任务不碰**——新增方法把风险面收敛为零。 |
| **P7** JSON 块与 fence 自适应 | **移植先例 `fenceFor`（`l3-writing-export.service.ts:68-72`：`Math.max(3, 最长反引号串 + 1)`），正文/引用摘录/JSON 块三者各自独立计算围栏长度并包裹**；JSON 围栏为 `` `${fence}json` ``。 | 该实现已被作文导出的单测覆盖且满足规格「fence 长度大于内容中最长反引号串」（execution-plan `:311`），自研等价逻辑只是多一份待验证代码。 |

**连带冻结（由 P1–P7 推出，实现期不得自行发挥）**

| 项 | 决策 | 依据 |
| --- | --- | --- |
| 路径 / 方法 | `GET /api/l3/study-notes/:noteId/export` | 盘点 §1；frontend-tasks §0.1 `:35` |
| 响应头 | `Content-Type: text/markdown; charset=utf-8`、`Content-Disposition: attachment; filename="study-note-<uuid>.md"`、`X-Export-Schema-Version: 1`、`X-Export-Sha256: <hash>` | execution-plan `:311`；路由先例 `src/http/routes/l3/sheets-export.ts`（四件头） |
| `artifactType` / schemaVersion | `study-note` / `1`（区别于题纸 v2、作文 v1） | execution-plan `:307` |
| hash 口径 | 对**不含「内容校验」行**的全文 UTF-8 计 sha256；响应头 `X-Export-Sha256` 与正文内「内容校验」行**同值** | execution-plan `:311`；先例双段渲染 `l3-sheet-export.service.ts:505-510` |
| 权限 | owner-only（未认证 401 / agent 403 / 他人资源 404 / 不存在 404） | ADR §5 `:44`；`tests/http/authorization-registry.test.ts` 登记口径 `:289,:303` |
| 服务接口 | `services.studyNoteExport.export(userId, noteId, {expectedVersion}) → Promise<{markdown, sha256, version}>` | execution-plan `:307`（本任务书在接口上仅新增参数与 `filename`/`schemaVersion` 返回字段，语义不减） |
| 只读纪律 | 导出事务**零业务写入**：不写 notes/venues/topics/refs、不创建 submission/attempt、不调用 `openSheet` | ADR §3 `:34`；execution-plan 需求表「可携带导出」（`:357`） |

---

## 2. P0–P7 阶段计划（镜像任务简报）

> 每阶段给出：目的 / 触碰面 / 门（进入下一阶段必须先过）。**门必须实跑并留输出**，不得以「目标测试通过」替代工程门禁。

### P0 接管（环境与基线复位）
- **目的**：确认起点干净、依赖可用、Task 10 分支即唯一工作面。
- **动作**：核对 `git rev-parse HEAD` == `48d7f60180cfee94f905a5f20c88cc62f9ceb83d`、分支 `study-notes-n1-task10`、工作区 clean；`npm ci`（或复用既有 `node_modules`）；跑一次基线 `npm run typecheck` 记录 Task 10 开工前的通过/失败事实。
- **门（G0）**：基线 typecheck 结果**如实记录**（若本来红，先登记为既有事实，不得谎报为本任务引入）；工作区 clean；不 push、不触碰 main。
- **证据**：命令原文 + 输出摘要（含 commit SHA）。

### P1 后端合同（service + 渲染纯函数）
- **目的**：先在测试里钉死行为，再实现 `L3StudyNoteExportService`。
- **触碰面**：新建 `src/services/l3-study-note-export.service.ts`、`tests/services/l3-study-note-export.test.ts`；新增 `lockForShare`（`src/repositories/l3-study-notes.repository.ts` 的接口 + 实现，**只增不改** `lock`）。
- **必须钉死的语义**：`withActor` 只读事务 → `lockForShare` → `get` + `listVenues` + `listForNote(userId, noteId)` → `referenceService.resolve(...)` 组装 `ReferencePreview[]` → `expectedVersion` 核对（P3）→ 渲染（P1/P2/P7）→ 双段 hash → 返回 `{markdown, sha256, version}`。引用输出**一律用已存 `displaySnapshot`/`capturedAt`/`quoteSnapshot`**，**不**用当前改判或新正文替换历史摘录（ADR `:28`、Consequences `:63`）。
- **门（G1）**：`npx --no-install vitest run tests/services/l3-study-note-export.test.ts` 全绿；纯函数渲染用例（双段 hash、fence、五型引用块、归档、缺目标）均有对应用例名。

### P2 HTTP 与治理（端点、OpenAPI、client、授权登记）
- **目的**：把 service 挂上冻结合同。
- **触碰面**：`src/schemas/http/index.ts`（`parseStudyNoteExportExpectedVersion`，对齐 `parseSheetExportExpectedVersion`）；路由 `src/http/routes/l3/study-notes.ts` 或新 `study-notes-export.ts`（**固定路径段必须注册在 `/:noteId` 之前**，与既有 reference-targets/backlinks 同纪律，见 `src/http/operations.ts:583-591`）；`src/http/operations.ts`（`exportL3StudyNote`，`owner/owner/none`，`200 z.string()` + `text/markdown`，对齐 `exportL3Sheet` 行）；`src/http/server.ts` 注册；`tests/http/authorization-registry.test.ts` 增 `exportL3StudyNote`；`npm run api:openapi` → `npm run api:client:generate` → `npm run api:client:check`；客户端 `fetchStudyNoteExport`（`parseJson:false`，**本阶段才允许存在**，不得先留 stub）。
- **门（G2）**：`npm run api:governance` 通过（含 openapi/client check/合同/breaking/complexity）；端点级测试覆盖 200 四件响应头、422（缺 `expectedVersion`）、409（旧版本）、404（非本人/不存在）、403（agent）、401（未认证）。

### P3 前端下载（flush 屏障）
- **目的**：UI 侧「先 await flush 再 GET」，失败绝不下载旧文。
- **触碰面**：`StudyNoteEditor.tsx` 工具栏新增 `export-note-button`；沿用既有 action lock 模式与 `downloadMarkdown` 式下载；测试 `tests/frontend/study-note-export.test.tsx`（或并入既有 editor 测试文件，但用例名可检索）。
- **必须钉死的语义**：`await controller.flush()` 成功 → 取 `receipt.version` 作为 `expectedVersion` → `fetchStudyNoteExport` → Blob → `a[download]`，文件名 `study-note-<uuid>.md`；**persist reject 时 export 未被调用**（spy 断言 0 次）且不产生下载；失败 toast、不下载任何旧文。（先例：`src/frontend/components/l3/L3ExamPaper.tsx:1727-1751`）
- **门（G3）**：前端导出用例全绿，且「persist reject → `fetchStudyNoteExport` 调用次数为 0」有独立用例。

### P4 验收（矩阵全条落地）
- **目的**：把 §3 验收矩阵逐行变成可执行、可复现的证明。
- **门（G4）**：矩阵中每行的「证明」列对应命令在**本环境实跑通过**；任何未跑项在该行标注「未跑」及原因，不得记通过。

### P5 门禁（工程门禁，非目标测试）
- **目的**：按执行计划 `:325-339` 的全量序列实跑。
- **命令（逐条）**：`npm run typecheck`、`npm run arch:check`、`npx --no-install vitest run --coverage --maxWorkers=1`、`npm run coverage:layered`、`npm run test:collection`、`npm run db:schema:drift`、`npm run api:governance`、`npm run frontend:build`、`npm run runtime:verify`、`npm run alerting:verify`、`npm run release:acceptance:contract`、`npm run secret-rotation:evidence:contract`、`npm run release:workflow:verify`；真库串行 `npx --no-install vitest run --config vitest.integration.config.ts tests/l3-study-notes.integration.test.ts --maxWorkers=1`（缺 DB 配置必须失败，不 skip）。
- **门（G5）**：逐条记录通过/失败/blocked 原文；资源不足导致未执行的门禁**必须列为 blocked**（execution-plan `:343` 明令不降阈值）；覆盖率达到新增受治理文件 lines ≥85%、branches ≥75% 的 diff ratchet。

### P6 收口（自审与文档）
- **目的**：自审无空壳入口、无「未知 200 归一为空」、无只在当前页面可看的引用；清单/台账更新（`docs/plan/README.md` 索引按 Task 11 口径，本任务至少登记本文件）。
- **门（G6）**：自审清单逐条打勾并给出文件:行证据；`api:client:check` 无未登记端点。

### P7 交付（唯一功能提交）
- **目的**：以执行计划指定文案提交功能代码。
- **本任务书自身的提交（已先行）**：`docs(plan): Task 10 任务书 — 导出与生命周期闭环`（**只含本文件**）。
- **功能提交文案**：`feat(notes): export portable notes with citation evidence`（execution-plan `:313` 指定原文）。
- **门（G7）**：功能提交**不含**本任务书之外的计划文档改写；不 push；最终证据台账给出 commit SHA 与门禁输出。

---

## 3. 验收矩阵（一行一验收项，证明=测试文件或命令）

> 「证明」列是**可执行的判定**。`新增` = 本任务随功能提交新建的文件；`既有` = 已存在、需扩展用例。凡标记 **未跑** 的行，实现轮必须在该行回填实跑命令与输出。

### 3.1 规格验收条目（execution-plan §Task 10 五条）

| # | 验收项 | 证明（测试文件 / 命令） | 判定 |
| --- | --- | --- | --- |
| A1 | 导出 body 含反引号的笔记：fence 自适应，内容不被提前闭合 | `tests/services/l3-study-note-export.test.ts` → `renders fences longer than the longest backtick run` | 待实现轮实跑 |
| A2 | 导出 body 含**恶意 HTML**（`<script>`/`<img onerror>`/`</div>`）的笔记：原样保留在围栏内，不产生可执行 HTML 注入面 | 同上 → `preserves raw html inside fenced blocks without escaping surface` | 待实现轮实跑 |
| A3 | 导出含**中文引用**（中文 source 标题/摘录/题干）的笔记：引用块与来源清单中文正确、无乱码 | 同上 → `renders chinese citation titles and quotes` | 待实现轮实跑 |
| A4 | **归档 note** 可导出（P5 决策） | 同上 → `exports archived notes with status marked` | 待实现轮实跑 |
| A5 | **changed 引用**：输出已存旧摘录 + `status=changed` + 新标题对照，**不**用新正文替换历史摘录、不猜新位置 | 同上 → `renders changed references from stored snapshot and marks captured time` | 待实现轮实跑 |
| A6 | 末尾 JSON 块**可解析**（`JSON.parse` 成功）且 schema 冻结字段齐备（P2） | `tests/services/l3-study-note-export.test.ts` → `emits a parseable json block with frozen fields`；`tests/http/study-note-export.test.ts`(新增) → `response body json block parses` | 待实现轮实跑 |
| A7 | JSON 块与正文的 `referenceId` **集合与顺序一致**（同一真源，不重复） | `tests/services/l3-study-note-export.test.ts` → `reference ids in body match reference ids in json block` | 待实现轮实跑 |
| A8 | **无标准答案字段混入**（P2 边界）：产物与 JSON 块均不含 `answer`/`answerIndex`/`explanation`/`evidence`/`correctOption` 等键 | `tests/services/l3-study-note-export.test.ts` → `never emits answer or evidence fields in markdown or json`（对全文做键名扫描 + 对 `question` 型 snapshot 的 `options` 逐项断言无答案键） | 待实现轮实跑 |
| A9 | service 在**同一 actor 事务**内锁 note **FOR SHARE**，读 notes/venues/refs，正文与引用版本一致 | `tests/services/l3-study-note-export.test.ts` → `locks the note with for share inside the actor transaction`（spy `lockForShare` 被调用且 `lock`(FOR UPDATE) 未被调用）＋ 真库 `tests/l3-study-notes.integration.test.ts` 并发用例 | 待实现轮实跑 |
| A10 | 用**已存 snapshot** 输出出处、标**引用时间**（`capturedAt`），不用当前改判/新正文替换历史摘录 | 同 A5 用例 + `renders captured time for every reference block` | 待实现轮实跑 |
| A11 | 输出 Markdown 正文（marker 替换为可读引用块与来源）+ 末尾 JSON 块 | `tests/services/l3-study-note-export.test.ts` → `replaces top-level markers with readable blocks and appends json` | 待实现轮实跑 |
| A12 | **marker 只在顶层 paragraph 完全等于标记时替换**（散落/内联不替换），与编辑器同语义 | 同上 → `does not replace inline or non-paragraph markers`（含代码块内 marker 不替换） | 待实现轮实跑 |
| A13 | **固定安全文件名** `study-note-<uuid>.md` | `tests/http/study-note-export.test.ts`(新增) → `sets content-disposition with study-note uuid filename` | 待实现轮实跑 |
| A14 | hash 基于**不含「内容校验」行**的全文 UTF-8；**response header 同值** | `tests/services/l3-study-note-export.test.ts` → `sha256 recomputes after deleting the checksum line`；`tests/http/study-note-export.test.ts` → `X-Export-Sha256 equals the in-body checksum` | 待实现轮实跑 |
| A15 | UI 导出**先 `await controller.flush()` 再 GET** | `tests/frontend/study-note-export.test.tsx`(新增) → `awaits flush before issuing the export GET`（调用顺序断言） | 待实现轮实跑 |
| A16 | **保存失败不能下载旧文**：persist reject → export **未调用**、无下载、有错误提示 | 同上 → `does not call export when persist rejects`（spy 调用数 0 + 无 anchor 点击） | 待实现轮实跑 |
| A17 | 只在保存成功后取**正确 version**（`receipt.version` 作为 `expectedVersion`） | 同上 → `passes the flushed receipt version as expectedVersion` | 待实现轮实跑 |
| A18 | 更新 OpenAPI 并跑 client check 与导出目标测试 | `npm run api:governance` | 待实现轮实跑 |

### 3.2 简报点名的额外验收项

| # | 验收项 | 证明（测试文件 / 命令） | 判定 |
| --- | --- | --- | --- |
| B1 | **普通笔记**（无引用、无异常字符）导出成功且结构完整 | `tests/services/l3-study-note-export.test.ts` → `exports a plain note without references` | 待实现轮实跑 |
| B2 | **dirty note**：有未确认本地输入时导出先 flush，导出内容含**已确认**的最新正文 | `tests/frontend/study-note-export.test.tsx` → `flushes dirty edits before exporting` | 待实现轮实跑 |
| B3 | **保存失败**路径（网络/拒绝）：不发起导出、不下载、错误可见 | 同 A16 用例（同一用例同时覆盖「保存失败」与「不下载旧文」两个断言） | 待实现轮实跑 |
| B4 | **409**（版本冲突）：`expectedVersion` 不一致 → 409 且不下载；后端 409 不含服务器正文 | `tests/http/study-note-export.test.ts`(新增) → `rejects stale expectedVersion with 409 and currentVersion only`；前端 `tests/frontend/study-note-export.test.tsx` → `surfaces 409 without downloading` | 待实现轮实跑 |
| B5 | **unavailable 引用**：目标不可用 → 占位块保留原摘录 + 标 `unavailable`，不整页失败 | `tests/services/l3-study-note-export.test.ts` → `renders unavailable references as placeholders from stored snapshot` | 待实现轮实跑 |
| B6 | **五种引用类型**（`source`/`source_quote`/`question`/`stem_quote`/`option_quote`）各渲染正确、各有独立用例 | 同上 → `renders each of the five reference kinds`（表驱动 5 行，每型一条断言） | 待实现轮实跑 |
| B7 | **代码块/反引号**：正文含多行长围栏与行内反引号时围栏仍自适应 | 同 A1 用例（表驱动：`` ` ``、``` ``` ```、`` ````` ``） | 待实现轮实跑 |
| B8 | **hash 可复算**：删「内容校验」行后重算 == header == 正文行值（三方同值） | 同 A14 用例 | 待实现轮实跑 |
| B9 | **题纸不新增**：导出前后 `submissions` 行数不变 | 真库 `tests/l3-study-notes.integration.test.ts` → `export does not create submissions`（或等价命名）＋ HTTP 层 spy | 待实现轮实跑 |
| B10 | **作答不变化**：导出前后 `l3_question_attempts` 行数/内容不变 | 同上 → `export does not mutate attempts` | 待实现轮实跑 |
| B11 | **引用不重复**：同 marker 不重复渲染、JSON 块 `referenceId` 唯一（撞集合相等断言） | 同 A7 用例 + `tests/services/l3-study-note-export.test.ts` → `does not duplicate reference blocks` | 待实现轮实跑 |
| B12 | **导出不产生业务写入**：notes/venues/topics/refs 的 `version`/行数/`updated_at` 全部不变（零写） | 真库 `tests/l3-study-notes.integration.test.ts` → `export is read-only across notes venues topics and references` | 待实现轮实跑 |

### 3.3 门禁与验证（不可由目标测试替代）

> 收口轮已实跑；数值以本机日志为准，详见台账 §3 与 §3.3。

| # | 验收项 | 命令 | 判定 |
| --- | --- | --- | --- |
| C1 | 类型 | `npm run typecheck` | ✅ 已跑（含在 G1 内，exit 0） |
| C2 | 架构依赖约束 | `npm run arch:check` | ✅ 已跑（含在 G1 内，exit 0） |
| C3 | 单元 + 覆盖率 | `npx --no-install vitest run --coverage --maxWorkers=1` | ✅ 已跑（含在 G1：3968 passed / 6 skipped） |
| C4 | 分层覆盖率 + 用例收集 | `npm run coverage:layered` && `npm run test:collection` | ✅ 已跑（含在 G1 的 `test:unit` 内）：ratchet PASS、diff coverage **92.42% PASS**、collection 266/266。**原记「未逐条实跑」有误，已更正** |
| C5 | schema 漂移 | `npm run db:schema:drift` | ✅ 已跑（含在 G1 内，exit 0） |
| C6 | API 治理（openapi/client/合同/breaking） | `npm run api:governance` | ✅ 已跑（含在 G1 内，exit 0）。**原与 C4 同列为「未跑」有误，已更正** |
| C7 | 前端构建 | `npm run frontend:build` | ✅ 已跑（含在 G1 内，exit 0） |
| C8 | 运行时/告警/发布合同 | `npm run runtime:verify` && `npm run alerting:verify` && `npm run release:acceptance:contract` && `npm run secret-rotation:evidence:contract` && `npm run release:workflow:verify` | ✅ 已跑（含在 G1 内，exit 0） |
| C9 | 真库集成（串行；缺 DB 必须失败不 skip） | `npx --no-install vitest run --config vitest.integration.config.ts tests/l3-study-notes.integration.test.ts --maxWorkers=1` | ✅ 已跑（本批新增 `tests/l3-study-note-export.integration.test.ts` 6/6；既有 `l3-study-notes.integration.test.ts` 34/34） |
| C10 | 浏览器导出链 | `npx --no-install playwright test --config playwright.study-notes.config.ts` | ✅ **全 7 spec 已跑**：54 passed / 0 failed / 0 skipped（导出 5 · host 10 · 选择器关闭 3 · 引用回路 9 · 卷面侧栏 6 · Task08 回归 3 · 工作区 18） |
| C11 | 授权登记（导出端点 owner-only） | `npx --no-install vitest run tests/http/authorization-registry.test.ts --coverage.enabled=false` | ✅ 已跑（12/12） |
| C12 | **版本冲突真实链路**（收口轮新增） | `npx --no-install vitest run tests/http/study-note-export-version-chain.test.ts --coverage.enabled=false` | ✅ 5/5；**短路 `l3-study-note-export.service.ts:517` 后 2 failed**，还原后 5/5（证明测试有牙齿） |

> **口径更正（P3 / B4）**：任务书 §1 P3 与本表 B4 原写「缺/非法 `expectedVersion` → 400」，
> 实现为 **422**（`ValidationError.httpStatus = 422`，`src/errors/index.ts:52`），与题纸导出
> 先例 `tests/http/l3-sheet.test.ts:305` 同口径。**以实现为准，此处更正为 422。**
>
> **HTTP 层版本冲突测试的有效性更正**：`tests/http/study-note-export.test.ts` 中的 409 用例
> 注入的是**直接抛 `ConflictError` 的 mock service**，短路真实版本比较后**仍然通过**——
> 它证明的是错误映射，不是版本合同。真实链路的守卫由新增 C12 用例承担。

### 3.4 本任务书自身的验收（本轮）

| # | 验收项 | 证明 | 判定 |
| --- | --- | --- | --- |
| D1 | 本提交只含本文件、无功能代码 | `git show --stat --name-only <task-book commit>`；输出恰好一行 `docs/plan/study-notes-task10-execution-2026-09-22.md` | **已实跑**（见 §5 证据） |
| D2 | 分支/基线未偏 | `git rev-parse --abbrev-ref HEAD` = `study-notes-n1-task10`；父提交 = `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` | **已实跑**（见 §5） |
| D3 | 未 push、未触碰 main | `git push` 未执行；`git log --oneline -1` 仍在本地任务分支 | **已实跑**（见 §5） |

---

## 4. 先红后绿（TDD）纪律与变异检查

### 4.1 每条测试先红
**本任务的每一条行为测试都必须先写成失败测试，观察其因「行为未实现」而失败，再写实现使其转绿。** 具体纪律：

1. **先落测试文件与用例名，再落实现**：`tests/services/l3-study-note-export.test.ts`、`tests/http/study-note-export.test.ts`、`tests/frontend/study-note-export.test.tsx` 的用例名在 P1/P2/P3 之前即可提交到工作区（可先红）。
2. **红灯必须是断言失败，不是导入失败**：若测试因 `Cannot find module` 而红，需在绿灯轮**回填该红灯输出**作为「先红」证据；只记录一次「因实现缺失而红」的失败输出即可。
3. **红灯输出留痕**：每个测试文件至少留一条红灯运行记录（命令 + 失败断言原文摘要 + 通过数/失败数）。
4. **不得以「实现已存在」为由跳过先红**：若某断言在实现前意外通过，说明断言无效，必须改写到能在旧实现下失败为止。

### 4.2 关键行为的变异检查（mutation check）
对**关键行为**，除正常断言外必须做**至少一次变异检查**：人为删除该校验或回退到旧实现，**确认测试变红**，然后还原。变异后测试仍绿 = 该测试无守护力，必须加强或重写。

| 变异（M） | 操作 | 必须变红的用例 |
| --- | --- | --- |
| **M1** 删掉 `expectedVersion` 缺失校验 | 移除「缺失 → ValidationError」分支 | `rejects missing expectedVersion with 422`（A18/B4 面） |
| **M2** 删掉 `expectedVersion` 旧版比对 | 移除「`note.version !== expectedVersion` → 409」分支 | `rejects stale expectedVersion with 409 and currentVersion only`（B4） |
| **M3** 回退 `lockForShare` 为 `lock()`（FOR UPDATE 旧实现） | 导出事务改调 `repos.studyNotes.lock` | `locks the note with for share inside the actor transaction`（A9）——断言的是**方法身份**，故 FOR UPDATE 回退必红 |
| **M4** 把「内容校验」行纳入 hash 面 | 用含校验行全文计 sha256（破坏双段渲染） | `sha256 recomputes after deleting the checksum line` + `X-Export-Sha256 equals the in-body checksum`（A14/B8） |
| **M5** 删掉「无标准答案字段」白名单/断言面 | 让导出回填 `question` snapshot 的答案字段 | `never emits answer or evidence fields in markdown or json`（A8） |
| **M6** 把 fence 固定为 3 个反引号 | `fenceFor` 改为常量 ``` ``` ``` | `renders fences longer than the longest backtick run`（A1/B7） |
| **M7** 用当前活体正文替换历史摘录 | `resolve` 结果改用 `liveTitle`/当前 field 文本渲染 | `renders changed references from stored snapshot and marks captured time`（A5/A10） |
| **M8** 去掉 flush 屏障（直接 GET） | 删掉 `await controller.flush()` 前置 | `awaits flush before issuing the export GET` + `does not call export when persist rejects`（A15/A16/B2/B3） |
| **M9** 让导出产生一次业务写入 | 在导出事务中插入一条无副作用写（例如 touch `updated_at`） | `export is read-only across notes venues topics and references`（B12/B9/B10） |
| **M10** 顶层段落判定放宽为「包含即替换」 | 改用子串包含判定 marker | `does not replace inline or non-paragraph markers`（A12） |

**变异检查留痕格式**（实现轮回填）：`变异 M<n> → 命令 <cmd> → 失败用例 <name> → 还原 commit/时间`。**任一变异未能使测试变红，则该行验收判为未达成。**

---

## 5. 本轮（任务书提交）证据

本节由任务书撰写者在本轮**实跑**并回填，供评审直接核对；不得预留空白后补。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 起点基线 | `git rev-parse HEAD`（克隆内） | `48d7f60180cfee94f905a5f20c88cc62f9ceb83d`（与简报一致） |
| 分支 | `git rev-parse --abbrev-ref HEAD` | `study-notes-n1-task10` |
| 工作区 | `git status --porcelain` | 0 行（clean） |
| 只含本文件 | `git show --stat --name-only <task-book commit>` | 见 §5.1（提交后回填） |
| 盘点文件位置事实 | `git ls-files build-analysis` → 0 行；`git check-ignore build-analysis` → 退出码 1；克隆内 `build-analysis/` 不存在 | 已在文首「盘点文件位置说明」如实登记 |

### 5.1 提交记录（回填）

- 提交信息：`docs(plan): Task 10 任务书 — 导出与生命周期闭环`
- 提交 SHA：**`3cab33f`**
- 变更文件清单：`docs/plan/study-notes-task10-execution-2026-09-22.md`（唯一）
- 起点基线校验：`git rev-parse HEAD` == `48d7f60180cfee94f905a5f20c88cc62f9ceb83d` ✅（见 §5）
- **实现轮功能提交（已落地，回填）**：`923ff4d8e06a4912f12ac8d1cef7423d5f1e8160`
  `feat(notes): export portable notes with citation evidence`（27 文件，`+4552/-32`）。
- **实现轮补充提交（回填）**：`d9eb2ac` `test(l3): await retry button before clicking in
  writing-entry retry case`（唯一文件 `tests/frontend/l3-papers.test.tsx`）。

### 5.2 验收矩阵终态回填（2026-09-22）

> 逐行终态以执行台账 `docs/plan/study-notes-task10-ledger-2026-09-22.md` §3/§5 为准。
> **不逐行复制「通过」**——门禁面（C 表）与真库面（B9/B10/B12）**未通过或未实跑**，
> 故本任务书对应行的判定保持「未通过 / 未跑」，不得据聚合门禁推断为通过。

| 面 | 终态 |
| --- | --- |
| A1–A17（服务/HTTP/前端目标用例） | 用例**已随 `923ff4d` 落地**；本轮回填只声明「用例存在且用例名可检索」，**未在实现轮逐条复跑留痕** |
| A18（OpenAPI + client check） | 归入 `verify:engineering` 聚合（含 `api:governance`），**exit 0**；未单独留痕 |
| B9/B10/B12（真库零写三证） | 用例已写（`tests/l3-study-note-export.integration.test.ts:200,216,224`）；**未在真库实跑**（依赖 `verify:db`） |
| C1/C2/C3（含于 `verify:engineering`） | **exit 0**（passed=265 / failed=null / skipped=1） |
| C4/C9/C10/C11 | **未逐条实跑**（C9/C10 关联 `verify:db` exit 1、Playwright exit 1） |
| C5–C8（含于 `verify:engineering`） | **exit 0**（聚合内） |
| D1–D3（任务书自身） | **已实跑**（见 §5） |

---

## 6. 不做清单（本任务边界）

- 不实现 Task 11 的真库/浏览器/规模收口（C9/C10 若在 Task 10 内执行，只作证据不作交付声明）。
- 不引入导入能力（只出不进，先例红线：`l3-sheet-export.service.ts:10`）。
- 不改 `lock()` 的 `FOR UPDATE` 语义、不改保存路径、不改锁序（ADR §3 `:34`）。
- 不在 P2 之前落客户端导出函数；不留 stub、不返回占位数据（frontend-tasks §0.1 `:35`）。
- 不新增表、不新增迁移、不预占迁移编号。
- 不 push、不改 main、不触碰 PR #129/#130/#131。
- 不写实现代码到本任务书提交中（本提交唯一文件为本文档）。
