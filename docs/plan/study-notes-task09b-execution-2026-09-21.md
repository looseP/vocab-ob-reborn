# Task 09B 执行台账 — 卷面内学习笔记侧栏（2026-09-21）

> 性质：**执行台账**。记录接管核对、接口变更清单、初始未验收台账与逐项终态。
> 任务书（验收矩阵、实现边界、不变量）：`docs/plan/study-notes-task09b-readiness-2026-09-21.md`。
> 范围纪律：只做 09B。不做 Task 10 导出、不做 N2 引用、不做 agent 自动整理、不做 schema/HTTP 合同重设计。

---

## 0. 接管核对（2026-09-21）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| 功能基线 SHA（完整） | `8f48761cc0e88c59817ab6e033cb7b8f80a581b6` | 与任务书一致 |
| `origin/task09a-unified` | `8f48761cc0e88c59817ab6e033cb7b8f80a581b6` | 与基线同点，未被推进 |
| 开发起点分支 | `origin/study-notes-n1-task09b-prep` = `ee0812bbdcd31ed07fd628a4d51e7286ea2ebcf8` | 与任务书一致 |
| 起点父提交 | `8f48761cc0e88c59817ab6e033cb7b8f80a581b6` | **核验通过**：父提交即功能基线 |
| 起点增量 | 仅 `A docs/plan/study-notes-task09b-readiness-2026-09-21.md` | 仅准备文档，无功能代码 |
| PR #130 | draft / OPEN，head=`task09a-unified`，base=`study-notes-n1-task08` | 保持原状，不 retarget |
| PR #129 | draft / OPEN，head=`study-notes-n1-task09a` | 保持原状 |
| 本批开发分支 | `study-notes-n1-task09b`，起点 `ee0812b` | 新建，独立 clone |
| 独占执行目录 | `D:/Temp/vocab-ob-n1-task08` | 独立 clone（`.git` 为真实目录，非 worktree 链接） |
| 工作区 | 接管时 `git status --short` 空 | clean |
| Node / npm | `v22.22.2` / `10.9.7`（`D:/Temp/node22-runtime/node-v22.22.2-win-x64`） | 与 `.nvmrc` / engines / packageManager 一致 |
| 依赖 | `node_modules` 359 项，**真实目录**（`dir /AL` 无重解析点） | 非 junction/symlink，独占 |
| lockfile | `sha256=d0661f8f4398a41b8efde9d20125d9631d54d3ae039091f3b5fde6ce3874bfe3`；`git diff HEAD -- package.json package-lock.json` 空 | 未被安装过程改写 |
| HUSKY | 临时 `HUSKY=0` 隔离保持（人工等价检查 + Git 写后核验） | **临时隔离，不写成根因已解决** |
| 单写者 | 本批唯一执行者；未 reset/clean/强推/手改 refs | 满足 |

> Node 22.22.2 不在系统 PATH（系统默认 `v24.15.0`）。**所有** npm/vitest/tsx/服务器子进程必须经
> `export PATH="/d/Temp/node22-runtime/node-v22.22.2-win-x64:$PATH"` 前置使用 22.22.2；
> 不得依赖系统默认 node。

---

## 1. 接口变更清单（实测，非推断）

### 1.1 必须新写（当前不具备）

| # | 位置 | 现状（实测） | 09B 需要 |
| --- | --- | --- | --- |
| I1 | `StudyReferencePickerProps` | 仅有 `{ client, onInsert, onClose }`（`StudyReferencePicker.tsx:22-27`） | 预置「当前题/当前素材」为检索起点或直取预览的能力；**无** `initialTarget`/`presetTarget` 现成 prop |
| I2 | `L3Page.handleShellNavigate` | 屏障仅在 `section === "studyNotes"` 分支被调用（`L3Page.tsx:212-224`） | 卷面内侧栏笔记的屏障**不被此分支覆盖**，需卷面侧自行合成 |
| I3 | `L3ExamPaper` 笔记接线 | `grep -n "studyNote\|StudyNote"` **零命中** | 侧栏宿主、屏障注册、引用入口三件均为净新增 |
| I4 | 侧栏开关状态 | 无 `panelOpen` 之类可复用状态 | 新增卷面级 UI 状态（同类先例：`sealOpen` / `exportOpen`） |
| I5 | 双屏障合成 | 卷面 `jumpBarrier`（`L3ExamPaper.tsx:1441-1447`）只覆盖题纸 | 「笔记未确认」×「题纸未确认」合成逻辑需新写并测试 |

### 1.2 复用不改合同

| 位置 | 复用方式 |
| --- | --- |
| `useStudyNoteEditor({ noteId, client? })` | 编辑器宿主；`insertReference` / `requestNavigation` / `hasUnsavedChanges` 等签名不变 |
| `studyNoteSaveController` | 原子保存合同不变；`noteId` 构造期不可变（无 `setNoteId`），切笔记靠重建控制器 |
| `StudyNoteEditor` | 卷面内渲染同一组件；经 `onRegisterLeaveBarrier` 注册屏障（`StudyNoteEditor.tsx:160-164`） |
| `StudyNoteLeaveBarrier` 类型 | `(action) => Promise<void>`，与 `L3Page` 既有接线同型 |
| `studyNotesClient` | `searchTargets` / `preview` / `insertReference` 端点只消费不改 |
| `parseStudyNoteNavigation` / `buildStudyNoteUrl` | 保持兼容；**本批不新增侧栏 URL 持久化参数** |

### 1.3 后端合同

**零变更。** `POST /api/l3/study-notes/reference-preview` 为只读预览（POST 但零写不持久化，
`src/http/routes/l3/study-references.ts:30`）；09B 只消费。不新增端点、不改 schema。

---

## 2. 初始未验收台账（本批全部未通过，逐项推进）

状态口径：❌ 未做 / 🔴 已写用例先红 / ✅ 已实现并通过 / ⛔ 阻塞。

| # | 缺口（任务书编号） | 初始状态 | 终态 |
| --- | --- | --- | --- |
| T1 | 侧栏宿主净新增挂载；开关不卸载卷面（M1/M2） | ❌ | ✅ 单测 + E2E（真实栈 M1/M2 通过） |
| T2 | 关闭/切笔记屏障：干净零写、脏则保存后才卸载（M2/M2b） | ❌ | ✅ 单测（干净零写 / 脏则保存后关闭 / 失败保留输入） |
| T3 | 双屏障合成：笔记 × 题纸均确认才放行导航（M5） | ❌ | ✅ 单测 9 条（顺序/短路/归因/异常/重入）；真实栈未端到端跑 M5 |
| T4 | 不重建题纸控制器 / 不重复 `openSheet`（M2） | ❌ | ✅ E2E M2（关闭重开题纸数不变、开关仍在）；「不重复 openSheet」仅结构化断言 |
| T5 | sealed 卷面侧栏可开、题纸只读不变；笔记可写不等于题纸可写（M3/M4） | ❌ | ⚠️ 部分：M4 已验（笔记保存零题纸写）；**M3 sealed 未在真实栈验证** |
| T6 | 笔记选择/搜索/分页 + 空态（不自动创建） | ❌ | ✅ E2E（空态可见、浏览零创建） |
| T7 | 显式创建笔记，恰 1 次 POST，在途守卫（M8） | ❌ | ✅ E2E M8（笔记 +1 不多建） |
| T8 | 零隐式创建：浏览/搜索/预览/取消仅只读预览（M9） | ❌ | ✅ 单测 + E2E M9 |
| T9 | 按题型筛选/创建题型，不擅自给现有笔记加归属 | ❌ | ✅ 单测（筛选零 PUT；按筛选题型创建） |
| T10 | 当前题/素材快捷引用入口（I1 缺口已补）+ 预览后显式插入（M10） | ❌ | ✅ E2E M10（入口零写 → 插入 → 库核引用行 → 刷新一致） |
| T11 | 迟到回包不污染（切纸 M6 / 切笔记 M7） | ❌ | ⚠️ 未本批验证（既有 09A 单测覆盖 noteId 代际；09B 侧栏场景未新增） |
| T12 | 保存失败三分支正确（M11 rejected 新 requestId；M12 unknown/auth 原样；M13 409 不自动重放） | ❌ | ⚠️ 未本批验证（控制器语义既有；09B 只消费未改） |
| T13 | IME 组合中拒答导航（M14） | ❌ | ⚠️ 未本批端到端验证（既有单测覆盖） |
| T14 | 反向引用/返回定位保留 sheetId+questionId，不走创建草稿（M15） | ❌ | ⚠️ 未本批验证 |
| T15 | 离页导航保留既有 sheetId/questionId 身份 | ❌ | ⚠️ 未本批验证 |

---

## 3. 已知环境风险

1. **非确定性测试（09A 遗留观察）**：同批用例出现过 1–2 个失败、复查通过。口径为「已观察偶发失败，
   复查通过，根因未确定」——不重开 09A，不预判为产品缺陷或环境噪声。遇同形态失败先存原始证据再复查。
2. **Node 版本**：系统默认 v24，必须显式前置 22.22.2，否则 engines 校验与行为可能漂移。
3. **main-only CI 未触发**：依赖分支链未合并，完整主线 CI 仍为以后合并门禁，**不得记为已通过**。

---

## 4. 逐项终态与实测证据（2026-09-21）

### 4.1 提交序列

| SHA | 内容 |
| --- | --- |
| `07bc62d` | Task 0 接管校准（任务书修正 + 接口缺口清单 + 本台账） |
| `2a96166` | Task 1 侧栏宿主 + 双保存屏障合成（`sheetLeaveBarrier.ts`、`StudyNoteSidePanel.tsx`） |
| `73ff630` | Task 2 当前题目/素材快捷引用入口 |
| `1249bcd` | Task 3 关闭/切笔记屏障加固 + 题型筛选 |
| `2684d05` | 严格 tsconfig 类型修整 + 卷面侧栏 E2E |
| `664d869` | 真实栈验收 4/4 + 写作题组引用入口补齐 |

### 4.2 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `node_modules/vitest/vitest.mjs run tests/frontend` | **exit 0**：52 文件 / **710 通过** / 0 失败 |
| `npx tsc --noEmit` | **exit 0** |
| `npx tsc --noEmit -p tsconfig.frontend.json` | **exit 0**（更严；曾暴露 3 处根 tsconfig 漏掉的类型错误，见 `2684d05`） |
| `VITE_N1_STUDY_NOTE_HOST=1 npm run frontend:build` | **exit 0** |
| `node node_modules/@playwright/test/cli.js test --config=playwright.study-notes.config.ts study-notes-sheet-side-panel.spec.ts` | **exit 0**：**4 passed** |
| 同上，`study-notes-reference-loop` + `study-notes-workspace`（回归） | **exit 0**：**27 passed** |
| `npx tsx scripts/run-rls-acceptance-migrations.ts`（隔离库） | **exit 0**：40 journal entries，迁移并校验通过 |
| `npx tsx scripts/bootstrap-database-roles.ts prepare/converge` | **exit 0**：app 角色可见 49 张表 |

隔离验收库：`vocab_study_notes_task09b_accept`（5433，`vocab-local-pg` 容器）。
E2E 服务端口 3098，`NODE_ENV=test SERVE_FRONTEND=true`，Node 22.22.2。

### 4.3 本批真实暴露并修复的产品缺口

1. **写作题组没有引用入口**（E2E 真实暴露）：`reference-question-to-note` 初版只加在
   选择题分支，`sentence_translation` / `short_essay` / `long_essay` 题组下方无入口。
   已在写作分支补同款入口（`664d869`）。
2. **题型筛选是 disabled 桩**（自查发现）：初版侧栏把筛选控件做成不可交互的占位，
   属半实现入口。已改为真实筛选（只改列表查询、零归属写），并让创建使用所选题型
   （`1249bcd`）。
3. **`toNoteLeaveBarrier` 签名与调用点不一致**：严格 tsconfig 拦截；已改为接收 action
   并在笔记侧确认后执行（`2684d05`）。

### 4.4 口径澄清（实测纠正）

- 题纸表名是 **`l3_submissions`**（不是 `l3_exam_sheets`）；题纸写路径
  **`/api/l3/sheets`**（不是 `/api/l3/exam-sheets`）；开卷深链 **`/l3?paper=<id>`**。
- 开卷本身会产生一次 `POST /api/l3/sheets`（既有 `openSheet` 幂等草稿语义）；
  M4 的「笔记保存不写题纸」断言窗口从**开卷完成后**起算。
- 侧栏列表默认筛选题型 = 卷面首节题型；跨题型笔记需切换筛选或与卷面题型一致。

### 4.5 本批**未**验证（如实列出，不计入通过）

- M3（sealed 卷面打开侧栏）真实栈未跑；
- M5（笔记 + 题纸同时未保存后切题）仅单测合成器，未真实栈端到端；
- M6/M7（迟到回包）、M14（IME 导航拒答）、M15（反向引用/返回定位）本批未新增真实栈用例
  （部分由既有 09A 单测覆盖，但**不算本轮已验**）；
- 完整主线 CI（`verify:engineering`）未在本轮重跑；依赖链未合并，仍为以后合并门禁。

