# 学习笔记 N1 · Task 07 补修 R1–R5 执行台账（2026-09-20）

补修对象：`D:/Temp/vocab-ob-n1-editor`，分支 `study-notes-n1-editor`。
审查基线 HEAD：`cf696e0222a19d3b3c103eb763d3d0c65a5a03fa`；PR #127（draft，base=study-notes-n1-backend，依赖 #127→#126→#125）。
独立审查报告：`D:/Temp/Myawesomeapp/vocab-ob'/build-analysis/status-2026-09-20/TASK07-INDEPENDENT-REVIEW.md`（仓外）。

范围：仅 R1（422/确定拒绝恢复）、R3（reload 本地输入保护）、R2（在途续发遵守 IME）、R5（flush 回执序号/版本/时间绑定）、R4（预览 marker 识别与域合同一致）及直接关联回归。不扩入 Task08/09、导出、N2、系统层挂死与告警守卫调查。

方法：每项先写正式行为回归并运行证明旧实现失败（行为断言失败，非编译/类型/用例缺陷），再最小修复使通过；随后真实浏览器＋隔离 PG 验收、工程门禁、独立只读复核。

---

## 0. 基线与开工核对（实测）

- 本地 HEAD `cf696e0222a19d3b3c103eb763d3d0c65a5a03fa` = 审查 HEAD；`git status --porcelain` 干净；`git fsck --full --no-reflogs` exit 0。
- 远端 `origin/study-notes-n1-editor` = `cf696e0222a19d3b3c103eb763d3d0c65a5a03fa`（推送后未动）。
- PR #127：draft / OPEN / base=`study-notes-n1-backend`（核对命令与输出见 §6）。

### 0.1 开工实证校准（先于修复）

1. **「超长标题 → 422」为任务书转写偏差，实测为真实 400**：`l3StudyNoteSaveSchema.title = z.string().max(120)` 在 HTTP 路由层 `safeParse` 失败 → `validationError(...)` → **400 VALIDATION_ERROR**（`src/schemas/http/index.ts:878` 复用 `saveStudyNoteSchema`；`src/http/routes/l3/study-notes.ts:44-46`；`src/http/error-response.ts:34`）。服务端 **422** 来自 service 层 `ValidationError`：marker 集合不一致（service:415-419）、keep 引用不存在（service:783）、快照总量超限（service:832）等。两者同属「服务端确定拒绝本次写入且本次尝试未提交」——R1 修复按此合并分类；E2E 用两条真实路径覆盖（见 §2 与 §7），不使用伪 422。
2. **R4 单真源**：`src/domain/l3-study-notes.ts` 已以 `import { lexer } from "marked"` 实现「顶层 paragraph token 且 text 完全相等」识别（`parseReferenceIds`）。前端预览的逐行 trim 实为重复且不等价的实现，修复改为共享同一识别函数。
3. 探针复算（仓外 `task07-controller-probes.mjs` / `task07-ui-probes.test.ts`）的复现条件以实际代码独立复核；其 mock 状态码（422）与真实合同（400）的差异按上条处理。

---

## 对照总表（R1–R5：旧行为失败 → 修复 → 跨层证据）

| 项 | 旧行为（可复现失败） | 修复要点 | 行为红绿（层级） | 真实浏览器/库核 | 提交 |
|----|----------------------|----------|------------------|-----------------|------|
| R1 | 422 拒绝后重试**原样重发 121 字旧载荷**（`n1r-red-r1.log`）；错误面板一律「网络或服务异常」（`n1r-red-r1ui.log`） | rejected/unknown/auth 分流；修正后以最新快照 + 新 requestId 重试；errorKind/lastErrorMessage | controller 6 红→26/26 绿；组件 1 红→13/13 绿 | E2E ⑧（真实 400→修正→成功，PUT×2 且第 2 次携最新）；⑨（真实 422→保全→修正→成功） | 463dd02 / f9efdda |
| R3 | reload 销毁控制器：dirty 回服务器值、在途丢失、error/conflict 重置（`n1r-red-r3.log`） | reload 收窄为初始化失败重试；活跃控制器 no-op | hook 4 红→5/5 绿 | （hook 语义；浏览器端无 reload 入口） | 463dd02 |
| R2 | A 确认后**立刻发送组合中未完成快照**（`n1r-red-r2.log`） | 管道续发前检查 composing；导航组合中明确拒绝 | controller 3 红→4/4；组件 2/2 | E2E ⑩（组合中 PUT 不增；compositionend 后完整发送） | 463dd02 |
| R5 | 合并确认后回执 `editSeq=1`（等待目标混用），实际 savedSeq=2（`n1r-red-r5.log`） | 回执 editSeq=实际确认 savedSeq；version/时间同次确认 | controller 1 红→3/3 | ⑨/⑩ 的库核 version 列一致性 | 463dd02 |
| R4 | 缩进代码误识别为引用卡（`n1r-red-r4.log`） | domain 单真源 + marked 顶层 token 分块 | 组件 1 红→3/3；纯函数 10/10 | ⑦ 预览截图 | 463dd02 |

- 红 = 行为断言失败（非编译/类型/用例缺陷）；全量绿与门禁见 §7；独立审查者探针复跑见 §6.1。

## 1. R1 · 真实确定拒绝之后允许修正内容并保存

- 状态：已完成（单元/组件 + 真浏览器/隔离 PG）
- 旧行为失败证据（先红，实际运行日志）：
  - controller 级 6 用例首跑全红（`D:/tmp/n1r-red-r1.log`，EXIT=1）：核心断言 `calls[1].snapshot.title` 期望 `"fixed"` 实得 121 字旧载荷——**旧实现把 422 确定拒绝的旧载荷保留为 unconfirmed，重试原样重发旧内容**；快照无 `errorKind`/`lastErrorMessage`（undefined）。
  - 组件级 1 用例首跑红（`D:/tmp/n1r-red-r1ui.log`，EXIT=1）：错误面板固定文案「保存失败（网络或服务异常）」，不含服务端原因「标题超过上限」。
- 修改：
  - `src/frontend/state/studyNoteSaveController.ts`：`SendOutcome` 的 `failed` 拆为 `rejected`/`unknown`/`auth`；新增 `classifyConfirmedRejection`（INVALID_RESPONSE→unknown【服务端 2xx 但响应非法，可能已提交】；无 status/0/5xx→unknown；408/425/429→unknown；401/403→auth；其余 4xx【400/404/422 等】→rejected）与 `extractErrorMessage`；runPipeline：rejected 清除旧载荷重试权（修正后 retry 以最新完整快照 + 新 requestId + 最近已确认 expectedVersion 提交），unknown/auth 保留 unconfirmed（原样重试/身份恢复）；快照新增 `errorKind`/`lastErrorMessage`（成功/ adopt / invalid 时清理）。
  - `src/frontend/components/studyNotes/StudyNoteEditor.tsx`：错误面板按分类呈现（rejected=「保存被服务端拒绝（原因）…」；auth=登录/权限引导；unknown=网络/服务异常），不再一律网络问题。
- 通过断言（修复后）：controller 全文件 26/26（`D:/tmp/n1r-green-r1a.log`）；组件 13/13（`D:/tmp/n1r-green-r1ui.log`）。
- 状态转换依据（任务书 §二.3，记录于代码注释）：同一请求先经历结果不明（自动退避重试）再收到 422 时——按服务端幂等重放语义，已提交的请求重放返回已存储结果而非 422，故 422 到达即证明本次写入未提交，可转为 rejected；**无法识别形状的失败一律按 unknown 保守保留未确认请求**（不静默丢弃未确认写）。
- 真浏览器/库核：E2E ⑧（真实服务端拒绝→修正→重试→库核 title=修正值、version 恰推进 1；PUT 恰 2 次、第 2 次携最新内容）；E2E ⑨（真实 422→修正→成功；PUT 恰 2 次）；服务端日志实证 400×1、422×1（§6）。
- 相关提交：见 §8。

## 2. R3 · 同笔记 reload 不丢弃未保存输入

- 状态：已完成（单元/组件）
- 旧行为失败证据（先红）：hook 级 4 用例首跑红（`D:/tmp/n1r-red-r3.log`，EXIT=1）——`expected '初始标题' to be 'local unsaved'`（dirty reload 丢输入）、在途内容丢失、error→idle、conflict→idle（reload 推进 loadNonce → effect cleanup dispose 控制器 → 重建）。
- 修改：`src/frontend/hooks/useStudyNoteEditor.ts` 的 `reload` 收窄为「**初始化失败后的重试**」——已有活跃控制器（未 dispose）时 **no-op**：不销毁、不覆盖 dirty/inFlight/error/conflict、不触发重复取数；显式放弃本地内容仍唯一走 `loadServerVersion` → `adoptServerSnapshot`。接口文档与顶部纪律注释同步（含 Task 08 接入约束）。
- 通过断言（修复后）：hook 级 5/5（`D:/tmp/n1r-green-r3.log`）；组件全文件 18/18（`D:/tmp/n1r-green-r3all.log`）。
- 边界语义（选定并同步）：同身份刷新**不承担**冲突恢复职责；换 note（noteId 变化）仍为身份切换（正常重新加载、旧响应不污染新笔记，R3-D 用例覆盖）。首次加载失败 →「重试加载」仍可用（无控制器时 reload 生效；既有用例保持绿）。
- 相关提交：见 §8。

## 3. R2 · 在途保存续发遵守 IME 组合状态

- 状态：已完成（单元/组件 + 真浏览器事件路径）
- 旧行为失败证据（先红）：controller 级 3 用例首跑红（`D:/tmp/n1r-red-r2.log`，EXIT=1）——A 确认后**立刻发送组合中的未完成快照**（`expected "vi.fn()" to be called 1 times, but got 2 times`；退避场景 3 次；dispose 场景 `got 2`）。
- 修改：
  - `studyNoteSaveController.ts`：runPipeline 循环在「选择/发送**新的**编辑快照」前检查 `composing` → break（等 compositionend 后的防抖补发）；已冻结的 unconfirmed 原样重试不受影响（与未完成编辑区分）。快照新增 `composing` 字段。
  - `useStudyNoteEditor.ts`：`requestNavigation` 在组合中**明确拒绝**并提示（不进入「锁输入 + flush 等待」流程）——避免禁用输入导致 compositionend 缺席/flush 永久 pending；不使用任何超时把半成品当完整内容保存。
- 通过断言（修复后）：controller 4/4（`D:/tmp/n1r-green-r2.log`）+ 全文件 30/30；组件级 2/2（`D:/tmp/n1r-green-r2ui.log`，含导航协同用例：组合中导航被拒、输入未锁死、完成后保存并可导航）。
- 真浏览器：E2E ⑩（合成 composition 事件；非 OS 输入法人工实测——HTTP/PG 全真实）：组合中不发快照、状态「未保存」；compositionend 后发送完整内容；库核 version=3。
- 相关提交：见 §8。

## 4. R5 · flush 回执对应实际确认快照

- 状态：已完成（单元/组件）
- 旧行为失败证据（先红）：`D:/tmp/n1r-red-r5.log`（EXIT=1）——等待目标 1/2 被一次 seq2 确认覆盖后，回执 `editSeq=1`（等待目标序号混用），实际 `savedSeq=2`。
- 修改：`studyNoteSaveController.ts` 的 `resolveEligibleWaiters` 回执 `editSeq` 改为**实际确认序号 savedSeq**（version/lastSavedAt 同一次确认；内部 `targetSeq` 保留为 resolve 条件）；flush 即时路径同改；`StudyNoteFlushReceipt` 注释重写。`useStudyNoteEditor.ts` 导航调用者移除对回执序号的比较（防语义变化导致提前导航），一律以「最新快照无未保存/无在途」为离开条件。
- 通过断言（修复后）：controller 3/3（R5-A/B/C）+ 全文件 33/33（`D:/tmp/n1r-green-r5.log`）；组件 20/20（导航成功路径保持，`n1r-green-r5ui.log`）。
- 相关提交：见 §8。

## 5. R4 · 预览引用识别与全文 Markdown 域合同一致

- 状态：已完成（纯函数 + 组件 + 复用单真源）
- 旧行为失败证据（先红）：组件级「缩进代码中的 marker」首跑红（`D:/tmp/n1r-red-r4.log`，EXIT=1）：`expected 1 to be +0`——旧逐行 trim 实现把 4 空格缩进代码误识别为引用卡（域合同 `parseReferenceIds=[]`）。
- 修改：
  - `src/domain/l3-study-notes.ts`：抽出并导出 `matchReferenceMarkerText`（`none`/`marker`/`invalid` 三分支，UUID 归一为小写）+ `ReferenceMarkerMatch` 类型；`parseReferenceIds` 改为复用（行为不变、单真源）。
  - 新增 `src/frontend/utils/studyNotePreviewBlocks.ts`：`splitStudyNotePreviewBlocks` 基于 marked lexer **顶层 token** 分块——仅顶层 paragraph 完全等于标记时替换为引用块；其余保留 token.raw 原文（不重新序列化）；**链接定义（def token）前置复制到每个 markdown 块**（跨块渲染后仍可解析，def 渲染为空、无可见副作用）。旧 `splitBodyBlocks/extractMarkerLine` 删除。
- 通过断言（修复后）：纯函数矩阵 10/10（`D:/tmp/n1r-preview-pure2.log`：缩进代码/三·四反引号/围栏嵌套/波浪围栏/列表/引用块/连续段落同形文本均不变卡；合法顶层 marker 变卡含大写 UUID 归一；无效 marker 不误报且与域抛错对照；链接定义跨块保持）；组件 R4 3/3（`n1r-green-r4.log`，含 XSS 净化保持）+ 组件全文件 23/23；domain 全家回归通过（§7）。
- 相关提交：见 §8。

## 6. 真实浏览器 + 隔离 PG 验收

- 环境：隔离验收库 `vocab_study_notes_task07_accept`@127.0.0.1:5433（40 迁移；受限角色 `vocab_app` 走业务请求，`vocab_migration` 仅库核/种子）；服务端口 3097（源码直跑）；前端 `VITE_N1_STUDY_NOTE_HOST=1` 构建（宿主页）。
- 命令与退出码：见 §7（E2E 命令一行；EXIT=0）。
- 结果：**10/10 通过，干净退出（1.0m）**（首跑 `D:/tmp/n1r-e2e1.log`；**终态复跑** `D:/tmp/n1r-e2e-final2.log`，59.7s，EXIT=0，含注释后的最终 spec）。
  - ①-⑦ 回归全绿（创建→编辑→保存→F5/重开一致且不自动创建；A/B 交错；已落库丢响应原样重试；双标签 409+CAS+显式载入；离页屏障失败留原位；unavailable 引用逐列不变；截图 4 张）。
  - ⑧ 真实确定拒绝恢复：121 字标题 → 服务端真实 400 → 面板「服务端拒绝」→ 修正 → 重试提交最新内容 → 库核 title/version；PUT 恰 2 次。
  - ⑨ 真实 422 恢复：库删引用行 → 保存 → 真实 422（面板含服务端原因「keep 引用必须已属于当前笔记」）→ 本地输入保留 → 恢复引用行 + 内容再修正 → 重试成功；PUT 恰 2 次；引用行逐列与原值一致。
  - ⑩ 在途 IME：A 在途 → 合成 compositionstart + 输入未完成内容 → A 响应后不发快照（PUT 仍 1 次）→ 状态「未保存」→ compositionend → 发送完整内容 → 库核 version=3。合成事件非 OS 输入法人工实测（如实标注）；HTTP/PG 全真实。
- 服务端状态码实证（`D:/tmp/n1r-e2e-server.log`）：PUT 分布 = 200×18 / 400×1 / 409×3 / 422×1。

### 6.0 「真实 422」验收口径校准（用户要求）

- **用户可操作的真实拒绝恢复路径 = ⑧**：超长标题触发**真实服务端 400**（路由层 schema 拒绝，`VALIDATION_ERROR`）；用户仅用编辑器「改短标题 → 重试」即可完成恢复——**这是向用户的推荐恢复步骤**。
- **⑨（keep 引用缺失）标注为「异常检测测试」，非用户可操作恢复**：422 来自 service 层「keep 引用必须已属于当前笔记」；当前编辑器**不提供移除/重建引用**（引用工具后置 Task 09），**用户无法在界面内自修**；用例验证的是「真实 422 检测、本地输入保全、错误分类可读、重试提交最新内容」，恢复依赖**世界修复**（恢复引用行）。已在 spec 中以注释显式标注，**不**把它称作可操作恢复路径，**不**为补洞提前开发 Task 09。
- 补充：**「请求已提交但响应丢失 → 重试遇鉴权失败 → 新编辑 → 鉴权恢复 → 原请求重放 → 新编辑继续保存」**的组合顺序与版本正确性由 controller 级 **R1-G** 锁定（见 §1）；真实 HTTP 分段证据 = ③（丢响应重放幂等）+ ⑧（确定拒绝恢复）。**浏览器侧限制（观察项，见 §9）**：真实 401 会触发 `BrowserSessionGate` 的会话过期兜底（提示 + 回到登录页），编辑器随登录页替换被卸载——「页内 401 恢复→重试」的完整链在浏览器层不可达，故该链以控制器合同级验证为准。

### 6.1 独立探针复核（用审查者仓外探针在新实现上复跑）

- `task07-controller-probes.mjs`（tsx 直跑，真实 controller + 注入 save）：
  - `edit-after-422`：`sentTitleLengths [121, 5]`（旧：`[121,121]`）、`state "idle"`（旧：`error`）、`savedSeq 2`（旧：`0`）。
  - `composition-starts-while-A-in-flight`：`callsBeforeCompositionEnd ["A"]`（旧：`["A","unfinished IME"]`）、`state "dirty"`（旧：`idle`）。
  - `coalesced-flush-receipt`：`receipt.editSeq 2` = `actualSavedSeq 2`（旧：`editSeq 1`）。
- `task07-ui-probes.test.ts`（审查者配置 jsdom 复跑）：**2/2 通过**（旧实现 2/2 失败）——same-note reload preserves dirty input；indented code marker remains code in preview。
- 说明：探针为**审查者独立编写**、由本执行者在其新实现上复跑；该复跑不替代审查者对该轮修复结论的复核。

## 7. 工程门禁与回归

- 运行位置：常规开发目录 `D:/Temp/vocab-ob-n1-editor`（未借 Windows Temp；未降阈值、未增 skip、未关 coverage）。
- **最终全量单测 + 覆盖率**（`D:/tmp/n1r-unit-full7.log`，对应最终代码 HEAD）：`Test Files 246 passed | 1 skipped (247)`；`Tests 3687 passed | 6 skipped (3693)`。
  - **收尾限制（环境，非测试失败）**：vitest 收尾 `cleanAfterRun` 的 `rm(coverage/.tmp)`（>50 文件）被本机 safe-delete bulk guard 拦截（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），运行以 exit=1 结束；**测试结果与报告产物完整**（`coverage/coverage-final.json` / `coverage-summary.json` 齐全，full5/full6/full7 三次一致）。不绕护栏、不降门槛（详见 §9 环境观察 A）。
- **coverage:layered**（`COVERAGE_BASE_REF=d234868…`【= PR #127 base，CI 语义一致】；`D:/tmp/n1r-layered2.log`，**EXIT=0**）：
  - Baseline ratchet **PASS**；Final target **PASS**；**Diff coverage 100% (PASS)**——changed src files 9（governed 1 / outside 8）；changed executable lines 10（covered 10）；uncommitted src files 0。
  - 分层：domain 98.18% / service 95.11% / repository 93.83% / http 91.67% ——全 PASS。
- **typecheck**（`n1r-tc.log` EXIT=0）、**arch:check**（`n1r-arch.log`，408 模块 0 违规）、**frontend:build**（默认构建无宿主 `n1r-fb-default.log`；E2E 宿主构建 `n1r-fb-host3.log`）、**test:collection**（`n1r-collect2.log`，247/247）、**db:schema:drift**（`n1r-drift.log` OK）——全部 EXIT=0。
- **api:governance**（`API_CONTRACT_BASE_REF` / `ROUTE_COMPLEXITY_BASE_REF=d234868…`；`n1r-api.log`，**EXIT=0**）：`未发现 breaking change`（base 无 openapi 快照 → bootstrap 合法路径）；route complexity ratchet passed；无生成物漂移（git status 无 API 生成物变更）。
- **runtime:verify / alerting:verify / release:acceptance:contract / secret-rotation:evidence:contract / release:workflow:verify**——全部 **EXIT=0**（`n1r-rv/av/rac/src/rwv.log`）。
- **E2E 终态复跑**（最终 spec）：**10 passed（59.7s），EXIT=0**（`n1r-e2e-final2.log`）。
- 定向回归：9 文件 **204/204**（`n1r-reg1.log`）；domain/http/题纸/写作 19 文件 **375/375**（`n1r-reg2.log`）；学习笔记三文件 **67/67**（save 34【含 R1-G 加强】+ editor 23 + preview-blocks 10）。
- **verify:engineering 等值分步**：上述各项覆盖其全部步骤（typecheck→arch→test:unit【覆盖率+layered+collection】→drift→api:governance→frontend:build→runtime→alerting→release×3），每步均为实际命令；唯一非 0 = 覆盖率的收尾护栏（原因与影响见上）。

## 8. 提交、推送与 PR

- 提交（本分支 `study-notes-n1-editor`；单一执行者写入；HUSKY=0；每次 git 写后 fsck 与指针核验）：
  - `463dd02` fix(notes): Task 07 repair — rejection recovery, reload guard, IME-safe pipeline, flush receipt, marker parsing (R1–R5)（9 文件，+1345/−79）
  - `f9efdda` test(notes): strengthen R1-G ordering and version assertions
  - 本台账随分支最后一次 docs 提交推送（SHA 见 PR 评论）。
- 基线：开发 base `d234868c7a754d1d720cb998257de968dad6116b`；审查起点 `cf696e0222a19d3b3c103eb763d3d0c65a5a03fa`。
- 推送（普通推送，非强推；核对本地=远端）：`cf696e0..f9efdda` → 远端 `f9efddad4c8a07ec730c4dd761dfc832f368758f`；未推送 main。
- PR #127：保持 **draft**、base=`study-notes-n1-backend`（依赖链 #127→#126→#125 不变，未 retarget）；评论记录最终 SHA 与证据索引。
- CI（真实口径）：`Writing E2E` 触发于本分支；`ci.yml` 三项必需检查因 base≠main 未触发——待 #125 合并 retarget 后在最终 head 运行，不以现有绿色替代。

## 9. 未覆盖项与观察项

- 剪贴板真实写入的 E2E：本机 headless 下真实写系统剪贴板会触发 worker 收尾挂死（前批实验 A/B/C 定位）；E2E 只做入口存在断言，交互（成功/复制失败备选）由组件测试覆盖——**缺口如实保留，不称已覆盖**。
- 「恢复期间新输入作废」分支：UI 锁下不可达（防御性代码 + 审查），无独立用例。
- Task 09/10 未开发（引用侧栏/选区引用/导出）；Task 08（笔记空间）未启动——本批停在 Task 08 之前。
- **环境观察 A（独立于本批代码；不绕护栏）**：本机 safe-delete 护栏对 >50 文件删除要求人工确认 → vitest coverage 收尾 `cleanAfterRun` 的 `rm(.tmp)` 以 exit=1 结束（测试与报告不受影响）。如需「自然退出」，需在 WorkBuddy 界面人工确认该批量删除，或由宿主侧调整护栏配置；本批不改任何护栏/不降门槛。
- **环境观察 B（独立于本批代码）**：`tests/scripts/run-alerting-drill.test.ts` 存在**间歇性锁残留**（锁名含 worker pid；单跑三次中一次观察到「锁释放后文件残留且无报错」；Node `unlink` 直接实验正常；后续运行若复用同 pid 撞锁 → 15 例连锁 EEXIST，错误「已有告警演练锁」）。处理：运行前清残留锁（幂等）+ 重跑；full5/full6/full7 均全绿；**未修改仓库测试代码**（不属本批范围，另列）。
- **环境观察 C（产品级，留待后续批次）**：浏览器真实 401 触发 `BrowserSessionGate` 会话过期兜底（提示 + 回登录页）→ 编辑器被卸载、未保存输入随卸载丢失——「页内 401 恢复→重试」完整链在浏览器层不可达；R1 的 auth 合同以控制器级（R1-E/G）验证为准。页面级输入保全/重登恢复可作 Task 08+ 议题（不属本批）。

## 10. 停止点声明

- 完成后停在 Task 08 之前；不合并、不 retarget、不部署、不推 main。本轮完成仅代表 Task 07 基础编辑与保存能力的 R1–R5 补修已交付并验证。

## 11. Task 08 可消费合同（交接）

- **reload 边界**：`reload()` 仅用于「初始化失败后的重试」；已有活跃控制器时 **no-op**（不丢 dirty/inFlight/error/conflict，不触发重复取数）。Task 08 的「同笔记刷新/返回」不得复用它丢弃本地内容；显式放弃本地内容唯一入口 = `loadServerVersion()` → `adoptServerSnapshot`。
- **error 恢复**：快照 `errorKind`：`rejected`（服务端确定拒绝【400/404/422 等】→ 修正后重试提交「最新完整快照 + 新 requestId」）；`unknown`（结果不明【网络/超时/5xx/429 耗尽/INVALID_RESPONSE】→ 显式重试原样重发同 requestId/expectedVersion，自动退避 1/2/4s 有界）；`auth`（401/403 → 保留未确认请求 + 登录恢复引导）。面板/提示消费 `lastErrorMessage` 呈现可读原因。
- **flush 回执**：`{editSeq, version, lastSavedAt}` 指向**同一次实际确认**（editSeq=实际确认 savedSeq）；离开/导航条件 = 「最新快照 editSeq<=savedSeq 且无在途」，不以回执序号本身做提前导航；组合（composing）中输入时导航被明确拒绝（先完成输入）。
- **未改动**：client 12 操作与严格响应校验、列表/专题底层方法（本批未新增 API）；preview 裸 `ReferenceTarget`、布尔 query=`1/0` 合同不变。
