# Task 09A 引用确认与 Markdown 操作补修 — 台账（2026-09-21）

> 本批起点（审查对象）：`1801761264868a8b63a115b282d51bb1e1accf1d`（分支 `study-notes-n1-task09a`，
> 实际执行目录 `D:/Temp/vocab-ob-n1-task08`）。审查报告：
> `D:/Temp/Myawesomeapp/vocab-ob'/build-analysis/status-2026-09-21/TASK09A-INDEPENDENT-REVIEW.md`。
> 范围：**只做 R1–R4 与其验收，停在 Task 09B 前**。不合并、不 retarget、不部署、不推 main、不开导出/N2。

## 0. 接管与现状核对（2026-09-21）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| 实际执行目录 | `D:/Temp/vocab-ob-n1-task08` | 与审查一致 |
| 分支 | `study-notes-n1-task09a` | 审查所指「独立分支」即此分支，**不切回 Task08** |
| 本地 HEAD | `1801761264868a8b63a115b282d51bb1e1accf1d` | 与审查 HEAD 一致 |
| 工作区 | `git status --porcelain` 空 | clean（无既有未保全变更，无需保全动作） |
| `git fsck` | exit 0（2 个 dangling commit：`d1f0320`/`a8fd892`） | 不构成损坏，不清理 |
| `origin/study-notes-n1-task08` | `832192943496099e53b3330bd0d2e7fb85b925c2` | PR #129 base 未变 |
| `origin/study-notes-n1-task09a` | `1801761264868a8b63a115b282d51bb1e1accf1d` | 与本地一致，无需强推 |
| 单写者 | 本轮唯一执行者；未 reset/clean/强推/手改 refs | 满足 |
| HUSKY | 临时 `HUSKY=0` 纪律保持（人工等价检查 + Git 写后核验） | **临时隔离，不写成根因已解决** |

### 0.1 基线复现（先红）

用审查复跑命令实测 `1801761`：

```
node_modules/vitest/vitest.mjs run --config <task09a-review.config.mjs> --reporter=verbose
→ Test Files 1 failed | 5 passed (6)
→ Tests 6 failed | 96 passed (102)，进程 exit 1
```

- 原五文件 **96/96 通过**，新增六探针 **6/6 失败**；无编译/导入失败。
- 与审查报告完全一致（`TASK09A-INDEPENDENT-REVIEW.md` §对象与验证边界）。
- **本轮新增缺口在下方逐项登记，未通过项一律不预填。**

## 1. 缺口登记（本轮待补，初始全部未通过）

| # | 级别 | 缺口（审查编号） | 初始状态 | 终态 |
| --- | --- | --- | --- | --- |
| R1 | P1 | 保存确认后 capture 未转 keep；普通编辑重采集来源快照/时间 | ❌ 探针 1 红 | ✅ 已修（`markConfirmed` 本地簿记，无多余 PUT） |
| R2 | P1 | 保存响应 references 被丢弃；未确认预览冒充已保存快照并允许转换 | ❌ 探针 2/3 红 | ✅ 已修（确认 DTO 回填 + `confirmed` 区分） |
| R3 | P2 | 删除/转换逐行 `trim` 定位，误改代码示例中的同形 marker | ❌ 探针 4/5 红 | ✅ 已修（`token.raw` 原始区间定位） |
| R4 | P2 | 光标在围栏代码内插入生成不可保存引用（无拒绝、无反馈） | ❌ 探针 6 红 | ✅ 已修（`ReferenceMarkerPositionError` + 可见反馈） |


## 2. 处置记录（先红 → 实现 → 后绿）

### 2.1 R1 —— 确认后 capture → keep

- **先红**：读审查探针 1 复现：插入 → 确认 → 仅改标题，第二次 PUT 仍为 `capture`。
- **实现**：
  - `studyNoteSaveController.ts`：`StudyNoteSaveResult.references?`、`StudyNoteConfirmedSnapshot`、
    `onConfirmed` 回调（**仅真实成功确认**触发；unknown/rejected/auth/409 都不触发），
    新增 `markConfirmed(ids)` —— 只改**本地簿记**，**不推进 editSeq、不多发 PUT**；
  - `useStudyNoteEditor.ts`：`applyConfirmedReferences` 是**只升级、不删除不回退**的合并：
    仅把「本次确实作为 capture 提交且仍在编辑集合中」的引用转 keep（在途新增的 B 保持
    capture；已移除的 A 不复活；正文永不改写）。
- **后绿**：`study-note-reference-confirmation.test.tsx` 4 例 + `study-note-save.test.ts` 4 例；
  旧代码上 8 例全红（见 §4 变异/回退验证），新代码全绿。

### 2.2 R2 —— 正式快照回填与转换纪律

- **先红**：探针 2/3 红（保存响应 references 被丢弃；未确认预览可直接转换）。
- **实现**：
  - 保存成功把 `saved.references` 经 `onConfirmed` 回传，按引用身份合并；
  - `StudyNoteReferenceMeta = ReferencePreview & { confirmed }`：`confirmed: true` 只来自
    服务端 DTO（GET / 保存响应）；插入时 `confirmed: false` 且 **`capturedAt` 为空串**
    （本机时间不冒充服务端 capture 时间）；
  - 卡片：未确认显示「待确认」徽标（`data-ref-confirmed="pending"`）、转换按钮 `disabled`；
  - `convertReferenceToExcerpt` 只消费已确认快照，未确认返回 false 并给可见原因。
- **后绿**：组件 3 例（预览→确认替换、未确认禁转、确认后消费服务端快照）+
  确认套件字段级断言（服务端值生效、预览值不残留）。

### 2.3 R3 —— 完整 Markdown 顶层语义定位

- **先红**：探针 4/5 红（逐行 `trim` 命中围栏代码内同形示例，改坏示例、留下真 marker）。
- **实现**：`locateMarkerRange` 用 `lexer` 顶层 token 的 `token.raw` **按序推进**定位原文区间
  （不用 `indexOf` 猜偏移，避免同名文本在代码块中时定位错位）；删除/转换只替换该区间。
  空行整理只消费**一侧**（不吞两侧、不粘连相邻块）。
- **后绿**：ops 套件新增 7 例（围栏/缩进/列表/引用块/相邻引用/大写归一），全绿。

### 2.4 R4 —— 插入的安全定位与明确拒绝

- **先红**：探针 6 红（光标在围栏代码内插入 → 生成不可保存正文）。
- **实现**：`insertReferenceMarker` 解析完整文档后判定光标所在顶层 token：
  容器（代码块/列表/引用块/表格/HTML/标题）内或既有 marker 段落内 → 抛
  `ReferenceMarkerPositionError`；结果再用真实 lexer 复核「恰为独立顶层段落」，
  不满足同样拒绝。hook **在提交前**用 `assertReferenceSet` 复核，失败即拒绝且
  **本地状态完全不变**；`referenceError` 提供可见原因（组件 `reference-error` 横幅）。
- **后绿**：ops 4 例 + 组件 1 例（代码块内插入被拒、正文/计数不变、有可见反馈）。

## 3. 测试与验收证据

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 审查探针套件（6 文件） | `vitest run --config task09a-review.config.mjs` | 探针 6/6 由红转绿；原五文件 96/96 保持 |
| 前端分层回归（13 文件） | `vitest run tests/frontend/study-note-* study-notes-* study-reference-*` | **241/241 exit 0** |
| domain + service + api | `vitest run tests/domain tests/services/l3-study-notes.test.ts tests/api` | **356/356 exit 0** |
| 浏览器 E2E（隔离 PG `vocab_study_notes_task08_accept` + Chromium） | `playwright test --config playwright.study-notes.config.ts` | **37/37 exit 0**（原 33：host 10 + workspace 18 + reference-loop 原 5；**新增 reference-loop 4**） |

新增回归用例（共 21 例，均可先红后绿）：
- `tests/frontend/study-note-reference-confirmation.test.tsx`（新，4 例）：keep 不再重采集、
  服务端快照替换预览、未确认禁转、**A 在途新插 B 的交错**；
- `tests/frontend/study-note-save.test.ts`（+4 例）：确认回调载荷/元数据、`markConfirmed`
  不推进 editSeq 不多发 PUT、未确认引用不被他人确认转 keep、未知结果不触发确认且重试载荷
  逐字节不变；
- `tests/frontend/study-note-reference-ops.test.ts`（+10 例）：R3 代码块/缩进/列表/引用块、
  相邻引用；R4 容器内拒绝、marker 内拒绝、合法插入、空行边界；
- `tests/frontend/study-note-reference-ui.test.tsx`（+5 例）：R1 keep、R2 预览替换、
  未确认禁转（按钮 disabled + pending 标记）、确认后转换、R4 拒绝可见反馈。

E2E 新增 4 场景（库核）：
- ⑥ 确认后仅改标题 → keep，库内 `display_snapshot`/`field_hash`/`captured_at` **逐字段不变**；
  再改来源正文 → changed + liveTitle，快照与时间仍不变；
- ⑦ 代码块内同名 marker 与真实卡片并存 → 移除只动真实段落，代码原文不变、保存/F5 正常；
- ⑧ 预览取得后来源变化 → 真实 capture 保存**新**快照；确认后页面**无需 F5** 即展示新内容；
- ⑨ 代码块内插入被明确拒绝 → 可见反馈、正文与引用计数完全不变、随后仍可正常保存。

## 4. 变异与回退验证（证明新用例确有鉴别力，且不提交变异）

| 变异 | 预期 | 实测 |
| --- | --- | --- |
| 取消 `capture → keep`（注释掉 `markConfirmed` 调用） | 新增 keep 用例变红 | ✅ 红（确认套件 2 例） |
| 把 `removeReferenceMarker` 退回逐行 `trim` 定位 | R3 用例变红 | ✅ 红（含 R3 全套） |
| 两者同时施加 | 至少 R1+R3 变红 | ✅ **12 failed / 42 passed** |

- 全部源码与测试随后**完整回退**：`MUTATION` 标记计数 = 0，`tsc --noEmit` exit 0，
  4 文件 **92/92 exit 0**。变异未提交。

## 5. 未覆盖项与遗留（如实登记，不记作通过）

1. **picker 头部「关闭」按钮几何点击不可用**（Playwright `click`/`dispatchEvent` 均超时；
   元素在 DOM 中可见）。已在**未经本批改动的基线**上复现同样现象 → **预存在 UI 缺陷，
   不属 R1–R4 范围**，本批未修（避免扩大范围）。E2E ⑨ 因此改用面板内「取消」清空预览来
   证明「拒绝后无残留、保存通道仍可用」。建议单独开条目处理。
2. 审查探针 2 使用整对象 `toEqual(stored.references[0])`，与新增的 `confirmed` 显式标记
   形状不同。该探针的**意图**（服务端快照/时间替换预览）已由新确认套件**按字段**完整断言
   （`capturedAt`/`displaySnapshot`/`liveTitle`/`status`/`target` + 预览值不残留）。
   未改写审查方的只读探针文件。
3. 本轮不要求实时轮询来源状态（仅正确消费已取得的确认 DTO）；自动刷新为后续范围。

## 6. 工程门禁（三 BASE_REF = PR base 完整 SHA `832192943496099e53b3330bd0d2e7fb85b925c2`）

先提交 `47b1e2f`，再按 committed diff 运行；**分段全部自然退出 0**：

| 步骤 | 退出码 | 备注 |
| --- | --- | --- |
| `typecheck` | 0 | |
| `arch:check` | 0 | 无分层违规 |
| `test:collection` | 0 | **256/256**（较 09A 的 255 增 1：新增确认套件） |
| `coverage:layered` | 0 | domain 98.18 / service 95.11 / repository 93.83 / http 91.67，四层均 PASS |
| `api:governance` | 0 | |
| `db:schema:drift` | 0 | |
| `runtime:verify` | 0 | |
| `alerting:verify` | 0 | |
| `frontend:build` | 0 | |
| `release:acceptance:contract` | 0 | |
| `secret-rotation:evidence:contract` | 0 | |
| `release:workflow:verify` | 0 | |

- **聚合 `test:unit`（`vitest run --coverage`）如实退出 1**：**3848 用例 / 2 failed**，
  两例均为 `tests/scripts/`（`compose-database-role-routing`、`generate-openapi-client`）
  的 **30s 超时**，非断言失败；同机隔离复跑（`--testTimeout=120000`）**7/7 passed** →
  环境性超时，与本批改动无关（本批未触及 compose/OpenAPI 生成）。
- 排除上述两例后重跑 coverage：**exit 0**，254 文件（253 passed / 1 skipped）、
  **3835 passed / 6 skipped / 0 failed**，`coverage-final.json` 正常产出。
- **Diff coverage 口径（如实）**：`N/A — changed src files 6 (governed 0 / outside governed layers 6),
  changed executable lines 0`。本批为纯前端改动，不在受治理四层内；**不以 N/A 记作通过，
  也不伪造前端增量覆盖率**。若复用改动涉及 domain 层则相应层已由 `coverage:layered` 覆盖（本批为 0）。

## 7. 提交与推送

- 提交：`47b1e2f`（本批唯一功能提交，含源码/测试/台账）。
- 推送：普通快进推送当前分支 `study-notes-n1-task09a`；更新既有 draft PR **#129**
  （base 仍为 `study-notes-n1-task08@832192943496099e53b3330bd0d2e7fb85b925c2`，未 retarget）。
- 推送实测：`1801761..bb01252`（普通快进，无强推）；**local == ls-remote ==
  `bb01252aeb21a8ddcbb4d4c38f891078d65176ba`**（Git 写后核验）。
- PR **#129**：draft / OPEN / base `study-notes-n1-task08`（**未 retarget**）/
  head=`bb01252`；描述已补「补修 R1–R4」章节（含验证、门禁、遗留）。
- **CI（只读查询，终态 head `bb01252`）**：`Writing E2E` = **in_progress（pending，不记绿）**；
  `Engineering Gate` / `Browser E2E` 为 main-only，本 PR base 不触发（如实说明，不冒充通过）。
- 停在此处：**不进入 Task 09B**，不合并/不部署/不推 main/不开导出与 N2。
- 推送注意：本机 git 全局代理 `127.0.0.1:17891` 当时不可达，本次推送以
  `git -c http.proxy= -c https.proxy=` 绕过（直连 GitHub 正常）；**未修改仓库/全局代理配置**。
