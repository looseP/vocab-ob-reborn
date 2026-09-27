# L3 三模式可见性引擎 + 文件顺序缺口收口（执行文档，2026-09-27）

> 承接 `docs/plan/l3-subspace-venue-design-card-2026-09-16.md` §2.4（三模式）与 §105（上一/下一文件）。
> 本文档只做**开工前的事实校准 + 决策表 + 护栏 + 必测矩阵**；签字后才实现。
> 纪律沿 chain02/03/04/05：纯函数先落、边界测试锚定、每条护栏配一个失败测试。

---

## 一、开工前的三处事实更正（与既有文档不符，先改认知）

### 1.1 「上一文件/下一文件」**已经实现了**，P0/P1 文档的「未做」已过期

- `FileOrderBar` 已落地（`src/frontend/components/l3/L3PapersPage.tsx:320-367`），含
  `file-order-previous` / `file-order-next` / `file-order-position` 三个 testid，首末份**禁用而非消失**。
- 纯逻辑 VM 已落地：`src/frontend/viewModels/fileOrderNavigation.ts:49-83`
  （`sameFileIdentity` / `findFileSiblings` / `filePositionLabel` / `fileSiblingLabel`）。
- 测试已覆盖：`tests/frontend/file-order-navigation.test.ts`（123 行）+ `tests/frontend/l3-papers.test.tsx:140-262`。
- 提交 `a0942e8`，是 HEAD 的祖先。
- **结论**：本项不是「新建」，是「收口四个缺口」（见 §3.3）。`docs/plan/practice-loop-p0p1-2026-09-26.md`
  的 §三-3「未做：上一文件/下一文件」应同步更正，否则下一次开工判断建立在错的未决清单上
  （同 F-1/F-2 那类过时标记）。

### 1.2 三模式的**设计已完整存在**，实现层零残留

- 设计卡 §2.4（`l3-subspace-venue-design-card-2026-09-16.md:108-124`）有完整的可见性矩阵、
  URL 形态（`?mode=pure|practice|review`）、切换器位置（卷面顶栏）、以及「切换不丢作答」的约束。
- 任务分解条目 `docs/plan/l3-venue-wave-tasks-2026-09-16.md:55`（V2-T2）。
- ADR-0030:78 与 ADR-0034:42 都已预留（后者写明 `stage=draft` 注记「**纯净模式**不显示」）。
- 代码层核查结果：`searchParams.get("mode")` **0 命中**；`src/frontend/viewModels/` 无
  `modeVisibility*` / `examVisibility*` 类文件；L3 内部的 `mode` 命名全部属于
  `capture.mode`（浮条）/ `assembleSheet(mode)`（装配入参）/ `sealMode`（定格三档）——**与可见性无关**。
- **结论**：不是新设计，是**实现一个已有规格**。所以本轮**不需要新 ADR**（设计卡即是规格），
  但需要一份执行文档把规格映射到「今天真实存在的元素」。

### 1.3 发现一个**当前就存在的剧透 bug**（与三模式无关，独立必修）

```
L3ExamPaper.tsx:1913-1929   stats = { correct, total, score }   ← 按 picks vs q.answer.choice 算
L3ExamPaper.tsx:2168-2172   客观题已答 n/total · 答对 {stats.correct} · 估算 {stats.score} 分
```

`stats` 的计算与渲染**都不看 `revealAll`**（对比同文件 `:896-902` 明确把判定锁在 `revealAll` 里）。
⇒ 草稿态用户在**未揭示答案**时就能看到「答对 N」「估算 X 分」。

**这是 correctness bug，不是模式工作的一部分。** 它必须**独立先行修复**（独立 PR），
理由：混进模式大 PR 会让它被评审噪声淹没；而它现在就在泄漏。

---

## 二、事实与证据（今天的元素盘点）

`revealAll` 现状：纯组件 `useState`，初值恒 `false`（`L3ExamPaper.tsx:1081`），唯一写者是
header 按钮（`:2164`），**无 URL、无持久化**、每次重挂回 `false`（`L3PapersPage.tsx:563,821`）。
全库 22 处 `revealAll` 命中都在这一个文件里。

| # | 元素 | 今天的门控 | 证据 |
|---|---|---|---|
| 1 | 材料正文 + 题面 | 恒显 | `:829-844` |
| 2 | 选项已选高亮 | `!revealAll` | `:909` |
| 3 | 官方 evidence 文中高亮 | `revealAll` | `:214` → `examPassageSpans.ts:79-83` |
| 4 | 用户划重点 mark | **恒显** | `:213` → `examPassageSpans.ts:85-87` |
| 5 | 用户注记锚点 + 「原文分析」子区 | **恒显** | `:210-212`、`examPassageSpans.ts:89-96`、`L3QuestionAnalysis` `:1992-2008` |
| 6 | 评析 | **恒显** | `:2010`（无门控） |
| 7 | 选项判定配色 | `revealAll` | `:896-902` |
| 8 | 题目官方解析 | `revealAll` | `:920-925` |
| 9 | 参考译文 / 范文 | `revealAll` | `:1045-1053` |
| 10 | 评卷判读 | `revealAll` | `:1984-1991` |
| 11 | 作答可编辑 | `readOnly = sheet.status !== "draft"` | `:1954-1956` |
| 12 | header 答对/估算分 | **恒显（剧透）** | `:1913-1929`、`:2168-2172` |
| 13 | 学习笔记侧栏 | 面板 state | `:2401-2417` |
| 14 | 评卷覆盖度条 | `sheet.status === "sealed"` | `:2100-2130`、`:1151` |

**只有 sheet-capable 表面有卷面**：fileKey 型文件（翻译/作文无 source）**不能开题纸**
（`domain/l3-sheets.ts:101-117` 的 `sheetOpenInputSchema.superRefine`），
只能走浏览视图（`L3PapersPage.tsx:467-477`）——**那里没有卷面，也就没有模式**。

---

## 三、决策

### 3.0 D-1 剧透修复先行（独立 PR，不等签字）

- `stats` 的**计算**保留（`review` 模式要用），但**渲染**按模式门控：`practice` 显示
  「已答 n/total」，`答对` 与 `估算分` 两段只在 `review` 显示。
- 为什么不是删掉 `stats`：`review` 模式需要它；且 `picks` 数量（已答数）不剧透，可保留。
- 护栏 G-0：`practice`/`pure` 模式下渲染结果**不含** `答对` / `估算` 字样。

### 3.1 D-2 模式定义：三档，取代 `revealAll` 布尔

```
type ExamMode = "pure" | "practice" | "review"   // 语义沿设计卡 §2.4
默认 = "practice"（= 今天的 revealAll=false）
```

- `revealAll === false` → `practice`；`revealAll === true` → `review`；`pure` 是新增。
- **不是重命名**：`pure` 引入了设计卡矩阵里今天不存在的语义（隐藏用户痕迹层 + 只读）。

### 3.2 D-3 可见性矩阵（实现口径：以 §2.4 为准，映射到今天真实存在的元素）

| 元素 | pure | practice | review |
|---|---|---|---|
| 材料正文 + 题面（#1） | ✅ | ✅ | ✅ |
| 作答可编辑（#11） | ❌ 只读 | ✅（draft 时） | ❌ 只读陈列 |
| 选项已选（#2） | ❌ | ✅ | ✅ |
| 用户划重点（#4） | ❌ | ✅ | ✅ |
| 用户注记（锚点 + 子区）（#5） | ❌ | ✅ | ✅ |
| 评析（#6） | ❌ | ✅ | ✅ |
| 官方 evidence 高亮（#3） | ❌ | ❌ | ✅ |
| 选项判定配色（#7） | ❌ | ❌ | ✅ |
| 题目解析（#8） | ❌ | ❌ | ✅ |
| 参考译文/范文（#9） | ❌ | ❌ | ✅ |
| 评卷判读（#10） | ❌ | ❌（未评时「待评卷」） | ✅ |
| header 答对/估算分（#12） | ❌ | ❌ | ✅ |
| 学习笔记侧栏（#13） | ✅ 可达 | ✅ | ✅ |
| 评卷覆盖度条（#14） | ❌ | ✅ | ✅ |

两处与设计卡原文的**有意偏离**，需在签字时确认：

- **#14 评卷覆盖度条**在 `pure` 下隐藏：它是「已评 n/m」这一评卷进度，属解析侧信息。
  设计卡矩阵未列此元素（它晚于设计卡）。
- **#13 学习笔记侧栏**在 `pure` 下**保留可达**：侧栏是**工具**不是痕迹，且 `pure` 的
  用途之一是打印——侧栏本来就该由用户自己收起。隐藏它会让 `pure` 变成「什么都不能干」。

### 3.3 D-4 模式住 URL（position param，单一真源）

- `?mode=pure|practice|review`，与 `venue` / `paper` / `sheet` 同级。
- 落点：`L3Page.tsx` 的参数解析（`:112-119` 那一片）+ 一个新的纯函数 VM
  （`examModeNavigation.ts`，仿 `fileOrderNavigation.ts` 的形状：解析 fail-closed、非法值 → `null` → 回落默认）。
- 理由：`?file=` 深链已有先例（`L3PapersPage.tsx:247` `deepLinkFile`）；ADR-0025 要求 URL 契约单一真源；
  现状「刷新丢失解析态」不可分享/不可后退。
- **不落库**（无 localStorage / 无后端列）：模式是视图状态，不是用户偏好。存了反而要处理
  「上次是 review，这次打开直接看到答案」的意外剧透。

### 3.4 D-5 纯函数模块承载判定（不进 2538 行的组件）

`L3ExamPaper.tsx` 已 2538 行 / 126 KB，而 `docs/plan/study-notes-design-2026-09-18.md:194`
写着「新功能不得把全部逻辑塞进近两千行 L3ExamPaper」。因此：

- 新建 `src/frontend/components/l3/examModeVisibility.ts`：**纯函数**，
  导出 `EXAM_MODES` / `parseExamMode` / `buildExamModeUrl` / `visibilityFor(mode)`
  （返回一组具名布尔：上表每行一个字段）。
- 组件只 `const vis = visibilityFor(mode)`，然后用 `vis.showEvidence` 之类替换裸 `revealAll`。
- 判定逻辑全部可单测；组件只负责渲染。

### 3.5 D-6 切换不丢作答（设计卡 :124）

作答在 submission（服务端），模式是渲染态——结构上已满足。**护栏 G-4**：在 `pure` → `review`
往返后，选项选中态与正文编辑框内容**逐字不变**（防「为了实现模式顺手把作答搬进组件 state」）。

### 3.6 D-7 文件顺序四个缺口收口

| 缺口 | 事实 | 处置 |
|---|---|---|
| A 不写 URL | `openFile` 只 `apiFetch` + `setDetail`，**无 `navigate`**（`L3PapersPage.tsx:426-481`）⇒ 刷新/分享/后退全丢位置 | 复用既有 `deepLinkFile` 通道（`:247`、`:404`、`:489-497` 一次性消费）写 `?file=`；**不新建第二条深链机制** |
| B 不经题纸写屏障 | `openFile` 直接调；`jumpBarrier` / `leavePaperBarrier` 只在 `onBack`（`L3ExamPaper.tsx:1546-1552`）⇒ 换文件时在途作答可能丢 | 换文件前过 `leavePaperBarrier`（与 `onBack` 同一道门，失败给可归因提示） |
| C paper venue 无顺序条 | `PapersTab`（`:818-830`）与 `SheetReplayView`（`:1284-1298`）都不渲染 `FileOrderBar` | **收口**：整卷内「上一/下一文件」= 跨 section 跳下一节的题（设计卡 §105「跨 section 即跨文件」）。这是**卷内滚动定位**，不开新题纸 |
| D fileKey 型文件的顺序 | 顺序条照常给（`fileOrderNavigation.ts:19-20` 已声明），点进去是浏览视图 | 保持现状（与列表点它结果一致）；**不**为它造模式 |

---

## 四、护栏（每条配一个失败测试）

- **G-0 剧透**：`practice` / `pure` 渲染不含 `答对` / `估算` 字样（先于一切模式工作落地）。
- **G-1 纯净只读**：`pure` 下选项点击、划重点、注记锚点、评析编辑**全部无写入口**
  （不是「点了没反应」，是按钮/编辑区不渲染）。
- **G-2 隐藏即声明**：`pure` 下若存在用户痕迹（mark / 注记 / 评析 / 已选），卷面顶部**必须**
  出现「已隐藏 N 处高亮与 M 条注记」声明条；痕迹数为 0 时不出现（不显示无意义的「已隐藏 0 处」）。
- **G-3 模式不可越权**：`review` 模式**不**让 sheet 从只读变可写（`readOnly` 与 mode 双重门控，
  防止「切到 review 顺手改答案」污染 attempt 不可变事实）。
- **G-4 往返不丢作答**（D-5）。
- **G-5 URL 单一真源**：非法 `?mode=`（如 `?mode=xxx`）回落 `practice` 且**不静默改写用户输入**
  （fail-closed 沿 `parseL3SectionParam` 既有纪律）。
- **G-6 换文件过屏障**（缺口 B）：`onGoPrevious/onGoNext` 在作答未保存时**必须**走屏障，失败不换。
- **G-7 顺序条只在有意义处**：`fileKey` 只能浏览的文件**不给**模式切换器（那里没有卷面）。

---

## 五、必测矩阵

**模式引擎（纯函数，`examModeVisibility.test.ts`）**
1. 三档 × 上表 14 行逐格断言（一张表驱动的 `it.each`）
2. `parseExamMode`：三值 / 缺省 / 非法 → `null` / 大小写与空白不容错
3. `buildExamModeUrl` 不覆盖既有 `venue`/`file`/`paper`/`sheet`/`question`

**剧透（先落地）**
4. `practice` 渲染无 `答对`/`估算`；`review` 两者都在

**组件（`l3-exam-mode.test.tsx`）**
5. `pure`：痕迹全隐 + 声明条计数正确 + 无写入口
6. `practice`：痕迹全显 + 无答案/证据/解析 + 已答数在
7. `review`：答案/证据/解析/评卷全显 + 作答只读
8. `pure→review` 往返：选中态与编辑框内容逐字不变（G-4）
9. 痕迹为 0 的 `pure`：无声明条（G-2 反向）

**文件顺序（`l3-papers.test.tsx` 追加）**
10. 切文件写 `?file=`，刷新后停在同一份（G-缺口 A）
11. 作答未保存时点下一份 → 屏障拦下、**不换**（G-6）
12. paper venue 顺序条跨 section 定位（G-缺口 C）
13. `fileKey` 型文件无模式切换器（G-7）

**注册表**
14. 导航登记表新增项的 `href` 与 `matchPrefix` 断言（若新增登记项）

---

## 六、显式不做（写下来防止「顺手补齐」）

1. **不做待办队列**（`fileOrderNavigation.ts:12-13` 已判过：「下一份」= 列表下一份，不是「最该做的那份」，
   两者混在一起会让「下一份」不可预期）。待办是独立 epic。
2. **不做计时器**（设计卡矩阵列了「纯净/做题可选，解析 ❌」）——**需先有计时器这个实体**，
   本轮不造。
3. **不做订正笔记区**（设计卡 :118/:123 提到「解析修正模式开放订正笔记」）：它需要
   `context_type='note'` 的写入面与注记体系的接线，属另一张任务书。
4. **不给 fileKey 型文件造模式**（那里没有卷面）。
5. **不把模式存后端/localStorage**（D-4）。
6. **不改题单定格 / 作答真源 / 评卷真源**任何结构。

---

## 七、需签字的三项（其余按本文档执行）

- **S-1**：G-2「纯净模式必须声明隐藏了什么」——**要**。不加声明条的话，用户打开 `pure`
  看不到自己上次的标注与高亮，会以为**丢了**。隐藏是设计意图，但「静默隐藏用户自己的劳动成果」
  是本仓反复登记过的反模式（F-1/F-2 同族：行为合理但未言明 ⇒ 后来者误判为缺陷并「修复」）。
- **S-2**：D-3.2 两处有意偏离（`pure` 隐藏评卷覆盖度条 / `pure` 保留笔记侧栏可达）。
- **S-3**：剧透修复**先于**模式引擎合入（独立 PR）。

---

## 八、批次与停点

| 批次 | 内容 | 停点 |
|---|---|---|
| B1 | G-0 剧透修复（独立 PR） | 合入后再开 B2 |
| B2 | 纯函数模块 + URL 契约 + 矩阵单测（**不碰组件**） | 产出 draft PR 停点，等审查 |
| B3 | 组件接线（G-1/G-2/G-3/G-4/G-7） | 产出 draft PR 停点 |
| B4 | 文件顺序四缺口（G-6 + 缺口 A/C） | 产出 draft PR 停点 |
| B5 | 文档收口（更正 P0/P1 的过期「未做」） | 随 B4 合并 |

每个批次：**不部署、不改冻结面、不过基线**。范围变更必须**先登记再提**（F-3 教训）。
