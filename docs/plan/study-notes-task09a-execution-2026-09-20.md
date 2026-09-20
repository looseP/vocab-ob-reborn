# Task 09A：笔记内引用闭环 — 执行台账（2026-09-20）

> 起点 `832192943496099e53b3330bd0d2e7fb85b925c2`（PR #128 head）；分支 `study-notes-n1-task09a`（独立依赖分支，base=study-notes-n1-task08）。范围：分页查找现有对象、预览、插入引用、引用卡片、移除与转普通摘录。侧栏、导出、N2 后置。

## 0. 复用合同（不改）

- **数据模型**：`ReferenceTarget`（5 kind）/`ReferenceWrite`（keep|capture）/`ReferencePreview`（status: current|changed|unavailable、displaySnapshot、liveTitle、capturedAt）——全部既有，不改。
- **客户端**：`searchTargets({kind,q,venue,limit,cursor})`、`preview(target)`（请求体=target 本体）——既有，不改。
- **保存控制器**：正文与 references 同一 PUT 原子保存；重试载荷逐字节相同（S3/S4）；409 停写；`keep` 全量语义；预检 `assertReferenceSet`（marker 集合 == write id 集合）。
- **域工具**：`matchReferenceMarkerText`/`parseReferenceIds`/`assertReferenceSet`（单真源，扩展时复用）。
- **搜索协议**（§4.3 已冻结）：R1 切 kind 清 cursor；R2 q 变化清 cursor；R3 venue 变化清 cursor；R4 仅 limit 变化 cursor 可保留；R5 旧 cursor 400 → 前端提示刷新。

## 1. 交付分解（先红后绿）

| # | 模块 | 内容 | 状态 |
| --- | --- | --- | --- |
| A | 域工具 `studyNoteReferenceOps.ts` | `insertReferenceMarker`（光标插入+段落规范化）/`removeReferenceMarker`（行级删除+空行清理）/`replaceMarkerWithExcerpt`（marker→引文行）+ `excerptLinesFromSnapshot`（5 kind 全支持；marker 缺失显式 `ReferenceContractError`） | ✅ `663bdab`（19 例） |
| B | 编辑操作（hook 扩展） | `insertReference(target,preview,cursor)`（新 id、capture write、meta 预展示）/`removeReference(refId)`/`convertReferenceToExcerpt(refId)`——全部经 `applyEdit` 原子 patch | ✅ `9bf7310` |
| C | 搜索模型 `studyReferenceSearchModel.ts` | kind/q(防抖)/venue 清 cursor；limit 保留 cursor；分页去重；旧 cursor 400 可见并可刷新 | ✅ `663bdab`（8 例） |
| D | 组件 `StudyReferencePicker.tsx` + 卡片升级 | 面板（kind/q/venue/列表/加载更多/预览卡/插入）；`ReferencePlaceholder`→`StudyReferenceCard`（状态徽标+移除+转普通摘录） | ✅ `9bf7310` |
| E | 页面组装 | 编辑器"插入引用"入口（记光标）、卡片操作接线 | ✅ `9bf7310` |

## 2. 核心验收（Plan 指定）

- [x] 正文与引用**原子保存**（同一 PUT；插入/移除/转换后预检通过、无分叉保存）——E2E ①（capture 行 kind/source_id 库核）+ 组件"capture write 随保存提交"
- [x] **刷新重开一致**（保存后 reload/F5：marker、卡片、状态、计数一致）——E2E ①②③④ 均含 reload；组件"重开一致"用例
- [x] **current/changed/unavailable 正确**（changed 显示 liveTitle；unavailable 保留旧摘录、可 keep/移除/转换，禁止 re-capture）——E2E ①（current）/④（unavailable 被拒题目：显示已失效+旧摘录+可移除）；组件 changed/unavailable 对照用例
- [x] **409 与未知结果重试不丢引用**——组件"重试载荷逐字节相同（含 references）"（未知结果）；组件"09A 插入流×409"（冲突面板 + 本地两枚 marker 保留 + 复制本地内容含引用清单含新引用 + 不自动重试）；editor 既有 409 复制本地含引用清单契约保持

## 3. 测试计划与结果

| 层 | 文件 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| 域 | `tests/frontend/study-note-reference-ops.test.ts` | 插入（文首/文末/光标中间/空正文）、删除（含相邻空行）、转换（各 snapshot kind 引文生成）、预检全通 | ✅ 19 例绿 |
| 模型 | `tests/frontend/study-reference-search.test.ts` | R1–R5 + 分页去重 + 防抖 + 400 + venue 归属（source 下不发请求） | ✅ 8 例绿（含复核补修 1） |
| 组件 | `tests/frontend/study-note-reference-ui.test.tsx` | picker 全流程（搜索→预览→插入→marker+计数）、卡片（状态徽标/移除/转换）、重开一致性、重试逐字节相同、409 保留引用、**StrictMode 可用性/预览时效/插入时光标** | ✅ 12 例绿（含 409 与复核补修 3） |
| 保存 | 既有 save/editor 合同测试 | 含引用载荷重试逐字节相同；409 复制文本含引用 | ✅ 合同保持 |
| E2E | `e2e-study-notes/study-notes-reference-loop.spec.ts` | 真实 PG：搜索→预览→插入→保存→重开（marker+卡片）→移除→重开→转换→重开→库核 references 行；unavailable 被拒题目卡片与移除 | ✅ 4/4 绿（`D:/tmp/t09a-e2e3.log`） |

- 分层回归（5 文件：09A 三件 + editor/save 合同）：**96/96 exit 0**（`D:/tmp/t09a-fix-all.log`；复核补修前 92/92）。
- E2E 修正记录（先红后绿，测试问题为主）：① question seed 缺 `source_id` 违反 `l3_questions` identity_check → 挂 source；② 用例 ④ PUT 用了过期 `expectedVersion`（seed 命名已推进 v2）→ 动态取当前版本。

## 4. 收尾台账文字修正（随本批）

- [x] `study-notes-task08-closeout-2026-09-20.md`：删除重复的 `__待补__` 行（F1 占位）；探针终态计数 6/6 → **5/5（4 模型 + 1 UI）**（以 `t08c-final-probes.log` 实测为准）；提交链补至 `8321929`、HEAD 完整 SHA 更新为 `832192943496099e53b3330bd0d2e7fb85b925c2`。

## 5. 门禁与交付

### 5.1 浏览器 E2E（隔离 PG `vocab_study_notes_task08_accept` + 真实 Chromium）

- 全量（host 10 + reference-loop 4 + workspace 18）：**32/32 exit 0**（`D:/tmp/t09a-e2e-full.log`，3.4m）。reference-loop 单独复跑亦 4/4（`D:/tmp/t09a-e2e3.log`）。

### 5.2 工程门禁（快区 `C:/Windows/Temp/t09a-verify`@`6a679a4`；三 BASE_REF=PR base 完整 SHA `832192943496099e53b3330bd0d2e7fb85b925c2`）

- **聚合 `verify:engineering` 退出 1（如实保留，`D:/tmp/t09a-gate.log`）**：断点在 `test:unit` 的 coverage 收尾——`safe-delete` 拦截 `coverage\.tmp` 清理（280 文件 > 50 阈值，turn 预算窗口环境量）；链上 typecheck/arch:check 通过，且**vitest 本体全绿：255 文件（254 passed / 1 skipped）/ 3817 用例（3811 passed / 6 skipped，0 failed）**，覆盖率产物完整（`coverage-final.json`）。
- **分段证据（全部自然退出 0）**：coverage:layered=0 / test:collection=0 / db:schema:drift=0 / api:governance=0（含 route complexity ratchet passed；无 breaking）/ frontend:build=0 / runtime:verify=0 / alerting:verify=0 / release:acceptance:contract=0 / secret-rotation:evidence:contract=0 / release:workflow:verify=0 / complexity:routes=0。
- **coverage 口径（如实）**：`Diff coverage N/A — changed src files 5 (governed 0 / outside governed layers 5), changed executable lines 0`——本批为纯前端改动，不在受治理四层内；沿用前批口径，不以 N/A 记作通过亦不伪造覆盖率。

### 5.3 提交、推送与 PR

__待补（推送与 PR 更新后回填）__

## 6. 独立只读复核与补修（2026-09-20 晚）

独立复核（只读，对 `8321929..HEAD` 全 diff）：验收 4 条**全部符合**、冻结合同未破坏、无裸 fetch/分层违规；命中 1 个 P1 真实缺陷 + 3 个次要问题，全部先红后绿修复（`e7b91dc`）：

| # | 级别 | 问题 | 处置 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | **P1** | **StrictMode 双挂载使 picker 永久失效**：cleanup 对 ref 持有的模型 `dispose()`，重挂载不重建 → 全部 setter no-op、面板停在「正在搜索…」（dev 模式下功能不可用；生产构建与 E2E 不触发双挂载，故此前全局绿） | 挂载时按需重建（`ensureModel`）+ cleanup 卸下已处置实例；StrictMode 回归用例先红（3s 超时复现）后绿 | `StudyReferencePicker.tsx`；`study-note-reference-ui.test.tsx` StrictMode 用例 |
| 2 | 次要 | picker 打开期间移动光标不生效（用打开时快照） | 插入时读取 textarea 当前选区（不可用时回退快照） | 光标回归用例（位置 2 插入断言） |
| 3 | 次要 | 筛选变化后仍可插入过期预览 | kind/q/venue 变化即作废在途预览并清空预览卡 | 预览时效回归用例（切 kind + 改 q） |
| 4 | 次要 | source kind 下 `setVenue` 触发与请求无关的重复请求 | 仅记录筛选待用；切入 question 时随首屏携带（R3 语义限定为 question kind，文档同步） | 模型用例 R3b |

- 复核另注：同一目标可重复插入（不同摘录）——`l3_study_note_references` 无 (note,target) 唯一约束、服务端只校验 marker/id 集合一致，属**设计允许**，不拦截。
- 复核对测试质量的结论：409 用例为真断言（非假绿）；E2E 四场景逐条扎实并带 PG 库核；changed 的 liveTitle 由组件层覆盖（E2E 未单独覆盖 changed，作为已知覆盖边界记录）。
- 补修后：5 文件 **96/96 exit 0**、typecheck=0、前端重建 exit 0、全量 E2E 复验 **32/32**（`D:/tmp/t09a-e2e-full2.log`）。
