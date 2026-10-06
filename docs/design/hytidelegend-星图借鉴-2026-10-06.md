# 词汇星图的借鉴分析（主线：记单词）

> 日期：2026-10-06
> 源：`D:/Basic-Tools/HytideLegend/applications/词汇星图`（本机单用户词典 + 图谱 + 背诵计划应用）
> 目标：`F:/dev/vocab-ob/wt-main`
> 前置：`hytidelegend-功能借鉴-2026-10-06.md`（那份没覆盖星图的图谱部分，本文补上）
> 配套原型：`deliverables/lexical-relations-proto-2026-10-06.html`（实测数据，算法现场可算）

---

## ⚠️ 修正（2026-10-06 晚，本文第一版有两处结论错误）

第一版我只按星图的字段名去 grep（`inflection` / `derivative`），命中 0 条，
就下了「vocab-ob 三套全缺」的结论。**这是错的。** 本项目用的字段名不同，语义相同：

| 我说的 | 实际情况 | 证据 |
| --- | --- | --- |
| vocab-ob 没有 `inflections` | **有** —— 叫 `aliases` | `docs/operations/l1-vocabulary-md-format.md:106`：「`aliases`: **inflections**, spelling variants, or common alternate forms」；映射到 `words.aliases` |
| vocab-ob 没有 `derivatives` | **有** —— 叫 `morphology_family` | `collection-parser.ts:244`；`ReviewCardView.tsx:262` 已在 Tier 2 渲染 |

**真实的问题不是「缺字段」，是另外两个，而且都有实测数据：**

| 实测项 | 数字 | 位置 |
| --- | --- | --- |
| 词表总词数 | **3446**（22 个批次） | `data/corpus/L1_雅思词汇/` |
| `aliases` 覆盖率 | **62.2%**（2143 词） | 同一份词书 |
| **完全没有屈折词形** | **1303 词（37.8%）** | 其中 `娱乐运动` 179 词、`行为动作` 264 词**一个都没填**；`学校教育` 401 词只填了 3 个 |
| `family` 覆盖率 | **100%** | 但语义混杂，见 §一之二 |
| `EMPTY` 哨兵 | **1771 次** | 另有 **149 行**夹了中文注释，如 `EMPTY（语源 uncertain）` |

所以本文的结论方向要改：**不是「新建三个功能」，是「修补两个已有字段的质量」**。
这个转变让结论更保守也更有依据 —— 也意味着以前那份「P0 之后插入」的排期建议要跟着调。

下面各节保留原结构，但在标题后标出修正后的口径。

---

## 摘要

星图是个大件：词典 + 力导向图谱 + 背诵计划（它自己同时实现了艾宾浩斯和葫芦）。
但**对本项目最值钱的不是那个图谱**。

真正值得拿的是：它为了把图谱喂饱，建了**三套「词与词之间关系」的推导机制**。
这三套东西在 vocab-ob 里**全部缺失**，而且每一套都直接服务「记单词」这条主线。

| 星图的组件 | vocab-ob 现状（已修正） | 结论 |
| --- | --- | --- |
| 规则推导屈折词形 | **有字段无覆盖**：`aliases` 只填了 62.2%，1303 词全空 | **最值得拿**：拿的是**自动推导**，不是字段 |
| 同族派生词 | **有字段，语义混杂**：`morphology_family` 100% 填了，但混屈折、混远亲、混自由文本 | 拿的是**语义收边界**，不是字段 |
| 拼写易混词对（LCS ≥ 0.75 + 三重排除） | **真·全缺** | 值得拿，且依赖前两项的数据 |
| 图谱可视化（力导向画布） | 无（词汇广场是列表式集合） | **不抄**，与本项目定位冲突 |
| 艾宾浩斯固定排程 | 有 FSRS | 不抄（旧结论不变） |
| 熟悉度 per-project / 收藏跨项目 | 有 per-wordbook 进度 | 不抄 |

---

## 一、先排掉一个容易搞混的点

星图的 `familyId` 和 vocab-ob 已有的「词根家族」**不是一回事**。这两者正交，可以共存。

| | vocab-ob 已有 | 星图的 familyId |
| --- | --- | --- |
| 依据 | `metadata.morphology_root`，按 `+` 拆 token | 词条自己的 `familyId`，跨词条合并 |
| 例子 | `abandon` = `ab`+`band`+`on` → 归入含 `band` 词根的集合 | `abandon / abandoned / abandoning / abandonment` 是一族 |
| 语义 | **同词根**（形态学聚类，靠词源相似） | **同词族**（同一词的各种形态与派生） |
| 落点 | 词汇广场 `root_affix` 集合（Phase 2 已实现，`PLAZA_ROOT_SLUG_PREFIX`） | 无 |

一句话：vocab-ob 现在会告诉你「这个单词由什么词根构成」，
但**不会**告诉你「这个词的过去式怎么写、它的名词形式是什么」。

### 已核实的现状

**vocab-ob 有：**
- `words.aliases text[]` + GIN 索引（`schema.ts:161,192`）—— 别名
- `metadata.morphology_root / morphology_prefix / morphology_suffix` —— 词根词缀
- 词汇广场两套集合：`semantic_field`（按 L1 批次）与 `root_affix`（按词根，Phase 2 已实现）
- L1 收藏集（教材笔记，`WordNotes.tsx:26`，只读渲染）

**vocab-ob 有字段（见修正）：**
- `aliases`（= 屈折词形，`string[]`，`schema.ts:161` + GIN 索引 `:192`）
- `metadata.morphology_family`（= 同族派生，`string[]`，`collection-parser.ts:244`）
- 两者**都已在 Tier 2 渲染**：`ReviewCardView.tsx:262` 读 `morphology_family`，
  `WordDetailPage.tsx:221` 同样

**vocab-ob 真的没有：**
- 拼写相似 / 易混词对
- 词形还原（`grep lemma/lemmatiz/词干` 命中的 `stem` 全是「题面 question stem」，不是词干）
- **`aliases` 的自动推导**（现在靠人工手写笔记，实测覆盖率 62.2% 且批次间不一致）
- **`family` 的语义边界**（现在混了屈折、远亲与自由文本）

**星图有：**
- `skills/build-word-entry/scripts/rule_inflections.py` + `utils/scripts/english_inflections.py`（带 `RULE_VERSION`）
- `skills/build-word-entry/scripts/family_review.py`（Agent 审核状态机）
- `skills/build-word-entry/scripts/spelling_relations.py` + `utils/scripts/dictionary_spelling.py`

---

## 二、修补一：屈折词形的覆盖率（最值得拿）

> 修正后口径：**字段已有（`aliases`），缺的是自动推导**。要解决的是 1303 个词的缺口，
> 不是从零建字段。

### 星图怎么做

`rule_inflections.py` 的文件头写得很直白：

> Publish conservative, **explicitly pending** rule-derived inflections.
> This workflow **needs no Agent decision**. Its plan is durable and can be resumed after interruption.

产出的每个词形带两个标记：

```python
{"generationMethod": "rule_derived", "verificationStatus": "pending", "sourceRefs": []}
```

即：**规则算出来的，明确标「待核验」，不冒充证据。** 有直接来源证实时才升级为 `source_supported`。

### 为什么这个对 vocab-ob 值钱（三个层面，一个比一个重要）

**① 同一本词书内部，信息标称不一致（实测）。** 这是最有说服力的一条：

| 批次 | 词数 | 有 aliases | 覆盖率 |
| --- | --- | --- | --- |
| 交通旅行 | 93 | 92 | **99%** |
| 动物保护 | 168 | 157 | 93% |
| 身心健康 | 426 | 245 | 58% |
| 物品材料 | 151 | 66 | 44% |
| 时间日期 | 53 | 26 | 49% |
| **学校教育** | **401** | **3** | **0.7%** |
| **娱乐运动** | **179** | **0** | **0%** |
| **行为动作** | **264** | **0** | **0%** |

取真实例子，同一个词书里：

- `alternate`（在填得好的批次）：`aliases: alternated, alternates, alternating` ✅
- `adopt`（在 `行为动作` 批次）：`aliases:` **空**，而它是考研高频词 ❌

用户复习到 `adopt` 时，卡上不会出现 `adopts / adopted / adopting`；
复习到另一个批次的词时却会。**用户不会知道这是漏了，只会以为自己记不住。**

**② 跨模块：解决 L3 圈记的匹配问题。** 你在阅读里遇到 `abandoned`，圈记时如果按词面匹配，
命中不到词条 `abandon`。有了屈折映射，可以归一到词元。**这是 L3 的静默失败，用户看不见。**

**③ 反查可用。** 用户输入 `abandoned` 搜词，现在只能靠 `aliases` 硬编码 ——
而这 1303 个词压根没硬编码。有了规则推导，任何规则内的词形都能反查。

### 关键设计智慧（必须一起抄）

**「待核验」这个状态标记是核心，不是装饰。**

规则推导一定会错（`lie` 的过去式是 `lay` 不是 `lied`，`go` 是 `went`）。
星图的处理不是「提高规则准确率」，而是：
- 规则推导的标 `rule_derived` + `pending`，**和来源证实的严格区分**
- 界面分别呈现（README：规则推导词形标注「规则推导 · 待核验」）
- 有来源证实后，原记录**升级**状态，而不是新增一条

这和本项目 `generationMethod × verificationStatus` 的既有纪律是同构的
（见 `hytidelegend-启示-2026-10-05.md` 的溯源元模型）。**抄规则的同时要抄这个状态机。**

### 成本

低。纯确定性规则，不需要 Agent，不需要新表 —— 挂在 `metadata` 里即可（和 `morphology_*` 并列）。

---

## 三、新增一：拼写易混词对（这一项**真的**全缺）

> 修正后口径：前两节是「有字段、质量崩」，这一节是唯一一个**从零开始**的新功能。
> 而且它依赖前两节的数据 —— 排除表要用 `aliases` 和 `family`。

### 星图怎么做

`dictionary_spelling.py` 的核心是一个阈值加**三重排除**：

```python
def is_excluded(left, right, excluded, family):
    return (left == right
            or tuple(sorted((left, right))) in excluded
            or (left in family and right in family and family[left] == family[right]))
```

阈值：`8 * lcsLength >= 3 * (len(left) + len(right))`，即 LCS 相对平均长度 ≥ 0.75
（Schema 里的 `threshold: {numerator: 3, denominator: 4}`）。

三重排除分别排掉：
1. **同一个词**（`left == right`）
2. **别名与屈折词形**（`excluded` 集合由 `aliases` + `inflections` 构成）
3. **同族词**（`family[left] == family[right]`，用 `canonical_family_ids` 归一）

**这个排除表是全部价值所在。** 没有它，LCS 会把 `abandon / abandoned`（同族，不是易混）、
`aircraft / airplanes`（别名）全都算成「长得像」，噪声会淹没信号。

而且排除表**是动态的** —— 依赖前面的屈折词形和词族。三个缺口不是三个独立功能，**有依赖顺序**：

```
屈折词形（纯规则）
    └→ 拼写易混的词对排除表要用它
词族/派生（需 Agent）
    └→ 拼写易混的词对排除表也要用它
```

### 为什么对 vocab-ob 值钱

背单词的错误有大类来自**拼写混淆**：`adapt / adopt / adept`、`affect / effect`、
`principal / principle`、`stationary / stationery`。这类错误的特点是：

- **不是没记住意思，是记串了**
- FSRS 的 rating 会反复给 `again`，但系统**不知道原因**，只会缩短间隔
- 错题库现在只覆盖 L3 做题，看不到「这个用户总是混淆这几个词」

**直接对接点**：错题库（`L3ErrorBookPage.tsx`，已合并题级 + 句级两条腿）可以再加一条腿 ——
若某个错题的作答词与正确答案构成「易混对」，在错题条目上标出来。
这不是新建表（错题库是派生视图，CONTEXT.md 立过规矩），是在读侧多一个 join。

### 成本

低-中。LCS 是确定性算法，但**需要先有前面两项的数据**才能算得干净。

---

## 四、修补二：`family` 的语义边界（成本最高）

> 修正后口径：**字段已有且 100% 填了**，问题是它同时装着三样东西。
> 实测抓到的混杂（`data/corpus/L1_雅思词汇/`）：

| 原始数据 | 混杂了什么 |
| --- | --- |
| `family: adopt, adoption, option, adoptive` | 含词条自身 + 派生 + **远亲**（`option` 同源于拉丁 `optare`，但现代英语是两个词） |
| `family: accord, according, accordingly, concord, discord` | **屈折**（according）+ 派生（accordingly）+ 同源异词（concord / discord） |
| `family: act, action, active, actor, agent, agenda` | `agent` / `agenda` 已不是同族 |
| `family: amaze, amazing, maze` | `maze` 与 `amaze` 同源，现代英语是两个词 |
| `family: EMPTY（"蝙蝠"义为另一来源 ME bakke）` | **自由文本混进结构化字段**，共 149 行 |

格式文档自己给的例子 `"family": ["abandoned", "abandonment"]` 里，
`abandoned` 本身就是屈折 —— **说明「family」和「aliases」的边界从定义上就没分清**。

### 要做的两件事

1. **屈折移出 family**：`according`、`abandoned` 这类归 `aliases`（它本来就是干这个的）。
2. **远亲移出 family**：`option` / `agent` / `maze` / `concord` 这类同源异词不进词族 ——
   放进词族会让用户以为可以互换。

至于 `EMPTY（语源 uncertain）` 这类 149 行：解析器按 `[,，]` 切分，整段注释会变成数组成员，
界面上会直接显示成「词族：EMPTY（"蝙蝠"义为另一来源 ME bakke）」。这是**渲染层的脏数据**，
需要单独收口（解析时剥离括号注释，或改用独立字段承载原因）。

### 为什么放最后

- 需要 Agent 判断「算不算同族」——边界模糊，`amaze / maze` 这类要人来定
- 而且**必须先有屈折词形**才能把屈折从 family 里摘干净，否则摘到一半会掉数据
- 优先级判断：`family` 现状虽混杂但**至少有内容**，比 `aliases` 1303 词全空**危害小**

### 星图怎么做

`family_review.py` 是 **Agent 参与**的状态机：

> Agent 对模板中每个来源候选提交 `relationDecisions` 的 `accept`、`reject` 或 `uncertain`，
> 并对每个词族候选提交 `derivativeDecisions` 的 `direct_derivative`、`same_family`、
> `reject` 或 `uncertain`。

两条纪律值得抄：

1. **两个数组必须覆盖模板中的全部候选**，不能挑着答
2. **不能确认时必须显式选 `uncertain`，不得默认为拒绝** ——
   防止 Agent 用「默认保守」悄悄掩盖不确定性

这比本项目现有的 Agent 提案管线（ADR-0008 / 0029）更细：它把「不清楚」提升为一等公民。

### 建议

先做规则相关的（屈折推导 + 拼写排除表），观察真实使用中「`family` 混杂够不够忍」，
再决定要不要上 Agent 去精修词族边界。

---

## 五、明确不抄：图谱可视化

星图的力导向画布做得很细（同族间距约束 `familyNodeGap`、Alt+滚轮缩放、
基准平移恢复、500 节点上限、悬停提示）。但**本项目不该抄**，三条理由：

1. **与「窄而深」的定位冲突。** vocab-ob 的 L1 卡有 <5s/词的节奏纪律，
   图谱是「大屏慢慢逛」的交互，两种注意力模式。
2. **本项目的原则明确禁止「词典式堆砌」。** CONTEXT.md 的 **Minimal seed（最小种子）**：
   > core meaning + morphology + etymology narrative + memory chain;
   > **dictionary-style piling is forbidden**. Collocations/corpus/examples/
   > **synonym/antonym distinctions are L2-only and never appear on an L1 card.**
   
   所以「同义/反义辨析」**不能上 L1 卡**。星图那套把同义/近义/反义/拼写全画在一张图上的做法，
   直接违反这条。
3. **vocab-ob 已经有等价物，只是形态不同。** 词汇广场（`plaza.service.ts`）是
   **列表式集合**（语义场 + 词根词缀），已经在做「把词按关系归类」这件事。
   再叠一个力导向图是两套并存的入口，违反 ADR-0025 单一代码路径的精神。

**但有一个例外值得考虑**：星图的图谱工具栏有个**「初始化」**动作 ——
把节点散布在中心附近再重跑布局。这个「每次进入图谱自动重置视图」的思路，
对应到本项目就是**「进入词汇广场时回到默认分组」**，是个小体验点，不是功能。

---

## 六、边界：哪些关系能进 L1 卡

这是本分析里最容易出错的地方。按 CONTEXT.md 的 Minimal seed 原则划界：

| 关系类型 | 能否进 L1 卡 | 依据 |
| --- | --- | --- |
| **屈折词形**（abandon → abandoned） | ✅ 可以 | 属 Tier 2 的 `Morphology (root/family)`，是词形不是辨析 |
| **同族派生**（abandon → abandonment） | ✅ 可以 | 同上，CONTEXT.md 明确把 family 写进网络层 |
| **拼写易混**（adapt / adopt） | ⚠️ 不建议进 L1 卡 | 不是「这个词是什么」，是「别和那个搞混」——属纠错，放错题/复习流 |
| **同义/反义辨析** | ❌ 不可进 L1 卡 | CONTEXT.md 原文：**L2-only and never appear on an L1 card** |

**这条界线的含义**：从星图拿的是**数据与算法**（怎么算屈折、怎么算易混），
不是它的**呈现方式**（一张图全画）。数据拿到了，放哪由本项目自己的纪律决定。

---

## 七、建议顺序与理由

| 顺序 | 做什么 | 为什么是这个位置 |
| --- | --- | --- |
| 1 | **屈折词形**（规则推导 + `pending` 标记） | 纯确定性、无 Agent、无需新表；且是后两项的前置数据 |
| 2 | **拼写易混词对**（LCS + 三重排除） | 依赖 1 的排除表；能接进错题库，兑现跨模块价值 |
| 3 | **`family` 语义收边界**（屈折移出、远亲移出、脏数据收口） | 依赖 1 先落地；成本最高，危害最小 |
| — | 图谱可视化 | 不做 |
| — | 艾宾浩斯排程 / 熟悉度 per-project / 收藏跨项目 | 不做（旧结论不变） |

### 与既有 P0/P1 清单的关系（修正）

前面那份借鉴清单的 P0 是「复习日历」和「CSV 导入」。那两件仍然优先 ——
它们是**兑现已经躺在库里的数据**。

本文这项与它们不同：**不是新建，是修补已有字段的质量**。所以它不该排在「新功能」序列里，
而应该挂在 **L1 建词流程**上（`build-word-entry` / `collection-parser`）——
它改的是入库时的数据完整性，不是加一个用户可见的入口。

一个例外：**拼写易混词对确实是新功能**（真的全缺），它排在原 P0 之后、P1 葫芦之前。

---

## 八、一句话

> 星图值得拿的不是那张图。它真正的价值是暴露了 vocab-ob 自己的两个已有字段质量崩了：
> **`aliases`（屈折词形）只有 62.2% 覆盖，1303 个词完全没有，且批次间从 99% 到 0% 不等**；
> **`morphology_family` 100% 填了，但混着屈折、远亲和 149 行自由文本注释。**
>
> 星图的解法是把「人工手写」换成「规则推导 + 待核验标记」，这一步纯确定性、零 Agent，
> 顺手还能修掉 L3 圈记里「遇到 abandoned 匹配不到 abandon」这个用户看不见的静默失败。
> 而那张力导向图本身别抄 —— 词汇广场已经是等价物，
> 且 CONTEXT.md 明令 L1 卡禁止同义/反义辨析这类词典式堆砌。
