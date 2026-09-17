# L3 试卷工作台设计卡（v3.1）：题型空间（文件管理）× 试卷拼接 × 三模式 × 异步评卷

- **日期**：2026-09-16（v3.1 同日修订：明确做题单元 = Text 级文件，题型空间 = 文件管理器；v3：统一操作面 + agent 多级权限；v1 的"五能力域场所"模型已被取代）
- **状态**：**提案**（D1/D3 已按 09-16 反馈定案；D2/D4/D5/D6 待同学拍板；拍板后按 V0–V4 波次外派）
- **依据**：
  - 同学 2026-09-16 意图陈述（v2 升级）：①试卷的不同题型都可以设置子空间，索引得当可**按试卷质感拼接同一份试卷的全部题型**；②题目空间需要**三模式**——纯净模式（历史标记注释不显示）/ 做题模式（显示最近一次做题内容）/ 解析修正模式（答案审查后的标记注释；阅读题答案要落实到文中，需**专属标记方式**）；③不同空间的题目、阅读材料、重点词句笔记区的 UI 编排追求**最小摩擦**；④**不是为测试而测试**——用户主动上传自己想做的试卷，在平台上测试，追求极致体验；⑤标准答案由 agent 录入、支持 agent 评卷，**不需要实时判分**，本地 agent 在标准答案上传后深度解析；agent 可读用户标记、注释、错选；⑥错误类型（如"指代不明"等）结构化、agent 高可读可分析。
  - 同学 2026-09-16 v3 裁决：⑦**做题与读文章是同一次操作、不隔离**——venue 是材料+题组+笔记的统一表面，双层分类只是后台标签管线；⑧**agent 采用多级权限**（CodeBuddy/Trae 等本地项目 agent 可配置为可信角色），不必全部卡在 proposal 队列。
  - 同学 2026-09-16 v3.1 澄清：⑨做题单元是**一篇 Text**（如"2023 英一 Text 1"正文 + 该 Text 自己的题组），不是"整个题型的全部题目"；题型空间用**文件管理**方式承载选择与切换（在 23 年 Text A / 26 年英二 Text B 之间切换）；阅读文本和题目同属素材；整张试卷是文件的有序串联。
  - ADR-0019 §4（子空间轴/知识点 note/错题库派生）、ADR-0007（owner 直写可信面）、ADR-0029（agent proposal-only 边界）、ADR-0004 §6（L3 零 FSRS）
  - CONTEXT.md「Sub-space / Error book / Practice attempt / Proposal-only write」
  - `docs/design/l3-space/baseline.md` §1（E1–E4，积累型不催促）
- **代码根**：`wt-main/`

---

## 0. 背景与现状取证

### 0.1 三个"空间"是三种东西

| 名称 | 实质 | 代码 |
|---|---|---|
| L3 Context Space / 素材空间 | 整个 L3 子系统总称 | — |
| 词空间 Word Space | 以词为中心的检索检查器 | `L3WordSpacePage.tsx`（D5 改造对象，与本卡无关） |
| 子空间 Sub-space | 能力域轴 语法/阅读/作文/翻译/通用 | `l3_source_spaces` junction |

本卡的"题型空间"是子空间概念的**细化与重新定位**（见 §2.1 双层分类）。

### 0.2 子空间轴目前是"死轴"（V0 必修）

`l3_source_spaces`（schema.ts:931，迁移 0030）已建表/RLS/读侧 6 处 EXISTS 过滤，但**全代码库无任何写入路径**：契约无 spaces 字段、无 service/repository 写入方法、三个写入入口（批量导入/手动编辑/阅读视图）均无打标控件。今天练习页/错题库按 space 筛选恒为空集。

### 0.3 题型引擎与数据模型现状（与 v2 愿景的差距）

- 题型仅 `essay_dictation | context_quiz`（`src/domain/l3-practice-task.ts:40`，DB CHECK schema.ts:1250 锁死），作答对象恒为 context（句子），**无题目实体、无试卷实体、无作答卷、无评卷结果**。
- context 语义是"一个词在真实语料中的用法"（word-bound via occurrences），真题题干/选项/答案塞进去会污染图、词空间、阅读高亮全部读模型 → **题目/试卷必须独立建模**。
- attempts：`outcome correct/wrong/skip`、即时自评、无评分明细、无错误类型、无证据选择记录。
- proposal item_type 枚举仅 `source/context/occurrence/context_link`（schema.ts:1104），agent 要代录题目/答案/评卷结果，**产物通道需要扩展或新立同类管线**。
- 可复用：cloze 挖空引擎（定位/窗口化/词形提示）、bound_sense reveal 自评交互、会话攻坚计划（space×direction 抽题）、阅读视图双态壳、MCP 13 工具与 capabilities 发现、trgm 搜索、RLS own_all 全套先例。

---

## 1. 设计命题（v3.1）

**平台是薄的试卷工作台，智能在本地 agent 侧**：用户上传想做的试卷（agent 协助结构化录入），平台提供拟真卷面做题体验与三模式痕迹管理；做完不实时判分，agent 基于标准答案深度评卷，产出**结构化错误类型 + 文中证据定位 + 解析**，沉淀为可分析、可再练的错题资产。

**第一性原则（09-16 定案）：做题与读文章是同一次操作，不隔离。** 打开一个**做题文件**（一篇 Text：阅读正文 + 这篇 Text 自己的题组）就是一个统一表面——文章、题目、笔记同屏（桌面左文右题、移动文上题下），用户在文与题之间的视线/点击移动不触发任何页面跳转、模式切换或上下文丢失。注意粒度：一次加载的是**一个文件**（如"2023 英一 Text 1"+ 其 5 题），不是整个阅读题型的全部题目；文件之间的选择切换由空间内的**文件管理**承担（如换到 2026 英二 Text B）。所谓"双层分类"只是后台标签管线（§2.1），用户永远感知不到"材料管理"和"做题"是两个地方。

五个核心概念：

1. **做题文件（Practice File）**：最小做题单元 = 一篇 Text 的阅读正文 + 隶属它的题组（+ 笔记上下文）。阅读文本与题目同属素材，构成一个文件整体（§2.2）。
2. **题型空间（Question Venue）= 文件管理器**：按题型分化的空间，内部以文件列表承载选择与切换（完型/阅读/新题型/翻译/作文…），每个空间有专属的文件×题目×笔记编排（§3、§6）。
3. **试卷（Paper）**：跨题型文件的有序串联，一键拼接出整张试卷的拟真卷面（§2.3）。
4. **三模式（Modes）**：同一个文件/试卷的三种渲染状态——纯净 / 做题 / 解析修正。
5. **异步评卷管线（Grading Pipeline）**：作答卷 → 本地 agent 读痕迹与标注 → 评卷（错误类型/证据/解析）→ 确认或直入 → 错题与笔记沉淀。

体验基线沿用 baseline §1：积累型（做过的试卷、订正过的错题在长大）、不催促、不游戏化。

---

## 2. 核心模型

### 2.1 双层分类：能力域轴（保留）× 题型轴（新增）——后台管线，用户无感

**定案（D1，2026-09-16）**：维持双层，但它纯粹是后台标签管线；**做题统一面不受影响**（§1 第一性原则）。

| 层 | 取值（起步） | 挂在谁身上 | 作用 |
|---|---|---|---|
| 能力域 `space`（已有 5 值） | 语法/阅读/作文/翻译/通用 | **source（材料）** | 泛读素材归类、书架筛选、圈记世界 |
| 题型 `question_type`（**新增**） | `cloze` 完型 / `reading_choice` 阅读选择 / `new_question` 新题型（七选五·排序·小标题）/ `sentence_translation` 句译 / `short_essay` 小作文 / `long_essay` 大作文 / `grammar_blank` 语法填空 | **question / paper section（题目与卷面节）** | venue 布局选择、专属 UI、错题分析维度 |

关键设计：

1. **加载单位 = 一个做题文件**：打开某文件（如 `?venue=reading_choice&file=<id>`，或试卷的某一节）时，该 Text 的正文 + **仅该 Text 自己的题组** + 笔记区一次加载、一个表面，题目区滚动不丢文章位置（桌面左栏固定）。不存在"先去材料页再跳做题页"两步操作，也不会把别的 Text 的题拉进来。
2. **录入时自动打两层标签，用户不做两次分类**：agent 拆卷时，section 的 question_type 确定后，系统按映射自动给 source 落 space——`cloze/reading_choice/new_question → 阅读`、`sentence_translation → 翻译`、`short_essay/long_essay → 作文`、`grammar_blank → 语法`；owner 手动建卷同规则自动带入。source 打标从不需要用户在做题流程中分心。
3. 真实试卷里一篇 section 文本只服务一种题型（Text 1–4 选择、新题型另给文、完型另给文），双层不产生任何额外操作；材料层标签保留的价值只在**圈记世界**——公众号/外刊等无题泛读素材仍按能力域归集进书架，且未来若出现一文多用（同一篇外刊既出选择又出七选五的自组卷），双层天然支持，无需迁移。
4. 题型扩展 = 迁移扩枚举 + 注册一个题型 UI 配置（§3），不动空间架构。

> D1 已闭环：双层标签 + 统一操作面 + 录入自动带标。若实测中自动映射有缺（如混合题型 source），在 ADR-0030 增补映射表，不改变结构。

### 2.2 做题文件（Practice File）与空间内文件管理

**做题文件 = 最小做题单元**：一篇 Text 的阅读正文（source）+ 隶属它的题组（questions，含选项/标准答案/解析/证据锚点）+ 该文的笔记上下文。阅读文本和题目同属素材，文件是它们的容器，不是新的割裂页面。

- **不新增文件表（建议，D2 联动）**：文件是从既有数据派生的逻辑视图——`(source_id, question_type)` 上的题组聚合即一个阅读类文件（真实试卷一文一题型，聚合天然 1:1）；作文等无正文 source 的题组，文件由题组自身构成（题面即材料，source_id 为空）。试卷 section 是同一文件的"有序引用"（§2.3）。
- **题型空间 = 文件管理器**：进入"阅读选择"空间看到的是该题型下的文件列表（文件名如《2023 英语一 · Text 1》、题数、状态：未做/草稿中/已交卷/已评阅、错题数），支持年份/卷种（direction）/关键词筛选与搜索（复用 trgm 基建）。点文件 → 进统一做题表面；表面顶栏提供**上一文件 / 下一文件**与"返回文件列表"，切换不回首页、摩擦最小（如从 23 年 Text A 连续做到 26 年英二 Text B）。
- **文件状态即做题进度**：状态由该文件题组关联的最新 submission 派生（in_progress/submitted/graded），不另设状态字段（单一真源）。
- 文件可以不属于任何试卷（散题专练/题源库）；试卷只是把已有文件按真实卷面顺序串起来。

### 2.3 试卷（Paper）：文件的有序串联

- `l3_papers`：owner-scoped；`title`（如《2023 英语一真题》）、`direction`（考研/雅思，复用 0027 枚举）、`metadata jsonb`（年份/来源/时长）、`status`（draft/active/archived）。
- 卷面结构存 **paper.payload jsonb 有序 sections**，每个 section **就是对一个做题文件的有序引用**（实体引用 + 序号，沿用 ADR-0019"计划存引用、现拉现渲染"哲学，不存冻结产物、不复制文件）：

```jsonc
"sections": [
  { "key": "s1", "title": "Section I  Use of English", "question_type": "cloze",
    "source_id": "<真题完型全文>", "question_ids": ["q1..q20"] },
  { "key": "s2", "title": "Text 1", "question_type": "reading_choice",
    "source_id": "<阅读原文>", "question_ids": ["q21..q25"] }
  // …翻译、作文 section 无 source_id（题面即材料，文件由题组构成）
]
```

- 文件身份：阅读类文件 = `(source_id, question_type)`（真实试卷一文一题型，天然 1:1）；无正文题组（作文等）= 题组键（question_ids 或卷内 section key），散题文件由录入时分配的题组键定界。
- 拼接视图严格按 sections 顺序渲染文件，复刻真实卷面（题号连续、Section 分隔、作文留版心）；在卷内做题时顶栏提供"上一文件/下一文件"，跨 section 即跨文件。
- 文件先于试卷存在：散题专练/题源库里的文件可独立做；组卷只是把已有文件按真实顺序串起来。错题与题型空间按 question_type 运转，不依赖试卷。

### 2.4 三模式（视图状态，0 状态写入）

模式是纯前端渲染态（可进 URL：`?mode=pure|practice|review`），控制**痕迹层可见性**：

| 元素 | 纯净 pure | 做题 practice | 解析修正 review |
|---|---|---|---|
| 材料正文 + 题面 | ✅ | ✅ | ✅ |
| 用户历史笔记/高亮（note/occurrence 痕迹层） | ❌ 全隐 | ⏳ 仅最近一次作答相关（自标证据、自己的答案、草稿） | ✅ 全显 |
| 用户作答（选项/译文/作文） | ❌ | ✅ 恢复最近一次现场 | ✅ 只读陈列 |
| 标准答案 agent 证据标记（§2.5） | ❌ | ❌ | ✅ |
| 评卷结果/错误类型/解析（§2.6/§2.7） | ❌ | ❌（未评时显示"待评卷"） | ✅ + 订正笔记区开放 |
| 计时器 | 可选 | 可选 | ❌ |

- **纯净模式**：打开即一张干净卷面，适合打印/首做/重考。
- **做题模式**：进入自动恢复最近一次未交/最近一次作答现场（submission 草稿，见 §2.6），最小摩擦续做。
- **解析修正模式**：评卷确认后开放；逐题对照，标准答案证据在文中高亮，错误类型徽标，点击跳错句/错词；用户可写订正笔记（沉淀为 context_type='note'，与现有知识点体系同源）。
- 模式切换器固定在卷面顶栏；切换不丢作答（作答在 submission，不依赖渲染）。

### 2.5 专属标记：证据锚点（Evidence Anchors）

阅读/完型类题目的答案"落实到文中"需要专用标记，两套并存：

- **标准答案证据（agent 录入）**：question 携带 `evidence jsonb`：`[{start, end, label}]` 指向 source 文本区间（复用 occurrence position 锚点体系与高亮渲染），label 为题号。解析模式下文中区间染"标准答案色"。
- **用户自标证据（做题时）**：用户作答时可在文中点选"我认为答案在这里"，存进 submission answers 的 `evidence_pick`。评卷时 agent 连证据选择一起评——定位错段落本身就是错误（典型错误类型"证据定位错误"）。
- 与现有圈记高亮互斥渲染：做题/纯净模式下圈记痕迹层按 §2.4 隐藏，证据层独立绘制，避免两类标记互相污染选中文本（继承 09-13 P0-2 教训：注入标记文本不得进选区偏移计算）。

### 2.6 作答卷与异步评卷管线

新实体（全部 owner-scoped + RLS own_all）：

- `l3_questions`：题目（§2.1–§2.3 字段；`stem` 题干、`options jsonb`、`answer jsonb`（标准答案：选项 key / 参考译文 / 范文+评分要点）、`explanation`、`evidence jsonb`、`ordinal`、`source_id` 可空、`paper_id` 可空、`space`、`question_type`、`created_by`（owner / agent_id）、`status: pending|active|rejected`。普通 agent 提案落 pending，可信 agent（§4）直写 active。
- `l3_submissions`（作答卷/作答文件）：作用域二选一——`paper_id`（整卷作答，可空）或 `file_scope jsonb`（单文件作答：`{source_id?, question_type, question_ids[]}`，散题/单 Text 练习用）；`session_id` 可空（衔接 l3_sessions 攻坚包）；`status: in_progress|submitted|graded`、`answers jsonb`（`{qid: {choice|text, evidence_pick, saved_at}}`，**自动保存草稿**）、`submitted_at`。同一文件可多次作答（每次一行，最新一行 = 做题模式恢复现场）。**此表只由 owner 客户端写，任何级别 agent 不可写**（禁止 agent 伪造用户作答）。
- `l3_grading_results`（评卷结果）：`submission_id`、`question_id`、`verdict: correct|partial|wrong`、`score jsonb`（得分/满分，作文翻译用）、`error_tags text[]`（§2.7）、`evidence_ref jsonb`（agent 引用的文中区间）、`comment`（解析/订正建议）、`graded_by_agent_id`（服务端认定，ADR-0029 agentId 先例）、`lifecycle: proposed|confirmed|auto_confirmed`、`owner_corrected_at`。普通 agent → proposed（人确认）；可信 agent → auto_confirmed（直入错题库，但 owner 在解析模式可逐条改判，改判留痕）。

管线（非实时、平台零 LLM 预算；按 agent 信任级双路径）：

```
做题自动存草稿 (in_progress)
   └─ 用户"交卷" → submitted（不判分，立即解放用户）
        └─ 本地 agent 经 MCP 拉取：submission + 用户证据选择 + 用户标注/笔记 + 标准答案题目包
             └─ agent 深度评卷（同一 submit_grading 端点，按角色定 lifecycle，§4）：
                  ├─ agent（默认）→ proposed → 用户确认页逐题过 → confirmed
                  └─ trusted_agent → auto_confirmed（直入错题分析）
                                    └─ owner 仍可在解析模式逐条改判/补充（owner_corrected_at 留痕）
                       └─ 错题进题级错题库（wrong+partial）；错误类型可分析；订正笔记开放
```

- 题级错题库**派生自 confirmed / auto_confirmed 的 grading_results**（不建第二真相源，延续 ADR-0019 错题库哲学；owner 改判后按改判口径派生）；现有 `l3_practice_attempts` 继续服务句默写/语境自测（无题实体的旧题型），两套错题在错题库页按"题级/句级"分区。
- 红线：平台不引入 LLM 评卷预算（评卷智能在用户本地 agent）；L3 仍零 FSRS——"再练"由错题库与攻坚计划驱动，无 due。

### 2.7 错误类型分类法（D4 已定案 2026-09-16，基于主流考研教学口径调研）

**结构（定案）**：服务端常量单一真源 `src/domain/l3-error-taxonomy.ts`，每项 `{ code, zh, appliesTo: question_type[] }`；grading 提交只收 code（zod 校验，不用 DB CHECK，演进免迁移）；zh 显示名可改不动数据；capabilities/`get_grading_taxonomy` 导出同一真源。每题多 tag、**首元素为主错误**；自由解析走 `comment`（封闭枚举不限制表达）。

**v1 正式清单**（调研依据：考研阅读干扰项主流分法——偷换概念/无中生有/过度推断/正反混淆/因果倒置/扩大范围/答非所问/移花接木等；翻译阅卷四大失分——信息遗漏/逻辑断裂/指代含混/语序与表达偏差；大小作文评分维度）：

| code | 中文名 | 适用题型 |
|---|---|---|
| `reading.evidence_location` | 证据定位错误（没找对出题句） | cloze/reading_choice/new_question |
| `reading.substitution` | 偷换概念（主体/对象/范围/修饰词暗换、张冠李戴） | cloze/reading_choice/new_question |
| `reading.unsupported` | 无中生有（原文无依据/常识脑补） | reading_choice/new_question |
| `reading.over_inference` | 过度推断（一步以上引申、程度夸大、必然化） | reading_choice |
| `reading.opposite` | 正反混淆（语义/否定/态度方向相反） | cloze/reading_choice/new_question |
| `reading.scope_creep` | 扩大范围（部分→全部、可能→必然、绝对化） | reading_choice/new_question |
| `reading.cause_effect` | 因果倒置/强加因果（非直接等价） | reading_choice |
| `reading.wrong_target` | 答非所问（选项本身对但不对应题干角度） | reading_choice |
| `reading.patchwork` | 移花接木（拼接原文两处无关信息） | reading_choice/new_question |
| `reading.main_idea` | 主旨偏差（以偏概全/标题误判） | reading_choice/new_question |
| `reading.attitude` | 态度误判（极端词/中立方向） | reading_choice |
| `reading.word_meaning` | 词义误判（熟词僻义/语境义） | cloze/reading_choice |
| `reading.reference` | 指代不明（this/it/such 还原错） | cloze/reading_choice/new_question |
| `reading.logic_connective` | 逻辑关系误判（转折/让步/因果/对比连接词） | cloze/reading_choice/new_question |
| `cloze.collocation` | 固定搭配错 | cloze/grammar_blank |
| `cloze.context_recovery` | 上下文复现线索漏判 | cloze |
| `newquestion.cohesion` | 衔接线索误判（七选五/排序：指代+连接词+关键词复现） | new_question |
| `trans.omission` | 漏译/采分点遗漏（信息遗漏，最高频失分） | sentence_translation |
| `trans.word_choice` | 词义误译（核心词/熟词僻义/术语） | sentence_translation |
| `trans.reference` | 指代还原错误 | sentence_translation |
| `trans.syntax` | 句法主干误判（从句/修饰层/被动/否定） | sentence_translation |
| `trans.logic` | 逻辑连接词错译漏译（逻辑断裂） | sentence_translation |
| `trans.word_order` | 语序僵化/长句切分重组失败 | sentence_translation |
| `trans.chinglish` | 译文生硬（翻译腔/词性不转换） | sentence_translation |
| `essay.off_topic` | 跑题/寓意误读（大作文图画、小作文情境） | short_essay/long_essay |
| `essay.format_register` | 格式语体错误（书信格式/称呼落款/语气得体） | short_essay |
| `essay.points_missing` | 要点遗漏/覆盖不全 | short_essay/long_essay |
| `essay.structure` | 结构缺失（三段论/段落组织） | long_essay |
| `essay.development` | 论证单薄（论点不足/展开无力） | long_essay |
| `essay.cohesion` | 连贯衔接弱 | short_essay/long_essay |
| `essay.vocabulary` | 用词不当/口语化/单调 | short_essay/long_essay |
| `essay.grammar` | 语法错误 | short_essay/long_essay |
| `essay.length` | 篇幅不足/超限 | short_essay/long_essay |
| `grammar.morphology` | 词形变化错（名/形/副/比较级） | grammar_blank |
| `grammar.tense_voice` | 时态语态/非谓语错 | grammar_blank |
| `grammar.clause` | 从句引导词/句法成分误判 | grammar_blank |
| `grammar.function_word` | 介词/冠词/连词错 | grammar_blank |

演进纪律：新增 code = 常量加值 +  capabilities 自动导出（无 DB 迁移）；废弃 code 标记 deprecated 不删除（历史 grading 可解释）；错题本按 code 聚合（"近 5 套卷指代不明 4 次"），是薄弱题型推荐的输入。

---

## 3. 题型空间与 UI 编排草案（最小摩擦）

每个题型空间由两部分组成：**文件管理列表**（该题型下的做题文件：筛选/搜索/状态/错题数，见 §2.2）+ **做题表面**（打开一个文件后：材料 × 题目 × 笔记同屏）。下表只定义做题表面的题型分化；列表与顶栏（模式切换、上/下一文件、返回列表）全题型共用。

| 空间 | 材料区（当前文件正文） | 题目区（仅当前文件题组） | 笔记/痕迹区 |
|---|---|---|---|
| 完型 cloze | 全文内嵌空号（cloze 引擎换皮：序号空位而非词面挖空，20 空一屏） | 同屏题号快捷条 + 当前空选项卡 | review 模式空号旁浮出证据+解析 |
| 阅读选择 | 桌面左文右题（文不动题滚动）/ ≤480px 文上题下 + 段落题号导航；新题型同布局 | 题卡：题干 + 选项纵列 + "我标证据"按钮 | 右侧/底部抽屉：词卡跳转、圈记、订正笔记 |
| 新题型（七选五/排序/小标题） | 文内空框 + 备选库悬浮（拖拽或点选，决策点 D5） | 选项库与空框双栏 | 同阅读 |
| 句译 | 划线句视觉（原文整段、划线句高亮） | 逐句卡：译文 textarea + 参考译文折叠 | review：逐句对照 + 错误 tag 行内标 |
| 小/大作文 | 题面卡（图画/图表/书信说明；图画图片位见 V4） | 稿纸感宽行距写作区（字数统计、可选计时器） | review：范文对照 + 评分要点逐项 |
| 语法填空 | 短文内嵌空号 | 空号快捷条 + 输入卡 | 知识点 note 卡（context_type='note' 按 space=语法 聚合） |

公共编排原则：① 一个题型空间 = 文件列表视图 + 做题表面视图，做题表面按题型配置表渲染（布局组件/选项组件/判分形态），新增题型只注册配置；② 材料/题目/笔记三区的比例与顺序由题型配置定，不写死；③ 所有题型共用文件列表、三模式顶栏、证据层、草稿自动保存、交卷/评卷状态条；④ 重点词句入口永远一跳到词卡（继承 FR-6 双向跳转）；⑤ 文件切换（列表选择、上/下一文件）只换文件内容，不离开做题表面、不丢顶栏状态。

---

## 4. Agent 与 MCP 面：多级权限（D3 定案）

**定案（D3，2026-09-16）**：agent 采用**两级角色**——外部/陌生 agent 仍守 proposal-only；owner 在本地配置的项目 agent（CodeBuddy/Trae 自定义 agent 等）可授 `trusted_agent`，在**白名单面**直写 active，跳过提案队列。依据：agent 运行在 owner 本机、用 owner 配置的 token，可信度等价于"owner 的自动化手"；但信任必须显式授予、面必须收窄、动作必须可回溯可改判。

### 4.1 角色与能力矩阵

| 面 | owner | `agent`（默认） | `trusted_agent`（本地可信） |
|---|---|---|---|
| 全量读取（sources/contexts/题/卷/作答/标注） | ✅ | ✅ | ✅ |
| 现有 proposal 通道（圈记/关联/导入建议） | ✅ | ✅（pending） | ✅（pending，仍走审查） |
| 建卷/录题（papers/questions，含标准答案/evidence） | ✅ 直写 | pending 提案 → owner 确认 | **✅ 直写 active** |
| 评卷结果（grading_results） | ✅ | proposed → owner 确认 | **✅ auto_confirmed 直入错题分析** |
| 作答卷 submissions（用户答案/草稿/交卷） | ✅（仅 owner 客户端） | ❌ | ❌ **任何 agent 永不可写**（防伪造作答） |
| 删除（题/卷/材料/grading） | ✅ | ❌ | ❌（删除面不开放，只可订正不可销毁） |
| L1/L2/FSRS、晋升 confirm、词书/设置 | ✅ | ❌ | ❌（信任级不跨界，三轨隔离不松） |

### 4.2 配置与执行机制

- token 配置扩展为三段式 `agentId:token[:role]`（[agent-tokens.ts](file:///D:/Temp/Myawesomeapp/vocab-ob'/wt-main/src/config/agent-tokens.ts) 解析器升级）：缺省第三段 = `agent`（**默认最小权限**，旧配置零改动）；role 仅接受 `agent|trusted_agent`，非法值启动 fail-fast；token 仍禁含冒号、禁与 OWNER_API_TOKEN 相同。
- `Principal` 携带 agentRole；路由最小角色注册表（`9baf377` 建立的 minRole 机制）为新端点标 `trusted_agent`；同一写入端点对两级角色**一条代码路径**——service 按角色决定产物 lifecycle（pending vs active/auto_confirmed），禁止维护两套端点。
- 直写结果的软护栏：题目/评卷一律记 `created_by` / `graded_by_agent_id`（服务端认定，非自报）；可信评卷 `auto_confirmed` 后 owner 在解析模式仍可**逐条改判/补充**（`owner_corrected_at` 留痕），错题库按改判口径重算——信任不等于不可纠错。
- 撤销 = 改 env 重启（ADR-0029 语义不变）；审计：trusted 直写动作进现有 telemetry/request-id 日志（`60804d2`），可按 agentId 检索。
- `get_capabilities` 广告当前调用者的角色与各面 lifecycle（proposal/direct），MCP 工具描述按角色动态提示"你的写入将直入 / 需确认"。

### 4.3 MCP 工具清单（新增）

| 工具 | 方向 | 最低角色 | 内容与产物 lifecycle |
|---|---|---|---|
| `submit_paper` | 写 | agent | 试卷结构化包（paper meta + sections + 题目：options/标准答案/解析/evidence 锚点），幂等 input_hash（0031 范式）；agent→pending 包走审查流，trusted→直接 active 并自动落 source space 映射（§2.1） |
| `list_papers` / `list_practice_files` / `list_questions` | 只读 | agent | 试卷、空间内做题文件（按 question_type/direction/做题状态过滤）、题源库检索 |
| `list_submissions` / `get_submission` | 只读 | agent | 拉作答卷：用户答案、自标证据、做题痕迹（只读，不可写） |
| `read_source_annotations` | 只读 | agent | 读用户材料上的圈记/笔记（occurrences/notes，评卷上下文） |
| `submit_grading` | 写 | agent | 批量评卷（verdict/score/error_tags/evidence_ref/comment），幂等键 (submission_id, agent_id)；agent→proposed 待确认，trusted→auto_confirmed |
| `get_grading_taxonomy` | 只读 | agent | 错误类型枚举（服务端常量单一真源导出，进 capabilities） |

- 普通 agent 的 pending 产物 UX 复用现有 L3ProposalPage 审查流（整包一键确认 + 逐题驳回）；proposal item_type 扩展（paper/question/grading）或新实体内置 pending 状态通道，实施时二选一。
- **ADR 要求**：ADR-0029 的 proposal-only 被本卡收窄（新增 trusted 例外），必须由 **ADR-0030** 显式 `Amends ADR-0029` 并写明白名单面、禁写面（submissions/删除/L1L2）、配置与留痕要求；同 ADR 记录题目与 context 分离、grading 非实时、平台零 LLM、taxonomy 归属。V1 开工前 Accepted。
- MCP 文档 `docs/operations/mcp-server.md`、授权注册表（F 类）、capabilities 同步；api:governance 六步全走；角色拒绝测试（agent 调 trusted 面 → 403；trusted 写 submissions → 403）为必交测试。

---

## 5. 数据与迁移影响汇总

| 波次 | DDL | 说明 |
|---|---|---|
| V0 | 0 DDL（junction 已存在） | 接通 l3_source_spaces 写入：契约 spaces 字段 + service/repo replace（事务 delete+insert）+ 导入/编辑/阅读视图打标 + 书架筛选 chips |
| V1 | `l3_questions` / `l3_papers`（payload jsonb，不建 sections 表）+ 枚举 question_type；RLS own_all；agent token 三段式 role 解析 + minRole 注册表扩展 | owner 直写 + 双级 agent（pending / trusted 直写）；source space 自动映射 |
| V2 | 0 DDL | 空间文件管理列表（含状态/筛选）+ 试卷拼接渲染 + venue 题型配置（文件做题统一面）+ 三模式可见性 + evidence 锚点渲染 |
| V3 | `l3_submissions` / `l3_grading_results` + verdict 扩 `partial`；RLS own_all；grading lifecycle 三态 | 自动草稿、交卷、双路径评卷（proposed / auto_confirmed）、owner 改判、题级错题库 |
| V4 | 视选项 | 作文图画图片位/粘贴图片（无 OCR）、整套计时、题型再扩 |

纪律：每个 DDL 迁移配 schema.ts 同步 + RLS policy + bootstrap-database-roles converge + verifier 期望（授权双落点，0023–0025 先例）+ db:schema:drift；快照链 id 唯一性检查（0023–0026 教训）。

---

## 6. 信息架构（入口与动线）

- 侧栏不膨胀：现有 12 section 不加 7 个题型项。**素材宇宙**新增"试卷与题型"入口区：① 我的试卷（最近上传/最近未做完）② 题型空间 chips（完型/阅读/…，带题级错题数）。
- venue 是**一个**参数化 section，两级视图：`?venue=reading_choice` = 该空间的**文件管理列表**（《2023 英一 · Text 1》…，年份/卷种/状态/错题数筛选搜索）；`?venue=reading_choice&file=<文件键>` = 该文件的**做题表面**（文题同屏，顶栏返回列表/上一文件/下一文件）。整卷是 `?paper=<id>&mode=pure|practice|review`（按 sections 串联文件）。与 handoff/nonce 模式一致。
- 主动线：**上传试卷或真题文件**（素材宇宙/书架入口；owner 粘贴文本直写，或 agent 经 MCP 录题——普通 agent 一键确认、trusted agent 直入，拆卷自动产出各题型文件）→ 进题型空间在文件列表里选一篇 Text → 纯净模式首做（左文右题、自动草稿，顶栏随时切换文件）→ 交卷 → 本地 agent 异步评卷（普通 agent 结果待确认）→ 解析修正模式订正（证据/错误类型/笔记/改判）→ 错题库按题型再练 → 攻坚包（l3_sessions cram_pack 按 question_type 抽题）。
- 空态积累型口吻（如题型空间 0 文件："上传一份真题，或让 agent 帮你把试卷拆成文件录进来，考场就会在这里长出来"）。

---

## 7. 分层路线

- **V0 · 接通死轴**（S–M，0 新表）：spaces 写入闭环 + 书架筛选。表单直接中文文案（避免 D5-R3 返工）。
- **V1 · 题/文件/卷入库 + agent 分级**（L）：questions/papers 模型（文件为题组派生视图，0 文件表）+ owner 粘贴建卷（最小可用表单：按 Text 拆文件 + 题 + 选项 + 答案）+ agent 三段式角色配置与 `submit_paper` 双 lifecycle 通道（pending 审查 / trusted 直写 active，拆卷自动产出文件与 space 映射）+ 题源库列表。ADR-0030（Amends ADR-0029）先行。
- **V2 · 文件管理与卷面做题台**（L，体验核心）：题型空间文件管理列表（状态/筛选/上下文件切换）+ 试卷拼接拟真卷面 + venue 题型配置（先做 cloze / reading_choice / sentence_translation 三种做题表面：单文件材料+题组+笔记一次加载）+ 三模式 + 证据锚点双标记层 + 草稿自动保存/交卷。
- **V3 · 异步评卷闭环**（L）：submissions（文件/卷双作用域）/gradings + MCP 只读工具（题/卷/文件/作答/标注 + taxonomy）+ `submit_grading` 双路径（proposed 确认页 / trusted auto_confirmed）+ owner 逐条改判 + 错误类型 taxonomy + 题级错题库 + 订正笔记。
- **V4 · 增强**（有真实使用数据后再排）：新题型（七选五拖拽、作文整文）、图画题图片位、整套计时、雅思题型族、音频（衔接 deferred 的 media 模型）、taxonomy 回看校准、薄弱题型推荐（衔接 recommendation 引擎）。

每波独立可验收、独立提交；V1 前 ADR-0030 必须 Accepted；V2/V3 UI 卡遵守截图验收纪律。

---

## 8. 待拍板项（同学收口）

| # | 决策点 | 选项 | 结论/建议 |
|---|---|---|---|
| D1 | 分类架构 | (a) 双层：能力域挂材料 + question_type 挂题；(b) 直接把 space 扩成题型枚举挂材料 | **已定案 (a)**（09-16）：做题单元 = Text 级文件、文题同屏（§1/§2.2），一个文件一次加载，录入时按题型自动落材料 space，用户不做两次分类 |
| D2 | 卷面 sections 存储 | (a) paper.payload jsonb 有序引用（现拉现渲染）；(b) 独立 l3_paper_sections 表 | **已定案 (a)**（09-16）：学 l3_sessions.plan（引用+payload.version+服务层校验），护栏 = 写入校验引用归属 / 渲染降级占位 / 删题被 active 卷引用走 409 blocker；0 新表 0 新 RLS |
| D3 | agent 录题/评卷写入边界 | (a) 全部 proposal-only；(b) 全直写；(c) **两级角色**：agent 走提案，trusted_agent 白名单面直写 | **已定案 (c)**（09-16，§4）：三段式 token 配置、默认最小权限、禁写 submissions/删除/L1L2、留痕可改判；ADR-0030 显式 Amends ADR-0029 |
| D4 | 错误类型起步集 | §2.7 清单 | **已定案**（09-16，授权我调研定夺）：37 个 code 的 v1 清单（§2.7），主流考研教学口径；code 稳定、zh 可改、常量单一真源、免迁移演进 |
| D5 | 新题型作答交互 | (a) 点选填充；(b) HTML5 拖拽；(c) 两者都做 | **已定案 (a)**（09-16）：V2 七选五/小标题共用配对组件（点选项→点空框），排序题用上移/下移按钮；拖拽统一列 V4。answers 存储与交互解耦 |
| D6 | 草稿与交卷 | (a) 自动草稿+显式交卷；(b) 手动保存 | **已定案 (a)**（09-16）：逐题防抖 PATCH 按 qid merge、单作用域一行 in_progress（部分唯一索引）、未答题交卷走**软确认不硬拦**、submitted 冻结、重做新开一行；评卷触发靠 agent 拉取（+复制指令按钮），无 webhook/轮询 |

---

## 9. Non-goals 与红线

- L3 **零 FSRS** 不动：无 due、无 stability；题级错题只派生视图与攻坚计划（ADR-0004 §6 / ADR-0019）。
- 平台侧**不接 LLM 评卷/拆题预算**：智能在本地 agent；平台只提供结构化通道。是否未来开平台 LLM 须另立 ADR。
- **不做实时判分**：交卷即解放；评卷异步。
- **agent 写入按级分权（D3 定案）**：默认 agent 一律 pending 提案；仅显式配置的 trusted_agent 可在白名单面（录题/评卷）直写；**任何 agent 永不可写 submissions、不可删除、不可触 L1/L2/FSRS**；角色服务端认定、默认最小权限、动作留痕可改判（§4）。
- 不重写阅读视图与圈记核心：三模式与证据层是叠加层，纯 mark/标号隔离/选区偏移纪律（09-13 P0-2 教训）继续生效。
- 不做用户自定义子空间/题型（固定枚举起步，ADR-0019 同纪律）；不做游戏化/催促（baseline §1）；OCR、自动 URL 抓取、视频播放不进 V0–V3。
- 题目与 context（词的用法）严格分离，互不污染读模型。
- 本卡与 D5 信息层卡解耦并行；V0 起所有新 UI 直接中文 + 积累型文案 + 设计 token，不新增英文工程文案。

---

## 10. 验收（继承 UI 卡与门禁纪律）

- 每波 UI 交付：基线条目引用 + 前后截图（`deliverables/software-company/<audit>/screenshots/`，仅文档入库）+ 空/加载/错/满受影响态 + 明暗双主题 + ≤480px 移动截图（左文右题必须给移动堆叠态）；三模式每个至少一张同屏对比；缺一不收口。
- 门禁：typecheck / arch:check（domain 新生成器纯函数零出向）/ test:unit（分层覆盖 + diff ≥85%）/ frontend:build；涉 API 走 api:governance 六步 + OpenAPI/client 再生；涉迁移走 db:schema:drift + RLS 验收 + roles converge/verifier；MCP 工具进授权注册表 F 类 + capabilities + runbook。
- 题型生成/评分 domain 函数：确定性、无答案不出题、作答前剥离答案，先例照 `l3-practice-task.ts`。
- 评卷管线幂等：同 (submission, agent) 重复提交回读不重复建（23505 回读范式）。
- agent 分级必交测试：三段式 token 解析（缺省 role=agent、非法 role fail-fast、旧两段配置零行为变化）；普通 agent 调直写面 403 且产物落 pending；trusted_agent 录题直 active、评卷直 auto_confirmed；**任何角色写 submissions / 删除 / L1L2 面一律 403**；capabilities 按角色返回不同 lifecycle 广告。
- V1 开工前 ADR-0030 Accepted；推送/CI 与本卡解耦，但 37 个存量未推送提交建议先合并减压（见 2026-09-16 进度汇报）。
