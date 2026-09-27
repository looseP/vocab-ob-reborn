# L3 题目录入与改题面 · 设计与核验（2026-09-27）

- **分支**：`feat/question-authoring-ui`（worktree `wt-loop`，基线 `main@e9919b5`）
- **状态**：待用户签字（本文档 §四 的 D-1/D-2 已签字，其余按本文档执行）
- **依据**：ADR-0037（agent 录题 pending 闸门）、`docs/plan/practice-loop-p0p1-2026-09-26.md`
  §四第 3 条（`explanation`/`evidence` 录入 UI + 题目/试卷 `PATCH` 记为未做）
- **不在范围**：不动 schema / 不动 service 护栏 / 不动迁移 / 不部署 / 不新增依赖

---

## 一、已核实事实（施工前逐条点过代码，不凭记忆）

### 1.1 服务端面**全齐**，一个都不缺

| 能力 | 端点 | 护栏位置 |
|---|---|---|
| 建题 | `POST /l3/questions`（`routes/l3/papers-authoring.ts:47`） | lifecycle 服务端认定 |
| 改题 | `PATCH /l3/questions/:id`（`routes/l3/papers-update.ts:45`） | service `updateQuestion` |
| 改卷 | `PATCH /l3/papers/:id`（`routes/l3/papers-update.ts:30`） | owner-only |
| 采纳 | `POST /l3/questions/:id/accept` · `/reject` · `/accept-batch` | owner-only |
| 能力自述 | `GET /l3/capabilities` 的 `authoring` | `domain/l3-authoring.ts:55` |

改题护栏（已在 service，本轮**不重写**）：有作答历史 → 409；被作文任务引用 → 409；
evidence 锚点越界 → 422（带正文长度）；引用他人/非 active 的题 → 422。

### 1.2 前端**零调用方**

`POST /l3/questions`、`PATCH /l3/questions/:id`、`PATCH /l3/papers/:id`
在 `src/frontend` 里**没有任何调用方**（`src/frontend/api/l3Client.ts` 也没有对应函数）。

### 1.3 题库**已有** owner 侧入口（这一点纠正了初始判断）

`POST /l3/papers` 的 `sections[].questions[]` **就地建题**
（`L3PapersPage.tsx:969-978` 提交 stem / options / answer / explanation / evidence）。
所以「粘贴建卷」同时是**录题面**与**建卷面**。

### 1.4 三个缺口（收敛后）

| # | 缺口 | 事实 |
|---|---|---|
| A | **单题录入** | 录题只能整卷附带；无法为某个来源单独补一道题 |
| B | **改题** | `PATCH /questions/:id` 无调用方 —— 答案键写错后**没有任何修改路径** |
| C | **改卷** | `PATCH /papers/:id` 无调用方 —— 试卷建完即冻结 |

B 是最重的一处：ADR-0037 的采纳闸门只挡 agent 产物，owner 直写 active
（`domain/l3-authoring.ts:30`）。owner 手录的题**一次作答后同样永久不可改**
（409）。没有改题面，owner 只能删题重录，而删题会**连带丢掉这题的全部作答与评析**。

### 1.5 ADR-0037 已为这个 epic 留好位置

`domain/l3-authoring.ts:36-39` 的 `editableQuestionStatuses` 注释：

> owner：`active` 与 `pending` 都可改 —— 待录题必须能改，否则 owner 看见错答案键只能
> 驳回、不能修，**白白逼用户回到手录**。

即：**owner 可改 active 题**是既有裁决，不是本轮新增权限。

### 1.6 B3 施工前发现：读面**不携带**「能不能改」的信号（2026-09-27 登记的范围变更）

D-2 要求「有作答历史时**不渲染**改题入口」。而 UI 要做这个判断，需要读面告诉它
「这道题现在能不能改」。核对下来：

- 改题护栏的判据是 `countQuestionAttempts(userId, questionId) > 0` → 409
  （`l3-paper.service.ts:339`，`blockers: { attempts: n }`）。
- `l3QuestionResponseSchema`（`l3-paper-response-contract.ts:33`）**没有** attempt 计数，
  也没有任何「可编辑」标记。`GET /practice-files/detail` 返回的就是它。
- `status` 只能区分 `pending / active / rejected`，**答不了**「已被作答过」。

于是 D-2 没有数据依据，只能退回到已签字否掉的 C 方案（填完表单吃 409）。

**处置（须签字）**：给**练习文件详情读面**的题目行加一个 `editable: boolean`，
由服务端用**与护栏同一组判据**算出（`editableQuestionStatuses` ∩ `attemptCount === 0`）。
理由三条：

1. **判定不进 UI**（本文件一贯纪律）。发 `attempt_count` 让前端自己算 `editable` 是把
   护栏复制一份 —— 与 `revealAll` → 判定表、`interactionLocked` → 同一道门同族。
   字段给**结论**（能不能改），不给**原料**（有没有作答）。
2. **只加在这一个读面**。`l3QuestionResponseSchema` 被建卷响应与卷详情复用，把
   `editable` 塞进去要改 3 处产出点；改为给详情读面单独
   `l3PracticeFileQuestionSchema = l3QuestionResponseSchema.extend({ editable })`，
   其余消费点零影响。
3. **一次分组查询**取全部 attempt 计数，不按题逐个 count（否则 20 题的卷 = 20 次查询，
   与本轮刚销掉的评析 N+1 同族）。

**连带范围**：这是**响应契约变更**（不是写入 schema、不是护栏、不是迁移），因此 B3
不再是「纯 UI 批次」：需动 repository（分组计数）/ service（算 editable）/
响应契约 / OpenAPI 再生成。已在 B3 小节登记，**并加一条测试把两侧钉在一起**：
同一题 `editable === false` ⟺ `PATCH` 必 409 —— 判据一旦漂移立刻红。


**做**：缺口 A + B（同属「题目装配面」），C 单列一批（§八 B3）。

**不做**（写下来防止「顺手补齐」）：

1. **不改 ADR-0037 的闸门**：owner 手录**直写 active**，不走 pending → accept。
   理由：owner 就是采纳人，让他自己录的题再走一遍自己的门是仪式，没有安全收益。
   本轮**不是**把 owner 也纳入闸门 —— 那是重开 ADR-0037 的题，需单独立任务书。
2. **不给 agent 任何新面**：agent 走 HTTP/MCP，不进 UI。
3. **不做题目列表的排序/筛选/分页**：第一版按来源分组，最多取 100 题（同建卷面
   `GET /l3/sources?limit=100` 的既有口径），规模上来再谈。
4. **不做改题的撤销/历史**：latest-wins，无版本列（同 D3-a 对 grading 的裁决口径）。
5. **不动 `QuestionEvidenceEditor`**：直接复用（单一实现）。它已在粘贴建卷内
   使用（`L3PapersPage.tsx:1079`），具备「选句成锚点 + 拉 `source_content`」。

### 1.6b B4 施工前发现：建卷与改卷的**数据形状不同**（2026-09-27 登记）

| | 建卷（`POST /papers`） | 改卷（`PATCH /papers/:id`） |
|---|---|---|
| `sections[].questions` | **内联题体**（stem/选项/答案/解析/证据）⇒ 顺带**建题** | 不存在 |
| `sections[].questionIds` | 服务端生成 | **引用**既有题 id |

所以改卷不是「把建卷表单预填一遍」，而是一个**选题**表单：从某个 (来源, 题型) 的文件里
勾选哪些题进这一节。把两种形状塞进同一个组件，会得到一个「有时有题体、有时只有 id」的
表单 —— 那正是本文件拒绝的「同一动作的第二个入口」的变体。

**护栏也各不同**：`updatePaper` 判「卷必须 `active`」（否则 409）与「引用的题必须全部
属主且 active」（否则 422），与 `updateQuestion` 的两个 409 **不是同一组**。G-C2 按各自
归因，不共用文案。

### 1.6c D-5（已签字）改卷入口在「我的试卷」列表的每行「改」

- 「我的试卷」已经逐行列出卷（标题 + 节数 + 题数），在那里加「改」是就近入口，不新造导航。
- **不**做成「粘贴建卷」的第二种模式：那会让一个组件同时处理内联题体与 id 引用两种形状
  （§1.6b），且「粘贴建卷」的语义是「从零建一整卷」。
- **不**新开「试卷编辑」页签：录制题面已经在做页签，第三个装配页签就是第二次重复。

---

## 三、字段矩阵（表单字段 × 题型）

题型分组沿既有常量（`L3PapersPage.tsx`）：`CHOICE_TYPES` = cloze / reading_choice /
new_question / grammar_blank；`SOURCELESS_TYPES` = sentence_translation / short_essay /
long_essay。

| 字段 | 选择题（CHOICE_TYPES） | 翻译 / 作文（SOURCELESS_TYPES） | 依据 |
|---|---|---|---|
| 题干 `stem` | 必填 | 必填 | `l3QuestionBodySchema.stem`（1–30k） |
| 选项 `options` | 必填，A–D 逐项非空 | **不渲染** | 同上 `.max(12).optional()` |
| 答案 `answer.choice` | 必填，须是已填选项之一 | 不渲染 | 录错答案键 = 本 epic 要修的病 |
| 答案 `answer.text` | 不渲染 | 翻译必填 | `answerSchema.text` |
| 参考范文 `answer.sample` | 不渲染 | 作文可选 | `answerSchema.sample` |
| 解析 `explanation` | 可选 | 可选 | `.nullish()`；**空值不提交**（服务端归一） |
| evidence 锚点 | 可选（需来源正文） | 可选（同） | `.max(60)`；`fileKey` 型无正文 ⇒ 不渲染 |
| `questionType` | 必填 | 必填 | `l3QuestionCreateSchema` |
| `sourceId` / `fileKey` | 二选一必填 | 二选一必填 | schema `.refine` |

**空值不提交**沿粘贴建卷的既有做法（`L3PapersPage.tsx:972-973`）：`explanation` 空串不
进 body（否则把已有的解析抹成 null 是另一种数据丢失）。

---

## 四、需签字的决策（其余按本文档执行）

### D-1（已签字）录题面放在**试卷台新增「录题」页签**

与 题型空间 / 我的试卷 / 题纸档案 / 粘贴建卷 / 待录 并列。

**为什么不是挂阅读视图**：录题需要选来源、选题型、配答案键与 evidence，本质是
**装配**动作，与「粘贴建卷」同类。挂阅读视图会让「我正在读」的表面背上装配职责 ——
与本轮已否决的「缺口 C 顺序条」同族（同一动作的第二个控件）。

### D-2（已签字）有作答历史时**不渲染改题入口**，改为题面上一处只读说明

文案：`已作答并定格的题不可改题面（改题会使作答与它对不上）`。
不选「禁用 + 说明」是因为本轮 G-1 已立纪律：「不是『点了没反应』，是按钮/编辑区
不渲染」；死控件会同时让用户犹豫、让可访问性名称与测试断言变二义。

### D-3（已签字）题目字段 UI **抽成共享组件**，由「录题」与「粘贴建卷」共用

初始决定是「新增录题页签」，施工前发现**字段会重写第二份**
（`stem`/选项/答案/解析/evidence + `QuestionEvidenceEditor` 都在粘贴建卷里）。
两个入口各写一份表单 = 今天第三个重复控件（同 `FileOrderBar` 的「返回题型空间」）。

抽 `QuestionFieldsEditor`（受控：`value: DraftQuestion` + `onChange`），
「粘贴建卷」的 per-question 块与「录题」页签共用。
**改粘贴建卷是必要代价**（否则两份实现必然漂移），但它只调组件、不改行为。

### D-4（已签字）改题面的入口在「录题」页签**内**

- 录题与改题是同一件装配工作的两个入口，分开两页签反而是第二次重复。
- 「录题」页签 = 上半「录单题」+ 下半「我录的题」（按来源分组 → 点「改」）。
- 不另开「题库」页签：题库面更完整，但要新读面（题目按来源聚合 + 分页），第一批大一倍。
- **不挂在卷面里**：卷面是做题表面，`ADR-0019 §1` 的「只渲染不编辑」定位会被破，
  且改题时用户可能正在作答这题。

---

## 五、护栏（每条配一个失败测试）

- **G-A1 录题必带答案键**：选择题提交时 `answer.choice` 必须是**已填选项之一**，
  否则不提交（客户端挡 + 服务端 `l3QuestionAnswerSchema` 兜底）。答案键为空 = 采纳时
  是个盲签名。
- **G-A2 空值不提交**：解析/范文空串不进 body。**抹掉已有解析**也是数据丢失
  （与本轮「读失败不许覆盖未读旧内容」同族）。
- **G-A3 空题干不提交** + 不给「已作答不可改」的题渲染改题入口（D-2）。
- **G-B1 改题失败按 service 归因呈现**：409 分「有作答历史」与「被作文任务引用」两种，
  文案不同、恢复路径不同（改题 vs 先解作文任务引用）。**不把 409 统一渲染成「改题失败」**。
- **G-B2 evidence 越界 422 带正文长度**：透传 service 给的长度，别让用户猜该选哪句。
- **G-B3 改题不静默**：成功后跳回列表并 toast；失败保留用户输入（不丢表单）。
- **G-C1 改卷**：section 的 `questionIds` 变更前提示「这会改变卷内题集，已开题纸的
  题单不变」（题单冻结是 ADR 的既有口径，改卷不动已定格题纸）。
- **G-C2 改题/改卷都不静默改写别人/非 active 的题**：422 直接透传。

---

## 六、显式不做（防「顺手补齐」）

见 §二 1–5。追加两条：

6. **不给录题面加「草稿自动保存」**：录题是一次性提交的动作，中途草稿要新表新端点。
7. **不在录题面做 judge/自测**：那是判卷通道的职责（`ADR-0035`）。

---

## 七、必测矩阵

**录题（新建）**

1. 选择题：题干/选项/答案键齐 → 提交体形状正确（`answer.choice` 是已填选项）
2. **G-A1**：答案键不在已填选项里 → 不提交、就地提示
3. 翻译题：渲染 `answer.text`、**不渲染**选项与 choice（照矩阵，不是全渲染再隐藏）
4. 作文题：范文 `sample` 可选
5. **G-A2**：`explanation` 空串不进 body（断言请求体，不只看 UI）
6. **G-A3**：空题干不提交
7. 成功 → 落 `active`（**不**出现在「待录」页签 —— ADR-0037 的 owner 直写）
8. 失败 → 保留输入 + toast

**改题**

9. 列表给出我的题（按来源分组）→ 改题表单预填现状
10. **G-B1-①**：有作答历史 → **不渲染**改题入口 + 题面显示 D-2 的只读说明
11. **G-B1-②**：409「被作文任务引用」→ 独立文案（与 ① 不同）
12. **G-B2**：evidence 越界 422 → 透传正文长度
13. **G-B3**：失败保留输入

**改卷（B3 批）**

14. 改标题/direction/sections → 提交体形状正确
15. **G-C1**：变更 section 题集前有提示

**共享组件**

16. `QuestionFieldsEditor` 的字段矩阵由一张表驱动（照 §三 逐格断言），
    粘贴建卷与录题**共用同一实例类型**（编译期防漂移：改题面字段必须同时改两处）

---

## 八、批次与停点

> **B1 补记（施工时发现）**：QuestionFieldsEditor 需要题型类型，而 L3PapersPage 里的
> QuestionType 是**本地 7 元并集**，@/domain 另有 canonical 的 L3QuestionType。B1 顺带把本地
> 并集收敛成 	ype QuestionType = L3QuestionType（零行为变化）—— 留两份的话，加题型时 domain 会更新、本页的
> 题型下拉不会更新，而题型分支错了**不报错**、只会静默录错题。
> QUESTION_TYPES / TYPE_LABELS / CHOICE_TYPES / SOURCELESS_TYPES 四份本地常量同样与 domain 重复（
> domain/l3-question-types.ts 已有 L3_QUESTION_TYPES / L3_QUESTION_TYPE_LABELS / isSourcelessQuestionType），**本轮不动**：
> 那是独立的一次收敛，且会改到题型下拉的渲染来源，超出「B1 行为零变化」的承诺。已登记为 B2 前置。

| 批次 | 内容 | 停点 |
|---|---|---|
| **D0** | 本文档 + D-3/D-4 签字 | 签字后才动手 |
| **B1** | 抽 `QuestionFieldsEditor`（粘贴建卷改用它，行为零变化） | 单独 PR：纯重构，先证明没改行为 |
| **B2** | 「录题」页签（缺口 A：单题录入） | draft PR 停点 |
| **B3** | 改题面（缺口 B）+ 改题入口的 409 预挡（D-2） | draft PR 停点 |
| **B4** | 改卷面（缺口 C） | 独立 PR（可与 B3 拆开） |

B1 单独拆出来的理由：它是**纯重构**（粘贴建卷行为必须零变化），与新增功能混在一个
PR 里，review 时无法判断行为变化是重构带来的还是新功能带来的 —— 那正是本仓反复
登记的「范围变更要先登记」的同类风险。

每个批次：**不部署、不改 schema/护栏/迁移**。范围变更**先登记再提**（F-3 教训）。
