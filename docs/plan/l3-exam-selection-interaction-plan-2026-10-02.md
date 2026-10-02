# L3 试卷台做题交互重构与保序性修复 · 深度执行 Plan（含实施结果）

日期：2026-10-02
基线：`origin/main@c1a8136`
分支：`feat/l3-exam-selection-refactor`
提交：`19da3e7`（11 文件，+1364 / -91）

本文件是对外派启动 Prompt 里那份《深度执行 Plan》的**校验 + 实施记录**。
原始 Plan 的方向判断成立，但**代码锚点已过时、根因链缺一环、门禁命令有误**，
勘误见 §2 —— 后续同类外派应先读本节再动手。

---

## 1. 结论先行

| 项 | 状态 |
|---|---|
| BUG-01 完型空号乱序（P0） | 已修（快照保序），新增 2 例失败单测先红后绿 |
| BUG-01b 存量 draft 题纸乱序（P0 衍生） | 已修（开纸时自愈校正题序）；真库实测用户那张卷正命中此缺陷 |
| UX-02 缺乏就近绑定（P1） | 已实现（`examProximityBinding` 纯函数引擎 + 卷面一键建分析） |
| UX-03 浮层倒挂 / 双浮层遮挡（P1） | 已修（`selectionPanelPosition` 纯函数 + 卷面改常驻停靠区） |
| UX-04 侧栏吞噬 200px（P2） | 已实现（`L3Shell` 收折为 48px mini rail） |
| 门禁 | 双 tsc 零错误；depcruise 480 模块 0 违规；`vitest run tests/frontend tests/services` 132 文件 / 2258 例全绿 |
| 真机验收 | **未做**（见 §6.3 未覆盖项） |

---

## 2. 对原始 Plan 的勘误（先读这里）

| # | 原始 Plan 的说法 | 实测 |
|---|---|---|
| 1 | 锚点 `l3-sheets.service.ts:101-111`、`L3ExamPaper.tsx:471-476 / 527-543` | **行号全部过时**。该文件已 2787 行且这些行已移位；按行号检索会读到无关代码。**只认符号名，不认行号。** |
| 2 | 根因只写「未按原卷顺序重排，直接存入快照」 | 成立但**缺一环**：乱序能传到题号，是因为前端 `examTypes.ts` 的 `scopePaperToFrozenList` 会拿快照当 `rank` **重排卷面**。即链条是两跳：`openSheet` 冻结物理序 → 前端按快照 rank 重排 ⇒ 题号错位。只修前端没用。 |
| 3 | 门禁命令 `npm run arch:check` / `npm run verify:route-complexity` | 前半对（`arch:check` 存在）；后半**命令不存在**，真名是 `npm run complexity:routes`。 |
| 4 | 「容器内执行 `vitest run tests/frontend/exam-*.test.ts tests/services/l3-sheets.test.ts`」 | 可行，但前端全量应是 `vitest run tests/frontend tests/services`（134 文件 / 2271 例，容器内 ≈52s）。 |
| 5 | 「layered-coverage（>=85%）」 | 真实命令是 `npm run coverage:layered`（`scripts/report-layered-coverage.ts`），且**必须先有覆盖率产物**（`vitest run --coverage`），裸跑读的是陈旧报告 —— 这坑在 facts §9.8 已登记过一次。 |
| 6 | `verify:route-complexity` 作为必过门禁 | 该脚本 `spawnSync("git", …)`，而 `vocab-observatory-v2-migration:local` 与 `vocab-observatory-v2:local` **都没有 git 二进制** ⇒ 容器内必然 `Invalid route complexity base ref HEAD^`。这不是代码问题（facts §9.10 同款）。**替代取证**：`git diff --name-only origin/main -- src/http/routes \| wc -l` = 0，本改动未触任何路由文件，棘轮不受影响。 |
| 7 | 外派 Prompt 里「工程根路径 `F:\dev\vocab-ob\wt-main`，工作区是空壳」 | 正确，保留。 |
| 8 | 未提到的一点 | `feat/undo-stack-and-session-resilience` 是**未推送的栈式分支**。若直接在其上开新分支，`git diff origin/main...HEAD` 会带上别人的提交。已按 §7 的方式改到 `origin/main` 基线上。 |

---

## 3. 根因分析（修订版）

| 编号 | 现象 | 真实代码锚点（符号级） | 根本原因 | 严重度 |
|---|---|---|---|---|
| BUG-01 | 完型 20 空在下拉/题卡里呈 `1,17,16,20…` 乱序 | `src/services/l3-sheets.service.ts` → `openSheet`（paper 分支）；`src/repositories/l3-paper.repository.ts` → `findActiveQuestionsByIds`；`src/frontend/components/l3/examTypes.ts` → `scopePaperToFrozenList` | SQL `WHERE id = ANY($2::uuid[])` **不带 ORDER BY** → 磁盘物理序；旧代码 `active.map(q => q.id)` 把物理序冻结进 `question_ids`；前端再拿快照当 `rank` 重排 ⇒ 题号错位 | **P0** |
| UX-02 | 划词后要在 20 项长列表里人肉找题 | `L3ExamPaper.tsx` → `PassageBody.handleMouseUp` / `annotate` 选择器 | 捕获只记鼠标坐标，不知道选区落在哪个空位；而空位就在选区的字符区间里，属**已知事实** | P1 |
| UX-03 | 浮条倒挂飞出视口、遮住吸顶章节导航；与全局划词翻译浮层互相遮挡 | `L3ExamPaper.tsx` 三处 capture bar（正文/题干/选项）；`SelectionTranslatePopover.computePosition` | 定位写法是 `top: max(y-8, 72)` 之后再 `translateY(-100%)` —— **夹取先于位移 ⇒ 夹取失效**；且卷面自己又弹一个贴选区浮层，与 PR #175 的全局翻译浮层同时出现在正文上 | P1 |
| UX-04 | 做题 15~60 分钟期间侧栏恒占 200px | `src/frontend/components/L3Shell.tsx`、`src/frontend/styles.css` | 外壳无收折能力；卷面是左文右题双栏，200px 从两栏里各抠一块 | P2 |
| BUG-01b | 代码修好后**已开的 draft 纸仍然乱序** | `l3-sheets.repository.ts` → `openSheet`（幂等复用不覆盖快照）；`l3-sheets.service.ts` → `openSheet` | 开纸幂等：作用域键冲突时复用既有 draft 行且**不重算** `question_ids`（契约是「题单以首次开纸为准」）。于是修前冻结的物理序**永不刷新**，用户看不到修复效果 | **P0 衍生** |

## 3.1 真库证据（2026-10-02，本地 compose 的 postgres）

不是推测 —— 用户报障的那张卷确实存在乱序快照，且**只有第 1 个位置恰好正确**：

```
l3_submissions 5 行（全部带快照）/ l3_papers 2 张 / l3_questions 49 道
```

| 题纸 | 卷 | status | 快照长度 | 与卷面逐位相同的位置数 | 集合相同? |
|---|---|---|---|---|---|
| `257f2a4f…` | L3 链路验证卷 2026-09-29 | sealed | 1 | 1 | ✓ |
| `e26f35da…` | L3 链路验证卷 2026-09-29 | draft | 1 | 1 | ✓ |
| **`8abcc59a…`** | **2025 年全国硕士研究生招生考试 · 英语（二）试题** | **draft** | **48** | **1** | ✓ |

该卷题型分布：`cloze 20` / `reading_choice 20` / `new_question 5` / `sentence_translation 1` / `short_essay 1` / `long_essay 1`
—— 正是截图里完型 20 空乱序的那张卷。第 1 位起即错位：快照首项 `1106143f…`，卷面首项 `14ed99a5…`。

补充核对：卷面 48 个 id **全部 active**（去重后仍 48），因此服务端按 active 过滤后的长度与快照长度相等
⇒ 自愈校正的判据（集合相同、顺序不同）**会命中**，不需要人工改库。

### 3.2 存量自愈的边界（为什么敢在 openSheet 里写）

`needsQuestionOrderRealign`（`src/domain/l3-sheets.ts`）三条同时成立才允许校正：
① 集合完全相同（少题/多题一律不动 —— ADR「题单只缩不换」是红线）；② 顺序确实不同（避免每次开纸都打无谓 UPDATE）；
③ 两者非空。仓储层 `realignQuestionIdsOrder` 把集合判据与 `status='draft'` 再写进 SQL 谓词
（`question_ids @> $3 AND question_ids <@ $3`），读-写之间有并发变更（题组加题、定格）时命中 0 行 ⇒ fail-closed，
**已定格快照天然不可改**。

真库探针（事务内真 UPDATE + 真校验 + `ROLLBACK`，数据未被改动）：
`UPDATE 1` → 该行 48 题、与卷面**逐位一致**（`exact_order = t`）。

---

## 4. 目标架构（实际落地形态）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 卷面顶栏：卷名 · 模式切换(纯净/做题/解析) · 已答 n/total · 定格/导出  │
├──────────────┬─────────────────────────────┬─────────────────────────┤
│ L3 侧栏      │ 中栏：文章沉浸深读区        │ 右栏：题卡（有序递增）  │
│ 展开 200px   │                             │                         │
│ 收起 48px    │ …interested in this [ 1 ]…  │ 1 第 1 空               │
│ ┌──────────┐ ├─────────────────────────────┤ 2 第 2 空（保序修复）  │
│ │mini rail │ │                             │ 3 第 3 空               │
│ │ 空来试作 │ │                             │                         │
│ └──────────┘ │                             │                         │
├──────────────┴─────────────────────────────┴─────────────────────────┤
│ ★ 选区上下文停靠区（Context Inspector，fixed 左下，与侧栏同列）      │
│   「选区摘要」                                                        │
│   🎯 第 3 空 · 选区包含该空 → [一键建原文分析]                        │
│   [建原文分析条目] [圈词入笔记] [标记重点]                            │
└──────────────────────────────────────────────────────────────────────┘
```

三条设计决策与其理由：

- **ADR-0039 补记（题单快照保序性）**：`openSheet` 冻结的 `question_ids` 必须是原卷
  `sections.questionIds` 的**精确保序投影**（同 id 只保留首次，与读侧 `orderByFrozenIds`
  的 Set 去重同口径）。快照是「交卷物化 / 未答确认 / 评卷读面」共用的唯一题集，
  顺序错了就是全链路错。
- **就近判定纯函数化**：`src/frontend/viewModels/examProximityBinding.ts`，零 DOM /
  零 React / 零 IO。判定分两档置信度：**证据级**（选区完整包住空位 → `high`）优先于
  **推断级**（字符中点最近 / 段落对齐 → `medium`）。推断不得伪装成证据 —— UI 依此
  换主按钮文案（「一键建原文分析」vs「按此空建原文分析」）。
- **卷面不再有贴选区浮层**：改**常驻停靠区**。理由有两条，都来自真实使用：
  ① 贴选区浮层在正文顶部会倒挂；② 它靠「外点即关」存活，用户一去点右侧选项，
  选区上下文就没了 —— 而「我刚划的那句要挂到哪道题」在这几秒里必须还在。

---

## 5. 任务分解与落地状态

| Task | 内容 | 允许改动的文件 | 状态 |
|---|---|---|---|
| W0 | 题单快照保序 | `src/services/l3-sheets.service.ts`、`tests/services/l3-sheets.test.ts` | ✅ 先写 2 例失败单测（红：`[1,4,3,2]` 被原样冻结），再修（绿） |
| W0b | 存量 draft 题纸题序自愈 | `src/domain/l3-sheets.ts`、`src/repositories/interfaces.ts`、`src/repositories/l3-sheets.repository.ts`、`src/services/l3-sheets.service.ts`、`tests/services/l3-sheets.test.ts`（+4 例） | ✅ 三条边界（顺序已一致 / 集合不同 / 新建）各一例 |
| W1 | 就近绑定纯函数引擎 | 新增 `src/frontend/viewModels/examProximityBinding.ts` + `tests/frontend/exam-proximity-binding.test.ts`（12 例） | ✅ |
| W1b | 浮条视口安全定位纯函数 | 新增 `src/frontend/viewModels/selectionPanelPosition.ts` + `tests/frontend/selection-panel-position.test.ts`（7 例） | ✅ |
| W2 | 卷面选区交互重构 | `L3ExamPaper.tsx`、`styles.css`、`tests/frontend/exam-sheet-integration.test.tsx`（+5 例） | ✅ 停靠区 + 题干/选项浮条收口 |
| W3 | 侧栏收折（专注做题态） | `L3Shell.tsx`、`styles.css`、新增 `tests/frontend/l3-shell.test.tsx`（4 例） | ✅ 按钮 + `Ctrl/⌘+B` + mini rail + localStorage |
| W4 | 门禁回归 | — | ✅ 见 §1；路由棘轮按 §2-6 取证 |

### 5.1 W0 的关键判决

失败单测断言的是**顺序逐位相同**，不是「active 题都在」：

```ts
// 底层按 1、4、3、2 返回（模拟 PostgreSQL 物理序），快照仍须是 1、2、3、4
expect(sheetRepo.openSheet).toHaveBeenCalledWith(
  expect.objectContaining({ question_ids: ids }),
);
```

修法（`openSheet` paper 分支）：按原卷顺序遍历 + `activeIds` 过滤 + `seenIds` 去重。

### 5.2 W2 的两个「单一真源」

- **空号 → 题 id 的映射只有一份**：`PassageBody` 的 `questionIdByBlankNo`。
  原先这份映射内联在空位角标 `onClick` 的三元表达式里；就近绑定需要同一份，
  两处各写一遍必然漂移（角标点到的题与推荐到的题会不一致，而它们在界面上是同一个「第 N 空」）。
- **浮条定位只有一处**：`SelectionActionPopover`（内部调纯函数 + 挂载后实测高度校正），
  题干 / 选项两处共用。**禁止**在组件里再写 `translateY(-100%)`。

### 5.3 W3 的可用性底线

收起态不是把导航藏起来，而是换 mini rail（`.l3-rail-btn`，每面一个首字方块，
保留 `aria-label` / `title`）。若收起后导航不可达，用户就得先展开再收起，等于白做。

---

## 6. 验收清单

### 6.1 自动化（容器内实跑，与本文件同一次改动）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端 + 服务全量 | `vitest run tests/frontend tests/services --coverage.enabled=false` | ✅ 132 文件 / 2258 例 |
| 全库全量（含 scripts/db 契约） | `vitest run` | 313 通过 / 3 文件 4 例失败 —— **全部是容器无 git 导致**（`spawnSync git ENOENT`），facts §9.10 已登记，非本轮引入 |
| 全量类型（含后端） | `tsc --noEmit` | ✅ 零错误 |
| 前端类型 | `tsc --noEmit -p tsconfig.frontend.json` | ✅ 零错误 |
| 依赖巡检 | `depcruise src --config .dependency-cruiser.cjs` | ✅ 480 模块 / 2086 依赖 / 0 违规 |
| 覆盖率（全局阈值） | `vitest run --coverage`（排除 3 个 git 依赖测试文件后全绿） | ✅ **语句 92.89% / 分支 85.17% / 函数 92.82% / 行 94.76%**，远高于阈值 75/65/70/75 |
| 测试收集门禁 | `tsx scripts/verify-test-collection.ts` | ✅ 317 文件收集 / 317 在盘 / 0 缺失 |
| 路由棘轮 | `npm run complexity:routes` | ✅ 容器内 `apt-get install -y git` 后可跑（见 §6.1.3） |
| 分层覆盖率门禁 | `npm run coverage:layered`（`COVERAGE_BASE_REF=<PR base sha>`） | ✅ 同上；`Diff coverage 88.57% (PASS)`、Baseline ratchet PASS、四层全 PASS |
| 完整工程门禁 | `npm run verify:engineering`（PR base sha 注入三个 `*_BASE_REF`） | ✅ **EXIT=0**（CI 上同名 job 曾 failure，原因见 §6.1.4） |

#### 6.1.2 数字口径（避免后人被"文件数对不上"误导）

`vitest run tests/frontend tests/services` 报的 **132** 个文件里，有 2 个**不在**那两个目录内：
`tests/services.test.ts` 与 `tests/frontend-word-l2.test.ts` —— vitest 的路径过滤是前缀/子串匹配，
两个同前缀文件被一并命中。目录内实际是 130 个（`tests/frontend` 91 + `tests/services` 39）。

另：不要把「本机存在 `feat/undo-stack-and-session-resilience` 分支」时的 134 文件 / 2271 例
当成这条分支的数字 —— 那 2 个文件（`ladder-session-stepback.test.tsx`、`use-review-undo-stack.test.tsx`）
属于**未推送的栈式分支**，不在「以 `origin/main` 为基线」的本分支里。

#### 6.1.3 三条环境结论（新踩到，别重复探索）

0. **门禁不必留给 CI —— 容器内 `apt-get install git` 就能全量本地复现**（本次实测）。
   `vocab-observatory-v2-migration:local` 是 Debian bookworm，apt 可用、网络可达；
   装完 git 后 `npm run verify:engineering` **EXIT=0**。命令模板（注意：`--rm` 容器是临时的，
   装 git 与跑门禁必须在**同一次** `docker run` 里；并且要 `git config --global --add safe.directory /src`
   否则 root 读 uid 20564 的仓库会报 dubious ownership）：

   ```bash
   MSYS_NO_PATHCONV=1 docker run --rm --user root -e NODE_ENV=test \
     -e COVERAGE_BASE_REF=<PR base sha> -e API_CONTRACT_BASE_REF=<PR base sha> \
     -e ROUTE_COMPLEXITY_BASE_REF=<PR base sha> \
     -v F:/dev/vocab-ob/wt-main:/src -v vocab-ob-gate-nm:/src/node_modules -w /src \
     --entrypoint sh vocab-observatory-v2-migration:local -c \
     "apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null && \
      git config --global --add safe.directory /src && cd /src && npm run verify:engineering"
   ```

   顺带作废 facts §9.10 的「4 个测试恒失败」在**装 git 之后不再出现**（316 passed / 1 skipped）。

1. **只要有任意一个测试失败，vitest v8 覆盖率既不打印表也不落盘。**
   实测：含 4 例 git 依赖失败的全量跑，日志里只有 `Coverage enabled with v8`，
   之后既无覆盖率表、也无 `coverage/coverage-final.json`（连 `coverage/` 目录都不建）。
   因此「容器内含 4 例环境性失败」时，覆盖率门禁必然报
   `Coverage input not found: /src/coverage/coverage-final.json` —— 那是失败的次生现象，
   **不是覆盖率真的没测到**。
   绕法（本地取证用）：`--exclude 'tests/scripts/report-layered-coverage.test.ts'
   --exclude 'tests/scripts/verify-openapi-breaking.test.ts'
   --exclude 'tests/scripts/verify-route-complexity.test.ts'`（这三个只测 `scripts/`，
   不影响 `src/` 覆盖率口径），跑绿即可拿到真实数字。
2. **不要在跑覆盖率之前先删 `coverage/`** —— 两个理由：① 本仓有 bulk 安全删除守卫，
   `rm -rf coverage`（220 文件）会被拦下并让整条命令失败；② 陈旧报告确实会把门禁
   带偏（facts §9.8 已记录过一次）。正确做法是**不删**：一次全绿的全量
   `vitest run --coverage` 会直接覆盖 `coverage-final.json`。

#### 6.1.4 CI 的 `Engineering Gate` 曾失败：变更行覆盖率（已修）

**现象**：PR 起 CI 后，`Engineering Gate + Migration Rehearsal` **failure**，另两项 E2E 通过；
而 `main@fcdb508` 同名 job 为 success ⇒ 失败由本分支引入。GitHub 的注解只有
`Process completed with exit code 1.`，没有定位信息（日志接口需鉴权，本机凭据助手当时挂住）。

**根因**（本地复现后精确到行）：

```
Diff coverage (>=85%): **51.43% (FAIL)**
changed src files 9 (governed 4 / ungoverned 5); changed executable lines 35 (covered 18)
[layered-coverage] FAILED: diff: 18/35 changed executable lines covered
```

四层聚合覆盖率全 PASS（domain 97.89 / service 95.44 / repository 93.78 / http 91.73）、
基线棘轮也 PASS —— 唯独**变更行**这一道卡住。用 `coverage-final.json` + `git diff` 逐行对齐后定位：
`src/repositories/l3-sheets.repository.ts` 的 **379/380/390 行 0 覆盖**，即新增的
`realignQuestionIdsOrder` 方法体（其余 governed 文件 21/21 全覆盖）。

**为什么 service 层的 4 个测试救不了它**：那些测试用的是 **fake 仓储**（`makeSheetRepo`），
真方法一行都没执行。门禁的判定是「变更行落在 statement/branch/**function** 区间内即算可执行」
（`scripts/report-layered-coverage.ts` → `calculateDiffCoverage`），方法的 **function 区间覆盖整个函数体**
⇒ `fn` hit=0 时，函数体里每一行（含多行 SQL 模板）全部计为未覆盖，并把比率压到 51%。

**修法**：在 `tests/repositories/l3-sheets.test.ts` 落三例真方法测试（谓词断言 + 落空 null +
空数组短路）。复跑得 `Diff coverage 88.57% (PASS)`、`verify:engineering` **EXIT=0**。

**可复用判据（重要）**：**受管层（`src/repositories|services|domain|errors|http`）新增/修改的方法，
必须有「真仓储 / 真函数级」的单测执行到它**，service 层的 fake 仓储不算 —— 否则 diff 覆盖率必然被拖穿。
这条比「补了测试」更值钱：它决定了测试该写在**哪一层**。

### 6.2 新增回归测试钉住了什么

| 测试文件 | 钉住的契约 |
|---|---|
| `tests/services/l3-sheets.test.ts`（+6） | 底层乱序返回时快照仍逐位保序；跨节保序 + 重复 id 只留首次；**存量自愈**四例（顺序不同→校正并返回校正后行 / 顺序已一致→不打无谓 UPDATE / 集合不同→不校正 / 新建→不校正） |
| `tests/frontend/exam-proximity-binding.test.ts`（12） | 包围优先于距离；多空位包住时取阅读序最前；候选按距离升序且首选第一；`displayNo` 以调用方 Map 为权威（新题型 `ordinal+41`）；退化选区不猜 |
| `tests/frontend/selection-panel-position.test.ts`（7） | 顶部选区翻到下方且 `top >= topSafeInset`；浮层高于视口时夹到安全区顶且 `top >= 0`；左右边缘夹取 |
| `tests/frontend/exam-sheet-integration.test.tsx`（+5） | 停靠区给出「第 1 空」（`enclosed_blank`）/「第 2 空」（`nearest_blank`）；**停靠区不得再有内联 `transform`**（倒挂根因的回归钉）；一键建分析建到就近命中的题上；候选第 1 位带 🎯 |
| `tests/frontend/l3-shell.test.tsx`（4） | `Ctrl/⌘+B` 与按钮同一动作且输入框内不抢键；偏好持久化。<br>注：#189（2026-10-02）已把折叠态从「mini rail 仍可切面」改为「纵向收折 + 仅留当前活动项 + 展开全部目录」，本行随该 PR 更新 |
| `tests/repositories/l3-sheets.test.ts`（+3） | `realignQuestionIdsOrder` 的**真方法**行为：谓词含 `@>`/`<@` 集合相等判据 + `status='draft'` + `user_id`、参数为 (sheet,user,ids)；落空返回 null；空数组短路不发查询。**这一例同时是 diff 覆盖率门禁的解锁钥匙**（见 §6.1.4） |

### 6.3 真机验收（**2026-10-02 晚已实测**，结论如下）

**验收方式**：宿主 Playwright 驱动系统 Chrome（`chromium.launch({ channel: "chrome" })`，零下载）
→ 填 owner token 建会话 → 试卷台 → 打开 2025 英语（二）→ 用 `[data-blank-no]` 与
`.exam-context-dock` / `.l3-sidebar` 的 `boundingBox()` 取真值。**不是组件级断言。**

| # | 项 | 实测结论 |
|---|---|---|
| 1 | 重建 web 镜像 | ✅ 已重建（镜像 2026-10-02 21:12:46） |
| 2 | 完型 1→20 空严格递增（**P0**） | ✅ **通过**。DOM 序 = `1,2,…,20,41,…,45`，严格递增；按 `y→x` 排序的**阅读序与 DOM 序完全一致** |
| 3 | 划选含第 1 空的句子 → 停靠区给「第 1 空」 | ✅ 通过（停靠区显示「第 1 空」且可一键批注） |
| 4 | 正文第一段划词不飞出视口 / 不压章节 Tab | ✅ 未观察到超标（划词浮层贴选区、停靠区常驻左下） |
| 5 | ~~侧栏收起 → 正文与题卡变宽~~ | ⚠️ **契约已变更，见下方修订** |
| 6 | 停靠区 + 划词翻译浮层同时出现的观感 | 见 §7 未决项 2（未裁决，维持原状） |
| 7 | 极长段落 / 无空位主观题降级 | 未专门构造极端样本（属体验打磨，非阻塞） |
| 8 | 回查库 `question_ids` = 卷面序 | 由自动化覆盖（§6.1），真机侧已确认前端渲染序正确 |

#### 6.3.1 第 5 项契约修订（2026-10-02，#189 合并后）

原标准「侧栏收起 → 正文与题卡是否顺畅自适应变宽」**已随 #189 失效**：
侧栏折叠语义从「横向压成 48px 图标条、释放约 150px 给卷面双栏」改为
「**宽度锁 200px、纵向收折导航**」。

实测证据（1440×900，展开态与折叠态各测一次）：

```
展开态+划选  sidebar.w=200  main.w=996  dock.x=112  dock.w=200  Δx(dock−sidebar)=0
折叠态+划选  sidebar.w=200  main.w=996  dock.x=112  dock.w=200  Δx(dock−sidebar)=0
```

**采纳理由**：停靠区必须与侧栏同列稳定对齐，侧栏宽度一变，`left` 就得跟着重算
（旧代码正是 `left: calc(3rem + 1rem)` 那种耦合）。锁死 200px 让
`Δx = 0px` 在两态下**精确成立**，这正是 #189 标题里「稳定对齐」的含义。
**代价**：折叠不再让卷面变宽。此取舍已由维护者在 #189 合并时确认接受。

修订后的第 5 项标准：**侧栏折叠应保持停靠区与侧栏左沿对齐（Δx=0），且不使停靠区消失。**

> 若日后要「既释放横向空间、又保持对齐」，需让 `.exam-context-dock` 的 `left` 随
> 折叠态重新计算（回到耦合），属独立改动，不在本次范围。


---

### 6.4 本机生效前置：必须重建 web 镜像（否则看不到任何修复）

> **状态（2026-10-02 晚）**：该镜像已按本节重建，真机验收（§6.3）即在其上进行。
> 以下为**每次改前端后都适用的通用前置**，不是一次性步骤。

`vocab-observatory-web-1` 从镜像构建（**无源码挂载**），不重建就刷新页面看到的是旧代码。按 facts §4 登记过的两个坑：

```bash
docker compose -f compose.yaml build web          # ① 只 build 不 recreate 无效
docker compose -f compose.yaml up -d --force-recreate web   # ② 必须 force-recreate
```

自愈校正发生在「进卷自动开纸」那一次请求里 —— 也就是重建后**第一次打开那张 2025 卷**时
（`POST /api/l3/sheets`），无需用户做任何额外操作。

## 7. 未做与待裁决（如实登记）

1. **`paragraph_aligned` 判定暂无数据源**。纯函数引擎已实现并单测覆盖，但调用方拿不到
   「段落 → 题」的映射：卷面 payload 里没有这个字段（`evidence` 是答案锚点，解析模式才渲染，
   拿来当绑定依据等于剧透）。因此**阅读理解（无空位卷）目前回退成题序候选列表**（与旧行为一致）。
   要做实需先在 payload 里引入段落归属（属数据模型变更，需单独设计卡）。
2. **划词翻译浮层未并入停靠区**。原 Plan 写「翻译内容直接整合进单浮层或固定区」。
   实测下来的判断是：停靠区移到左下后，「两个浮层在正文中重叠」这个**冲突本身已消失**
   （一个常驻左下、一个贴选区），而 `SelectionTranslatePopover` 的贴选区设计是 PR #175
   刻意为之（「用户的眼睛本来就在那一行上」）。强行并进停靠区会让眼睛来回跳。
   **留待用户裁决**：若仍要求合并，需在停靠区内接一次 `translateText` 并给正文加
   `data-no-translate`（全局层已有该 selector 支持）。
3. **readOnly（定格后）的正文划词仍会开出停靠区**（按钮全 disabled）。与修复前行为一致
   （旧浮条同样渲染），故未在本次收紧；`exam-sheet-integration.test.tsx` 里那条
   「readOnly 下划词不再捕获」的断言打的是**选项行**，没覆盖正文。建议单独立项。
4. ~~`l3_papers` 存量脏数据未回填~~ —— **已在代码层解决，无需人工改库**。经真库核查（§3.1），
   唯一乱序的存量行是那张 2025 英语（二）的 **draft** 题纸；W0b 的自愈会在它下次被打开时
   就地校正题序（集合判据 + `status='draft'` 双保险）。**已 sealed 的题纸不会被改**
   （红线：定格快照完整性），实测那两张 sealed/1 题卷本来就无乱序。
   若日后发现 sealed 行也有乱序，那属单独的数据订正议题，不在本次范围。
5. ~~完型空号乱序的端到端复现证据~~ —— **已补齐**，见 §3.1：真实库查到该卷快照 48 题里
   只有第 1 位与卷面一致。这是修复前状态（本次未改库，只是 `ROLLBACK` 演练）。
   但端到端「用户屏幕上不再乱序」仍需真机确认（§6.3 第 1 项），因为页面渲染还叠了
   `scopePaperToFrozenList` 与题号映射两层。
