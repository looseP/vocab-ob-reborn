# 学习笔记 N1 · Task 07 执行台账（client / 保存控制器 / 基础编辑器）（2026-09-20）

> 范围：Task 07 = 文档纠偏 → `studyNotesClient`（Task 06 延期项）→ 可靠保存控制器 → hook/基础编辑器 → 最小联调宿主 → 真实浏览器 + 隔离 PG 验收 → 工程门禁。
> 纪律：本台账**不预填通过**——每项仅在真实命令/证据产生后更新；命令、退出码、提交、测试与未覆盖项分别如实记录；先红后绿适用于行为修复与新增功能；文档不写镜像测试。
> 执行仓库（本轮）：`D:/Temp/vocab-ob-n1-editor`（独立 clone；分支 `study-notes-n1-editor`；单执行者串行负责 Git 写入，只读复核另行独立）。
> 停止点：**停于 Task 08 之前**（不开发列表/专题管理/分页导航/引用侧栏/导出；不合并、不部署）。

## 0. 基线与依赖（实测）

| 项 | 值 | 证据 |
|---|---|---|
| 预期起点 | `study-notes-n1-backend@d234868c7a754d1d720cb998257de968dad6116b` | 执行提示 §1 |
| 主执行仓库 HEAD | `d234868`（= 预期起点；工作区干净） | `git log -1`、`git status --porcelain`（空） |
| 主仓库完整性 | `git fsck --full --no-reflogs` **exit 0**（无缺失/损坏对象输出） | 命令回显（主审曾遇 c31724e 读取 Permission denied；本轮复核 fsck 通过，未手工修对象） |
| 远端核对 | `origin/study-notes-n1-backend=d234868`；`origin/integration/l3-reliability-writing=b7dcea4e26b799b05a9b6312d9694908026c4e01` | `git fetch` + `git rev-parse` / `git ls-remote` |
| 依赖 PR | #126 OPEN / **draft** / base=`integration/l3-reliability-writing` / head=`study-notes-n1-backend@d234868` | `gh pr view 126 --json …` |
| 独立 clone（本轮） | `D:/Temp/vocab-ob-n1-editor`（`git clone --branch study-notes-n1-backend`） | clone 输出 `CLONE_EXIT=0`（969 文件 checkout） |
| 开发分支 | `study-notes-n1-editor` @ `d234868`（从核对过的后端 HEAD 起） | `git checkout -b` + `git rev-parse HEAD` |
| 工具链 | Node v22.22.2 / npm 10.9.7（`.nvmrc` 一致） | `node --version` / `npm --version` |
| 分支保护 | 不合并、不强推、不推 main、不改他人 PR base | 纪律声明（动作在 §7 留痕） |

### 0.1 环境备注（fs 行为与运行位置）

- 本机 fs 行为按**目录位置**分化（既有定位，见 `study-notes-engineering-closeout-2026-09-20.md` §2.3/§2.5）：Temp 类目录为快区；多数其它位置为慢区（≈4.1s/轮）且**偶发永久挂起**。
- 本轮工程门禁运行位置：**`D:/Temp/vocab-ob-n1-editor`（常规开发目录）**。不使用 `C:\Windows\Temp` 等依赖 `os.tmpdir()` 检测缺口的位置（守卫遗漏观察项见 §8.3）。
- `vitest run --coverage` 若出现收尾挂死：**保存证据并如实记录，不强制 exit0、不降阈值**；重试与结果分别记账。

## 1. 开工纠偏（先于实施；含实证校准）

执行提示 5 条纠偏已同步进 `study-notes-frontend-tasks-2026-09-20.md`（文档内以「2026-09-20 纠偏/校准」标注）：

1. **S4**：删除「新内容 T2 可复用 R1」例外——只有**完全相同的未确认请求**重试才复用其 requestId；T1 确认后发送 T2 必须**新 requestId R2、新确认版本 V2**。
2. **S10/S11/N10**：不得断言「失败/dispose/不导航 = 数据库无写」——请求可能已提交但响应丢失；正确断言为**不误报确认、不接受旧代回包、不继续导航**；实际结果以**库核**为准。
3. **冲突态**：删除「确认已合并后重试」；本批仅提供**复制本地内容**与**显式载入服务器版本**；载入成功后重新编辑，以**新 requestId 和新基线**保存；不做自动合并、不做强制覆盖。
4. **根因口径**：既有「根因已定位、非仓库代码问题」校准为「**挂起点与环境差异已定位；系统层根因未闭环**」；覆盖率完整自然退出的日志保留，不宣称原环境已修复（closeout/repair 已同步标注）。
5. **Windows Temp 守卫遗漏**：登记为**独立观察项**（运维合同要求演练锁在所有临时目录之外，`scripts/run-alerting-drill.ts` 实现仅检测 `os.tmpdir()`）；本批不修改告警系统，不靠该缺口制造门禁绿色。

### 1.1 实施前逐条核对后端消费合同（12 操作）后的**两处实证校准**

任务书 §0.1/§1.2 与旧稿有差异，按「实际路由与 response-contract 为准」核对后修订任务书：

| # | 旧稿表述 | 实测合同 | 证据 |
|---|---|---|---|
| C1 | preview 入参 `{target}` 包装 | **`ReferenceTarget` 本体**（`{kind:"source",sourceId}` 等直接作为 body） | 路由 `study-references.ts` 直接 parse `l3StudyReferenceTargetSchema`；`operations.ts:588` body 同 schema；HTTP 测试 `body: JSON.stringify({ kind: "source", sourceId })` 且断言 service 收到无包装对象；`generated/openapi.ts` requestBody 直接 union；设计文档 §7「ReferenceTarget → {preview}」 |
| C2 | 布尔以字符串 `true/false` | **`"1"/"0"`**（`pinned`/`unfiled` 均为 `enum(["0","1"])`） | `l3StudyNoteListQuerySchema`；openapi `pinned?: "0" | "1"`；HTTP 测试 `…&pinned=1&…` |

以下为**未被旧稿写明但已核实的合同细节**（实现与测试直接采用）：
- 列表响应为 `StudyNoteSummary`（**不含** `bodyMd`/`references`）；详情/保存响应 `{item}` 为 `StudyNoteDto`。
- DELETE 成员操作为 **JSON body**（`{requestId, expectedVersion}`）；PUT 成员为 `{requestId, expectedVersion, beforeNoteId: uuid|null}`。
- `nextCursor` 为 `string | null`，**原样透传不截断**；`limit` 默认 20、最大 50。
- 409 的 `meta.currentVersion` 非必有（成员操作/幂等冲突等 409 可能不带）；缺失时**不猜数值**。
- 无 `export` 端点（Task 10），client **不提供**该假接口。

## 2. 实施记录（逐阶段，真实命令与退出码）

### 2.1 Phase A · client（`studyNotesClient.ts`）

- 文件：`src/frontend/api/studyNotesClient.ts`（新）、`tests/frontend/study-notes-client.test.ts`（新）；关联改动 `src/frontend/api/browserRequest.ts`（`BrowserApiError` 增加可选 `headers`——将 429 `Retry-After` 传给控制器；既有测试 `toMatchObject` 断言不受影响）。
- 实施要点：12 操作按实际路由逐一核对（含 §1.1 的 C1/C2 两处校准）；响应经 `l3-study-note-response-contract` zod 运行时校验，非法 200 抛 `INVALID_RESPONSE`（不归一为空笔记/空列表）；`pinned`/`unfiled` 布尔以 `"1"/"0"` 序列化；DELETE 成员使用 JSON body；preview 发送 `ReferenceTarget` 本体；`nextCursor` 原样保留；写操作不自动重试；方法面精确断言为 12 个（无 export 假接口）。
- 首轮（红）：`node node_modules/vitest/vitest.mjs run tests/frontend/study-notes-client.test.ts tests/frontend/study-note-save.test.ts --coverage.enabled=false` → **EXIT=1**：client 全表用例 mock 未按 method 区分（修复）；controller 因变量重名无法编译（修复，见 §2.2）。日志 `D:/tmp/n1t-test1.log`。
- 二轮（红）：**EXIT=1**：全表用例在 URL 含 query 时 `endsWith("/study-notes")` 不命中（修复：按剥离 query 的 path 判断）。日志 `D:/tmp/n1t-test2.log`。
- 绿：**39/39 passed，EXIT=0**（client 19 + controller 20）。日志 `D:/tmp/n1t-test3.log`。
- **变异验证（防假绿）**：临时禁用响应校验（`call` 直接返回 data）→「非法 200」4 个用例全部失败（红，`D:/tmp/n1t-mutA.log`）→ `git checkout` 恢复 → 复跑绿（`D:/tmp/n1t-test4-green.log`）。
- 提交：**`d5fcb6d`**（client + browserRequest 扩展 + 测试；3 文件，+730/−2；提交后 fsck exit 0）。

### 2.2 Phase B · 保存控制器（`studyNoteSaveController.ts`）

- 文件：`src/frontend/state/studyNoteSaveController.ts`（新）、`tests/frontend/study-note-save.test.ts`（新）。
- 实施要点：完整快照 T={title,bodyMd,venues,pinned,status,references}；`editSeq`/`savedSeq` 独立；同 note 单在途；发送时冻结 payload/requestId/expectedVersion（深拷贝）；A 在途编辑 B 只确认 A、B 以新 requestId+新版本续发；结果不明（网络/超时/5xx）原样重试（同 requestId/payload/version），退避 1/2/4s 共 3 次，429 尊重 `Retry-After`（经 `BrowserApiError.headers`）且保持 3 次上限；401/403/400/404/422 不盲重试；409 停自动写进入 `conflict`（`currentVersion` 缺失为 null，不猜）；`flush()` 捕获调用时序号的语义、回执与「该序号确认时」的 version/lastSavedAt 绑定；error/conflict/dispose 结算等待者；订阅在释放 inFlight 后必发稳定终态；`dispose` 取消计时器、旧回包丢弃；`adoptServerSnapshot` 走 epoch 防污染；另增 `precheck`（marker 集合一致性；不通过 → `invalid` 状态阻止 PUT、修复后自动回 `dirty`）与 `retry()`（error 态继续同一未确认请求；conflict/invalid 态 reject）。
- 首轮编译红（与 client 同跑）：变量 `edit` 与函数 `edit` 重名（`D:/tmp/n1t-test1.log`）；重命名 `editSnapshot` 修复。
- 绿：**20/20 passed**（`D:/tmp/n1t-test3.log`）。
- **变异验证（防假绿）**：
  - B1：`savedSeq = request.seq` → `savedSeq = editSeq`（把新编辑误标已保存）→ 3 个用例红（A/B 交错、flush 序号绑定、重试排队）；恢复后绿。日志 `D:/tmp/n1t-mutB.log`。
  - B2：发送冻结移除（edit 直接引用调用方对象）→「发送载荷冻结」用例红；恢复后绿。日志 `D:/tmp/n1t-mutC.log`。
- 提交：**`a5762a0`**（controller + 测试；2 文件，+1386；提交后 fsck exit 0）。

### 2.3 Phase C · hook 与编辑器（`useStudyNoteEditor.ts` + `StudyNoteEditor.tsx`）

- 文件：`src/frontend/hooks/useStudyNoteEditor.ts`（新）、`src/frontend/components/studyNotes/StudyNoteEditor.tsx`（新）、`tests/frontend/study-note-editor.test.tsx`（新）。
- 实施要点：初始化仅 GET（身份 `normalizeStudyUuid` 校验 + 请求代际；失败错误/重试，不落回空笔记、不自动 POST）；同一 note 重复取数不重建 dirty 控制器（干净态才 adopt 刷新基线）；controller 与 effect 生命周期一致（StrictMode 双挂载安全、旧回包按代际/实例丢弃）；编辑/IME 经 controller（800ms 防抖、composition 期间不发、compositionend 补发）；冲突面板=复制本地内容（含 title/venues/status/引用清单；剪贴板失败给可见文本备选）/显式载入服务器版本（期间锁编辑 + 身份/代际/编辑序号检查，新输入出现则作废）；导航辅助 `requestNavigation`（同 tick/重复导航守卫；flush 后循环核对 savedSeq/editSeq 与无在途，失败释放锁留原位并显示原因）；beforeunload 仅诚实提示；正文 marker 行渲染为只读占位（复用域纯函数识别，unavailable 显示「已失效」仍保留摘录）；`leaveAction` prop 供宿主注入可 flush 的离开动作。
- 首轮绿：**12/12 passed，EXIT=0**（`D:/tmp/n1t-test6.log`）；期间发现 1 处用例数据缺陷（IME 用例的变更文本破坏了 marker 一致性、被预检拦截——恰好证明预检生效；修正用例数据后绿）。
- typecheck 首轮红→绿：`.ts` 测试文件受 `tsconfig.json` 覆盖，`deferredSave` mock 类型过宽与 `.catch` union 窄化问题修复后 **EXIT=0**（`D:/tmp/n1t-typecheck2.log`）。
- 提交：**`64bcb97`**（测试类型修复）、**`f8dd009`**（hook+editor+测试；提交后 fsck exit 0）。

### 2.4 Phase D · 最小联调宿主与真实浏览器/隔离 PG 验收

- 宿主：`src/frontend/pages/StudyNoteHostPage.tsx`（显式新建/按 noteId 打开/编辑/离开重开；无认证旁路，走真实 session/CSRF）；App 路由仅在 `VITE_N1_STUDY_NOTE_HOST=1` 时注册——**默认生产构建 grep 不到宿主**（`联调宿主`/`study-note-host` 均无匹配），显式构建生成独立 `StudyNoteHostPage-*.js` chunk（双向验证）。
- 验收库：**`vocab_study_notes_task07_accept`@127.0.0.1:5433**（本批独立空库；`DROP/CREATE`（owner=vocab_migration）→ `bootstrap-database-roles.ts prepare`（ok:true）→ `db:migrate`（40 迁移 applied）→ `converge`（ok:true））；核验：40 迁移、57 张 public 表、5 张 N1 表 `relrowsecurity=t`；受限角色 vocab_app/vocab_worker（NOBYPASSRLS）。
- 服务：`NODE_ENV=test PORT=3097 SERVE_FRONTEND=true DB_SSLMODE=disable DATABASE_URL=<app@task07库> OWNER_API_TOKEN=… LOCAL_OWNER_ID=… APP_ORIGIN=http://127.0.0.1:3097 node node_modules/tsx/dist/cli.mjs src/server.ts`（CORS/Origin 检查保持启用）。
- E2E：`playwright.study-notes.config.ts`（testDir=`e2e-study-notes`，**不进默认 `npx playwright test` 收集**）+ `e2e-study-notes/study-note-host.spec.ts`（7 用例）。运行：`node node_modules/@playwright/test/cli.js test --config=playwright.study-notes.config.ts`（env：DATABASE_URL=app、E2E_SETUP_DATABASE_URL=migration）。
- **结果：7/7 passed（1.3m），EXIT=0，进程干净退出**（`D:/tmp/n1t-e2e-final2.log`）：
  1. 显式创建→编辑→保存→F5/离开/重开一致；笔记计数全程不变（GET/F5/重开不 POST）；
  2. A 在途编辑 B（真实 1.5s 延迟响应）：UI 不回退、库核 title=B、version=3（创建1+A2+B3）；
  3. 服务端已提交但响应丢失（`route.fetch()` 后 `abort`）：控制器原样重试成功、库核 version=2（幂等未二次推进）；
  4. 双标签 409：冲突面板（服务器版本 3）→ 本地输入保留 → 陈旧 `expectedVersion` 经 API 显式断言 409+`details.currentVersion=3`（后端 CAS）→ 显式载入服务器版本 → 新基线保存（version=4）；
  5. 离页屏障：PUT 全阻断 → 自动重试耗尽入 error →「离开」不导航（navigationError、URL 不变）→ 恢复网络重试保存成功 → 离开成功；
  6. 已有引用含 unavailable（question 改 rejected）：仅改标题保存成功，引用行 `toEqual` 完全不变（id/display_snapshot/captured_at/field_hash/quote_snapshot）；
  7. 界面证据截图 4 张（编辑/预览/冲突/载入后）→ `D:/tmp/n1t-shots/01-editor.png`、`02-preview.png`、`03-conflict.png`、`04-after-load-server.png`。
- **E2E 环境定位实验（收尾挂死，如实记录）**：初版 ④ 用例点击「复制本地内容」后，playwright worker 收尾不退出（300s 后 force-kill；测试本身全过）。
  - 实验 A（去掉 `grantPermissions`，仍点击复制）→ 仍挂（`D:/tmp/n1t-e2e6.log` 未完整产生）；
  - 实验 B（`page.request` 改页面内 `evaluate fetch`，仍点击）→ 仍挂；
  - 实验 C（仅移除剪贴板点击）→ **正常退出**（`D:/tmp/n1t-e2e8.log`，17.2s 全绿）。
  - 结论：**headless 下真实写入系统剪贴板触发本机 worker 收尾挂死**（与「慢区 fs 挂死」同族的环境现象；不同机制未深究）。处置：E2E 保留「复制本地内容」入口断言，**真实剪贴板写入不在 E2E 覆盖**；复制成功/失败备选路径由组件测试（mock clipboard）覆盖。登记为观察项（§8）。
- 提交：**`0ec999e`**（宿主 + E2E config/spec + tsconfig；6 文件；提交后 fsck exit 0）。

### 2.5 Phase E · 工程门禁（等值分步，运行于常规开发目录 `D:/Temp/vocab-ob-n1-editor`）

| 步骤 | 命令 | 结果 | 日志 |
|---|---|---|---|
| typecheck | `npm run typecheck` | **0** | `D:/tmp/n1t-eng-tc.log` |
| arch | `npm run arch:check` | **0**（407 模块 0 违规） | `D:/tmp/n1t-eng-arch.log` |
| 全量单测+覆盖率 | `node node_modules/vitest/vitest.mjs run --coverage` | **0（自然退出，无挂死）**：245 passed/1 skipped（246 files）、3652 passed/6 skipped（3658 tests）、95.38s | `D:/tmp/n1t-unit-full.log` |
| 分层覆盖率 | `COVERAGE_BASE_REF=b7dcea4e… npm run coverage:layered` | **0**：各层 PASS（domain 98.17、service 95.11、repository 93.83、http 91.67）；ratchet PASS；**diff coverage 93.65% PASS**（31 变更源文件；1906 行/1785 覆盖） | `D:/tmp/n1t-eng-cov.log` |
| 测试收集 | `npm run test:collection` | **0**（246 收集/246 磁盘/0 缺失） | `D:/tmp/n1t-eng-collect.log` |
| schema drift | `npm run db:schema:drift` | **0** | `D:/tmp/n1t-eng-drift.log` |
| API 治理 | `API_CONTRACT_BASE_REF=b7dcea4e… ROUTE_COMPLEXITY_BASE_REF=b7dcea4e… npm run api:governance` | **0**（openapi 再生成无 diff；client check 一致；contract 10/10；breaking 无；31/31；route complexity ratchet passed） | `D:/tmp/n1t-eng-api.log` |
| 前端构建 | `npm run frontend:build` | **0**（默认构建；产物中无宿主痕迹） | `D:/tmp/n1t-eng-fb.log` |
| runtime | `npm run runtime:verify` | **0** | `D:/tmp/n1t-eng-rv.log` |
| alerting | `npm run alerting:verify` | **0** | `D:/tmp/n1t-eng-av.log` |
| release 合同 | `release:acceptance:contract` / `secret-rotation:evidence:contract` / `release:workflow:verify` | **全 0** | `D:/tmp/n1t-eng-rac.log` / `-src.log` / `-rwv.log` |

- **说明**：全量 `vitest run --coverage` 本轮在常规开发目录（`D:/Temp/…`，非任何临时目录；不在 `os.tmpdir()` 检测缺口内）**自然退出 0**——无需也不得借道 `C:\Windows\Temp` 等位置；「挂死」本轮未复现（历史机制定位见 closeout §2；系统层根因仍未闭环）。
- 定向回归（另跑）：`study-notes-client` + `study-note-save` + `study-note-editor` + `writing-client` + `writing-save-controller` + `browser-request` + `exam-sheet-save-controller` → **126/126 passed，EXIT=0**（`D:/tmp/n1t-reg1.log`）。
- 相关旧卷面/作文回归：`exam-sheet-save-controller`、`writing-save-controller`、`writing-client`、`browser-request` 均含于上述 126；全量套件 3652 用例覆盖其余旧面。

## 3. 提交、推送与 PR

| # | 提交 | 内容 |
|---|---|---|
| 1 | `d9c9e2f` | 文档校准（任务书 5 条纠偏 + 两处实证校准）+ 执行台账开档 |
| 2 | `d5fcb6d` | client（studyNotesClient + browserRequest headers + 测试） |
| 3 | `a5762a0` | 保存控制器 + 测试 |
| 4 | `64bcb97` | 测试类型修复（typecheck 绿） |
| 5 | `f8dd009` | hook + 编辑器组件 + 测试 |
| 6 | `0ec999e` | 联调宿主 + E2E config/spec |
| 7 | （本条）| 验收台账更新 |

- 推送：`git push origin HEAD:refs/heads/study-notes-n1-editor`（**新分支普通推送，非强推、未推 main**）；`git ls-remote` 远端 = 本地 = `bc202bac21809a78ea75a77f473ae56062eb84ea`（推送时点）。本台账更新提交将再次普通推送；最终 head 以 `git ls-remote origin refs/heads/study-notes-n1-editor` 为准。
- PR **#127**（**draft / OPEN**）：base=`study-notes-n1-backend`（依赖链 **#127 → #126 → #125**），head=`study-notes-n1-editor`；正文含范围/证据/边界与依赖说明；未 retarget、未合并、未部署。
- CI（真实口径）：`Writing E2E` 自动触发（run `35462708553`）；`ci.yml`（Engineering Gate + Browser E2E）不在 base≠main 的 PR 上触发——三项必需检查待 #125 合并并 retarget 后在最终 head 运行（后续授权任务）；**不得转述为三项必需 CI 已绿**。

## 4. 未覆盖项与观察项（如实边界）

1. **剪贴板真实写入的 E2E 覆盖缺失**（观察项）：headless 本机下触发 worker 收尾挂死（实验 A/B/C 定位）；E2E 仅断言入口，交互路径由组件测试覆盖。不影响产品功能结论，但「真浏览器里系统剪贴板」未取得证据。
2. **「恢复期间新输入作废」分支**：UI 锁（disabled + 同步 ref）下不可达；该分支为防御性检查（代码审查覆盖），组件测试覆盖「锁编辑 + 恢复成功 + 恢复失败」三态。
3. **`searchTargets` 响应 union 的混装边界**：response-contract 冻结为 `source|question` union；未针对「单次返回混装」写专项反例（服务端按 kind 过滤；schema 语义如此）。
4. **Windows Temp 守卫遗漏**（独立观察项，非本批修复）：运维合同要求演练锁在所有临时目录之外；`scripts/run-alerting-drill.ts` 仅检测 `os.tmpdir()`。本批不修改告警系统；本批门禁运行位置为常规开发目录，未借该缺口。
5. **挂死系统层根因未闭环**（历史观察）：本批全量覆盖率自然退出，未复现挂死；机制定位见 closeout §2「挂起点与环境差异已定位；系统层根因未闭环」。
6. **Task 08 未开始**：列表/专题管理/分页导航/正式入口尚未开发；本批宿主不是产品入口（生产构建不含）。
7. **N1 完整交付未达成**：Task 09（引用侧栏/原位引用）、Task 10（导出）未开发；不宣称 N1 已交付。

## 5. 停止点声明

本轮完成**仅代表 Task 07 基础编辑与保存能力已通过组件级与真实浏览器/隔离 PG 验收**。按任务书要求**停止在 Task 08 之前**：不开发列表/专题/引用侧栏/导出；不合并、不部署；不宣称 N1 完整交付。
