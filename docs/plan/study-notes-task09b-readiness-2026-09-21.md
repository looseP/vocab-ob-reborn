# Task 09B 开工准备 — 任务书（2026-09-21）

> 性质：**只读准备文档**。本轮不写任何 09B 功能代码，不合并、不 retarget、不部署、不推 main。
> 用途：为「卷面内学习笔记侧栏」提供可执行任务书、验收矩阵与实现边界。
> 本文所有文件路径与接口均取自被验收 SHA 的真实代码，未编造不存在的组件或接口。

---

## 1. 验收基线与依赖关系

### 1.1 代码基线（规范环境实测）

| 项 | 值 |
|---|---|
| 被验收代码 SHA（完整） | `8f48761cc0e88c59817ab6e033cb7b8f80a581b6` |
| 分支 | `task09a-unified` |
| 远端 `origin/task09a-unified` | `8f48761cc0e88c59817ab6e033cb7b8f80a581b6`（与本地一致） |
| 交付 PR | #130（draft，OPEN），head=`task09a-unified`，base=`study-notes-n1-task08` |
| PR #130 base SHA | `832192943496099e53b3330bd0d2e7fb85b925c2` |
| #129 | 旧交付入口，保持原状（draft/OPEN，head=`study-notes-n1-task09a`） |
| 运行时 | node `v22.22.2` / npm `10.9.7`（`.nvmrc=22.22.2`；engines `>=22.22.0 <23` / `>=10.9.0 <11`；packageManager `npm@10.9.7`） |
| 验收执行目录 | `D:/Temp/vocab-ob-n1-task08`（独占、clean、单执行者） |

依赖关系：`task09a-unified` ← base `study-notes-n1-task08`。**依赖链尚未合并到 main，本轮准入不以「先合并」为前提**；Engineering Gate / Browser E2E 属后续合并门禁，本轮不因未触发而记为通过。

### 1.2 规范环境证据（本轮）

- 完整工程门禁 `npm run verify:engineering`：**exit 0**（20 个阶段全跑，255 文件 / 3855 通过 / 6 跳过 / 0 失败）。
- 学习笔记专属 E2E：**43/43 通过，0 失败 / 0 跳过 / 0 重试**（同 SHA、同 Node/npm、独占构建与服务）。
- 历史证据（本轮未重复）：Writing E2E 通过；`verify:db` 全链通过（Node 22.22.2/npm 10.9.7）；默认 Playwright 预启服务 14 passed / 7 skipped。

### 1.3 偶发失败的口径（2026-09-21 校准）

09A 收口轮出现过**非确定性测试结果**：同一批用例在 `task09a-repair-result.json` 记 1 个失败、
在 `task09a-repair-review-result.json` 记 2 个失败，复查（隔离/延长超时后）通过。

- **口径：已观察偶发失败，复查通过，根因未确定。**
- **不得**写成「并发负载争用已证实」「非产品缺陷」——现有证据只支持「观察到非确定性」，不足以锁定系统层根因（`TASK09A-REPAIR-INDEPENDENT-REVIEW.md` 亦明确指出超时证据不足以单独证明系统层根因）。
- **不为此重开 09A**：09A 已按其自身门禁收口；本项仅作为 09B 的环境已知风险登记，遇到同形态失败时先记录原始证据再复查，不预判为产品缺陷、也不预判为环境噪声。

---

## 2. Task 09B 最小范围

**目标：在 L3 卷面（题纸）内，以侧栏形式打开/关闭学习笔记，并可完成「选择或显式创建笔记 → 从当前题目/素材发起引用 → 编辑与保存」。**

### 2.1 范围内

1. **卷面内打开/关闭学习笔记侧栏**（题目承载页 `L3ExamPaper` 内，不离开卷面）。
2. **选择已有笔记**，或**由用户显式创建笔记**（浏览/搜索/预览/取消一律零创建）。
3. **从当前题目/素材发起引用**——使用 09A 已冻结的 N1 引用合同（`searchTargets` / `preview` / `insertReference`），目标可预置为当前题或当前素材。
4. **复用 09A 编辑器、引用操作与保存控制器**（`useStudyNoteEditor` / `studyNoteSaveController` / `studyNoteReferenceOps` / `StudyReferencePicker`），不新建第二套。
5. **复用当前导航与离页保存屏障**（`useStudyNoteHistoryGuard` + `StudyNoteLeaveBarrier` + 卷面 `jumpBarrier`/`flushAnswers`）。

### 2.2 明确排除（本轮不做）

- Task 10 导出（含出处/摘录的 Markdown 导出）。
- N2：历史题纸/作答/评卷/作文稿次引用。
- agent 自动整理、自动掌握度、FSRS。
- 后端合同重设计（09A 合同冻结，09B 只消费）。

---

## 3. 必须保持的不变量

以下为**回归红线**，09B 实现不得违反：

1. **侧栏开关不卸载卷面**：开关侧栏不得卸载题纸、不得重建题纸保存控制器（`sheetSave`）、不得重复调用 `openSheet`（幂等草稿复用语义不得被打破）。
2. **不多建题纸、不丢作答**：侧栏操作全程不改变题纸数量、不新增题纸、不清空或覆盖已输入作答。
3. **不改变既有定格/导出屏障**：`jumpBarrier` → `flushAnswers()` → `ctrl.flush()` 的语义与拒答条件保持不变；定格（seal）流程不受侧栏影响。
4. **零隐式创建**：浏览、搜索、预览、关闭、取消均**不**隐式创建笔记或引用；只有显式动作才 `POST`（笔记创建）或写入引用集合。
5. **正文与引用原子提交**：正文与 references 通过**同一次 PUT** 保存（09A 原子保存合同）；`assertReferenceSet` 预检（marker 集合 == write id 集合）保持。
6. **未确认保存/409/IME 遵循既有协议**：
   - 未确认保存：`flush()` 必须确认到 `editSeq <= savedSeq && !inFlight` 才放行导航；
   - 409：停写、`conflict` 态、仅「复制本地内容」与「显式载入服务器版本」两条恢复路径，不自动合并、不强制覆盖；
   - IME：`composing` 期间拒答导航、不发送未完成快照。
7. **迟到请求不得污染**：迟到回包不得污染另一张题纸、另一题、另一篇笔记（每篇笔记/题纸有独立控制器与代际隔离）。
8. **已定格题纸仍只读**：`readOnly = sheet.status !== "draft"` 不变；笔记编辑权限**不**改变题纸状态（笔记可写 ≠ 题纸可写）。

---

## 4. 具体实现边界（依据实测代码）

### 4.1 关键事实：卷面当前**没有**学习笔记侧栏

经代码核对（**实测**，非推断）：

- `src/frontend/components/l3/L3ExamPaper.tsx`（2345 行）**未 import 任何 `studyNotes` 模块**。
- 卷面唯一相邻的侧栏是 `L3SourceNotesDrawer`（`L3ExamPaper.tsx:5` 导入，`:2160` 渲染），属**素材圈记/素材笔记**（只读，数据源 `GET /l3/sources/:id/space`），与学习笔记不是同一功能，**不得混用**。
- 学习笔记目前只有一个入口：`L3StudyNotesPage`（`/l3?section=study-notes`），由 shell section `"studyNotes"` 承载（`L3Page.tsx:280` 挂载）。从卷面区域点「学习笔记」tab 会**导航离开**卷面（`L3PapersPage.tsx:523-537`，`data-testid="venue-study-notes-tab"`）。

**结论：09B 是「净新增挂载」，不是「扩展现有开关」。** 不存在可复用的 `panelOpen` 状态；需要新增卷面级侧栏状态（最接近的同类先例是 `L3ExamPaper` 内的 `sealOpen` / `exportOpen`，以及编辑器内的 `showPicker`）。

### 4.1b 接口缺口清单（2026-09-21 校准，实测）

以下三项**当前并不具备**所声称的能力，不能被当作「已可复用」，实现时必须新写或明确降级：

1. **`StudyReferencePicker` 无预置目标 prop。** 实测 `StudyReferencePickerProps` 只有 `{ client, onInsert, onClose }`——**没有** `initialTarget` / `presetTarget` 之类入参。当前题/当前素材的快捷引用**不能**靠「传一个 prop」实现，需要新增入口（新增可选 prop，或由宿主先经 `client.preview(target)` 取预览再走既有 `onInsert`）。既有五种引用的兼容性以 `ReferenceTarget` / `ReferenceTargetPreview` strict 枚举为准。
2. **`L3Page` 的笔记屏障只在 `section === "studyNotes"` 时被调用。** 实测 `handleShellNavigate`（`L3Page.tsx:209-232`）的分支是 `if (section === "studyNotes") { …barrier… }`。卷面（`section` 为卷面/paper 而非 `studyNotes`）内的侧栏笔记**不会**经过该屏障。卷面侧的合成必须**另写**，不能假设 shell 已有覆盖。
3. **`L3ExamPaper` 无任何笔记接线。** 见 4.1；侧栏、屏障注册、引用入口三件都是净新增。

### 4.2 拟修改 / 新增文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/frontend/components/l3/L3ExamPaper.tsx` | 修改 | 新增侧栏开关状态与挂载点；布局改为可容纳侧栏 |
| `src/frontend/components/studyNotes/StudyNoteSidePanel.tsx` | **新增（拟）** | 卷面侧栏容器：笔记选择/列表 + 编辑器宿主；不重写编辑器 |
| `src/frontend/pages/L3StudyNotesPage.tsx` | 复用/抽取 | 复用其笔记列表、专题、创建与离页接线；如抽取共享组件需保持现有 E2E 行为不变 |
| `src/frontend/hooks/useStudyNoteEditor.ts` | 复用（不改合同） | 编辑器与保存控制器接线 |
| `src/frontend/state/studyNoteSaveController.ts` | 复用（不改） | 原子保存合同 |
| `src/frontend/components/studyNotes/StudyNoteEditor.tsx` | 复用 | 卷面内渲染同一编辑器 |
| `src/frontend/components/studyNotes/StudyReferencePicker.tsx` | 复用 | 引用选择；传入「当前题/当前素材」作为检索起点 |
| `src/frontend/viewModels/studyNoteNavigation.ts` | 可能修改 | 若侧栏需要新 URL 参数（如 `noteId` in paper context），须保持既有 `parseStudyNoteNavigation`/`buildStudyNoteUrl` 兼容 |

### 4.3 可复用接口（实测签名）

**保存控制器** `createStudyNoteSaveController(options)` → `StudyNoteSaveController`：

```
edit(snapshot): void;  markConfirmed(ids): void;  setComposing(value): void;
flush(): Promise<StudyNoteFlushReceipt>;  retry(): Promise<void>;
adoptServerSnapshot(dto): void;  getSnapshot(): StudyNoteSaveSnapshot;
subscribe(listener): () => void;  dispose(): void;  isDisposed(): boolean;
```

- `noteId` 在构造时传入且**不可变**（无 `setNoteId`）→ 切换笔记必须通过**重建控制器**实现，这与「侧栏开关不重建控制器」不冲突：开关侧栏不换 noteId，故不重建。
- 脏判定为派生量 `editSeq > savedSeq`。
- 防抖 800ms；退避 `[1000,2000,4000]`；`unknown`/`auth` 重试**逐字节相同**（复用 requestId）；409 → `conflict` 且停写。

**编辑器 hook** `useStudyNoteEditor({ noteId, client? })` 关键成员：

```
insertReference(target, preview, cursor): string | null;
removeReference(refId): boolean;  convertReferenceToExcerpt(refId): boolean;
requestNavigation(action): Promise<void>;  hasUnsavedChanges: boolean;
copyLocalContent(): Promise<CopyLocalResult>;  loadServerVersion(): Promise<void>;
onCompositionStart(): void;  onCompositionEnd(): void;
```

- 控制器生命周期绑定 effect deps `[noteId, loadNonce]`，cleanup 时 `dispose()`；StrictMode 双挂载安全。
- `reload()` 在控制器活跃时是 **no-op**（刻意不留「丢弃本地」后门）。

**离页屏障** `StudyNoteLeaveBarrier = (action: () => void | Promise<void>) => Promise<void>`：

- `StudyNoteEditor` 经 `onRegisterLeaveBarrier` 注册（`StudyNoteEditor.tsx:160-164`），cleanup 置 null。
- 卷面可复用同款模式：`L3Page.tsx:63-65` 的 `studyNotesLeaveRef` + `handleShellNavigate`（`:209-232`）已是「离开前经屏障」的既有接线。

**卷面自身屏障**（`L3ExamPaper.tsx`）：

- `flushAnswers()`（`:1396-1400`）→ `ctrl.flush()`；`jumpBarrier`（`:1441-1447`）失败即拒答并提示留页。
- `readOnly = sheet !== null && sheet.status !== "draft"`（`:1847`）；`interactionLocked = readOnly || actionLocked`（`:1849`）。

### 4.4 状态归属与生命周期

- **笔记状态**归 `useStudyNoteEditor`（内含 `StudyNoteSaveController`），按 `noteId` 隔离；卷面侧栏只做宿主，不持有笔记正文真源。
- **题纸状态**归 `L3ExamPaper` 的 `sheet` + `sheetSave` 控制器；两者**互不写入**。
- **侧栏开关状态**归 `L3ExamPaper`（新增），纯 UI 状态，不参与任何保存。
- **生命周期关系**（关键约束，2026-09-21 校准）：
  - 开关侧栏 → 侧栏容器挂载/卸载，**题纸不动**（题纸控制器 `sheetSave` 全程不被销毁、不被重建）；
  - **干净笔记**（`snapshot.state === "idle"`，无未确认内容）关闭 → **零写**，可直接卸载编辑器；
  - **脏笔记**（有未确认正文）关闭 → 必须经笔记屏障保存成功后才卸载/换身份；失败、`conflict`、IME `composing` 期间**保留编辑器与本地输入**（不卸载、不丢字）；
  - 切换笔记（换 `noteId`）→ 编辑器与**笔记**控制器**重建**（`noteId` 构造期不可变，无 `setNoteId`，既有语义），但**题纸不动**；
  - **允许笔记控制器随「已确认的关闭」而销毁**；**禁止**销毁题纸控制器（`sheetSave` 与 `sheet` 跨侧栏开关保持同一实例）；
  - 切题/切纸 → 走既有卷面导航与屏障；侧栏须在离页前完成自身笔记的 `flush`，否则拒答。

### 4.5 导航处理位置

- 卷面内导航：复用 `jumpBarrier`（`:1441-1447`）的拒答语义，**叠加**侧栏笔记的 `requestNavigation`；
- shell 级导航：`L3Page.handleShellNavigate`（`:209-232`）已是「离开前经屏障」；
- 关键新增点：**两个屏障的合成**——「侧栏笔记未确认」与「题纸作答未确认」都必须先落定才放行。这是 09B 最需要新写、也最需要测试的逻辑。

---

## 5. 验收矩阵

每行：触发操作 / 请求时序 / UI 断言 / 必要的数据库断言。
「库核」= 直连隔离验收库断言（不复用 `textarea.value` 或截图）。

| # | 触发操作 | 请求时序 | UI 断言 | DB 断言 |
|---|---|---|---|---|
| M1 | draft 卷面打开侧栏 | 无写请求 | 侧栏可见；题纸仍在；无 `POST /study-notes` | 题纸数不变；笔记数不变 |
| M2 | draft 卷面关闭侧栏再打开 | 无写请求（**干净笔记**：零写） | 题纸未卸载；无重复 `openSheet`；关闭后重开可重读最后选择的笔记 | 题纸数不变 |
| M2b | draft 卷面关闭侧栏（**脏笔记**：有未确认正文） | 关闭动作经笔记屏障 → 保存 `PUT` | 保存成功后才卸载编辑器；失败/冲突/IME 期间保留编辑器与本地输入 | 笔记落库为该次关闭前内容 |
| M3 | sealed 卷面打开侧栏 | 无写请求 | 侧栏可见；题纸只读态不变（「已定格」仍显示） | 题纸 `status='sealed'` 不变 |
| M4 | sealed 卷面编辑笔记并保存 | 仅笔记 `PUT` | 笔记保存成功；题纸无 PATCH | 笔记 version 递增；题纸行未被写 |
| M5 | 题纸有未保存作答 + 笔记有未保存正文，切题 | 先笔记 flush，再题纸 flush | 两者均确认后才导航；任一失败留页并提示 | 两者最终版本一致 |
| M6 | 切纸（换 sheet）时笔记保存挂起 | 迟到笔记回包 | 回包不写入新题纸上下文；无串写 | 新题纸无该笔记痕迹 |
| M7 | 切笔记 A→B 时 A 的回包迟到 | A 回包晚于切换 | A 的内容不写入 B 编辑器 | B 行未被 A 内容覆盖 |
| M8 | 显式创建笔记 | 恰 1 次 `POST` | 在途守卫：双击不并行创建 | 笔记 +1（不多建） |
| M9 | 浏览/搜索/预览/取消后关闭 | **零创建/零持久化写**；允许只读 `POST /api/l3/study-notes/reference-preview` | 全程无创建 | 笔记数不变 |
| M10 | 从当前题发起引用 → 插入 → 保存 → 重开 | `preview` → `PUT`（含 references） | marker + 卡片出现；重开后一致 | `l3_study_note_references` 行存在且 kind 正确 |
| M11 | 保存失败（**确定拒绝** `rejected`）→ 修正 → 重试 | **新 requestId** + 最新完整快照 + 最近已确认版本 | 可见反馈；重试提交最新内容 | 最终落库为修正后内容 |
| M12 | 未知结果（`unknown`/`auth`，响应丢失）→ 重试 | 载荷**逐字节相同**（同 payload/requestId/expectedVersion） | 不重复推进版本 | 版本只 +1 |
| M13 | 双标签 409 | 第二个 `PUT` 返回 409 | 冲突面板；本地保全；仅「复制/显式载入」 | 不自动覆盖服务器行；**不自动重放、不自动合并** |
| M14 | IME 组合中触发导航 | 组合期间无写 | 拒答导航；compositionend 后发送完整内容 | 落库为完整内容，且不发送未完成快照 |
| M15 | 反向引用/返回定位 | 读请求 | 返回定位到新笔记；题纸数量不增加 | 题纸数不变；无新题纸行 |

---

## 6. 明确排除

- **Task 10 导出**：含出处与摘录的 Markdown 导出，属独立交付。
- **N2 引用范围**：历史题纸、作答（attempt）、评卷、作文稿次引用，均为后续独立交付；N1 的 `ReferenceTarget` strict 枚举**不预留**任意 JSON 后门。
- **agent 自动整理**：不新增自动写笔记/自动归属能力。
- **后端合同重设计**：09A 合同（12 操作、5 表、原子保存、409/CAS 语义）冻结，09B 只消费不改。

---

## 7. 开工建议顺序（供 09B 执行轮参考，本轮不实施）

1. 先写「双屏障合成」的失败用例（题纸未确认 + 笔记未确认），再实现。
2. 再写「开关不卸载卷面 / 不重建题纸控制器 / 不重复 openSheet」的结构性断言。
3. 最后接引用入口（当前题/当前素材预置）与 M8–M10 的创建/引用零隐式创建断言。

---

## 附：本文证据来源

- 被验收 SHA：`8f48761cc0e88c59817ab6e033cb7b8f80a581b6`。
- 工程门禁与 E2E 原始日志：本轮执行环境 `D:/Temp/t09a-logs/`（`eng-gate-run2.log`、`group-a-host2.log`、`group-b.log`）。
- 代码路径与行号：均在本 SHA 的工作树中实测（`L3ExamPaper.tsx`、`L3Page.tsx`、`useStudyNoteEditor.ts`、`studyNoteSaveController.ts`、`studyNotesClient.ts`、`studyNoteNavigation.ts` 等）。
