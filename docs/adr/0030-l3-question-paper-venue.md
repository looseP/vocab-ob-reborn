# ADR-0030: L3 题目/试卷模型与试卷工作台（题与 context 分离 + paper.payload 引用 + agent 分级预留）

- **Status**: Accepted
- **Date**: 2026-09-16
- **Amends**: ADR-0029（**仅声明修订，不修改原文**——ADR 不可变）：在「agent 一律 proposal-only」之上新增 **trusted_agent 白名单面直写**例外（本 ADR §5；三段式 token 与 MCP 工具随后续波次落地）；ADR-0019（L3 子空间轴新增题型轴，但能力域 space 语义不变）
- **References**: ADR-0007（owner 直写可信面）、ADR-0019 §4（子空间/错题派生/计划存引用）、ADR-0029（agent 边界与 agentId 信任锚）、ADR-0004 §6（L3 零 FSRS）、设计卡《L3 试卷工作台 v3.1》（2026-09-16）、任务分解 V0–V3（同日）

## Context

- 现状 L3 只有「词在真实语料中的用法」（context + occurrence）；练习题型仅 `essay_dictation | context_quiz`，作答对象恒为句子。**无题目实体、无试卷实体**。把真题题干/选项/答案塞进 context 会污染图、词空间高亮、阅读读模型（context 的词绑定语义被破坏）。
- `l3_source_spaces` 能力域轴（ADR-0019）已在 V0 接通写入，但它回答的是「材料属于什么能力域」，不回答「这是什么题型、题怎么组成卷面」。
- 用户工作流：主动上传自己想做的试卷 → 平台拟真做题 → 交卷不实时判分 → 本地 agent 异步评卷、错误类型结构化沉淀。智能在本地 agent，平台是薄工作台（**平台零 LLM 预算**，延续 ADR-0003/ADR-0004 边界）。
- ADR-0029 后 agent 只能 proposal-only；实测本地项目 agent（跑在 owner 机器、持 owner 配置的 token）拆卷/评卷若全部卡人工确认，工作流不可用。需要比「全开/全关」更细的信任级，但信任必须显式授予、面必须收窄、动作可回溯可改判。

## Decision

### 1. 题目与 context 严格分离（新实体，独立表）

- `l3_questions`：题干 `stem`、`options jsonb`、标准答案 `answer jsonb`（选择 key / 参考译文 / 范文与评分要点，形态按题型）、`explanation`、`evidence jsonb`（标准答案证据锚点 `[{start,end,label}]`，复用 occurrence 区间锚点体系）、`ordinal`、题型 `question_type`（7 值 CHECK）、能力域 `space`（由题型自动映射，见 §3）、归属材料 `source_id`（可空）、无题材料组键 `file_key`（可空）、`status pending|active|rejected`（默认 active）、`created_by`（服务端认定：`owner` 或 agentId）、`input_hash`（幂等，partial unique）。
- `l3_papers`：`title`、`direction`、`metadata jsonb`（年份/卷种/时长）、`payload jsonb` + `payload_version int`、`status draft|active|archived`、`created_by`、`input_hash`。
- **不建文件表、不建 sections 表**：做题文件是派生视图——阅读类文件 = `(source_id, question_type)` 题组聚合；无正文题组（翻译/作文）= `file_key` 题组。试卷结构是 payload 内有序 sections（§2）。
- CHECK 约束：每题必须有归属——`source_id IS NOT NULL OR file_key IS NOT NULL`。复合 owner FK `(source_id, user_id) → l3_sources(id, user_id) ON DELETE CASCADE`（材料删除，题随之消失；卷面渲染走 §2 降级）。
- 题级状态生命周期与 ADR-0029 proposal 同构：`pending → active/rejected`。V1 owner 直写恒 active；`pending` 通道与 `created_by` 字段先落库，agent 双级写入随后续波次启用（**预留列不等于开放端点**）。

### 2. 试卷 = 文件的有序串联；payload 存引用、现拉现渲染

学 `l3_sessions.plan`（ADR-0019「计划存引用」哲学），卷面 sections 存于 `l3_papers.payload`：

```jsonc
{ "version": 1,
  "sections": [
    { "key": "s1", "title": "Section I  Use of English", "questionType": "cloze",
      "sourceId": "<uuid>", "questionIds": ["q1", "q2"] },
    { "key": "s4", "title": "Part C 翻译", "questionType": "sentence_translation",
      "sourceId": null, "fileKey": "trans-2023-1", "questionIds": ["q46"] }
  ] }
```

三道护栏：
1. **写入校验**（service，单一收口）：`payload.version` 必须等于服务端当前版本；section key 不重复；`questionIds` 全部属于同一 user、题型与 section 一致；有 `sourceId` 时 source 归属同一 user 且题确实挂在该 source；无 source 必须带 `fileKey`。校验失败 400/422，不允许落半截卷面。
2. **渲染降级**：GET 详情现拉组装；引用的题/材料缺失（被删）时该 section 返回 `missing` 占位而不是 500——payload 是引用不是冻结快照。
3. **删题 409**：删除 active 卷面引用中的题 → `ConflictError`，details 给出引用它的 paper id/title；先从卷面移除或归档卷面再删。

### 3. 双层分类：能力域挂材料（不变）、题型挂题（新增）；录入自动映射，用户不做两次分类

- 能力域 `space`（语法/阅读/作文/翻译/通用，ADR-0019）继续挂 **source**；`question_type`（7 值：`cloze | reading_choice | new_question | sentence_translation | short_essay | long_essay | grammar_blank`）挂 **question/payload section**。
- 题型→能力域自动映射（`src/domain/l3-question-types.ts` 常量单一真源）：cloze/reading_choice/new_question→阅读；sentence_translation→翻译；short_essay/long_essay→作文；grammar_blank→语法。建卷/录题同事务按 section 涉及材料自动补 source 的 space 标签（调既有 junction 写入，幂等 ON CONFLICT DO NOTHING）。
- 做题单元 = 一篇 Text 的材料 + 该 Text 自己的题组（一个文件一次加载）；题型空间是文件管理器；整卷 = 文件按 sections 顺序串联。纯产品语义，详见设计卡 §1–§2，本 ADR 只钉数据边界。

### 4. owner 直写面（V1）与后续做题/评卷红线

- V1 开放的 owner 端点：建卷（含题目内嵌创建，单事务）、散题录入、试卷/文件/题读面、题删除（带 §2 护栏）。全部 owner-only + sessionMutation + own_all RLS，沿 ADR-0007。
- 做题作答（`l3_submissions`）与评卷（`l3_grading_results`）为后续波次实体，本 ADR 先钉死红线：
  - **submissions 仅 owner 客户端可写；任何级别 agent（含 trusted）一律 403**（DB policy + 路由双保险，防伪造作答）；
  - agent **不可删除**任何题/卷/材料/评卷（只能订正、不能销毁）；
  - agent **不触 L1/L2/FSRS**，信任级不跨界（ADR-0002 三轨隔离不松）；
  - 平台不引入 LLM 评卷/拆题预算；评卷非实时，靠 agent 拉取触发（无 webhook/轮询）；L3 仍零 FSRS，题级错题只做派生视图（confirmed/auto_confirmed 的 grading 聚合），不设 due。

### 5. 对 ADR-0029 的收窄：trusted_agent 白名单面（后续波次启用）

- agent 角色两级：`agent`（默认，行为等同 ADR-0029：读全量、写走 pending 提案）与 `trusted_agent`（owner 在本机显式配置，白名单面直写 active/auto_confirmed）。
- token 配置升级三段式 `agentId:token[:role]`，缺省第三段 = `agent`（旧配置零行为变化），role 仅接受 `agent|trusted_agent`，非法值启动 fail-fast。
- trusted 白名单面**只有两个**：录题/建卷（questions/papers）、评卷结果（grading_results）。同一路径一条代码路径，service 按角色决定产物 lifecycle；`created_by` / `graded_by_agent_id` 由服务端认定。trusted 直入的评卷 owner 仍可逐条改判（`owner_corrected_at` 留痕），错题口径按改判重算。
- 撤销 = 改 env 重启（ADR-0029 语义不变）；直写动作进既有 telemetry/request-id 日志可按 agentId 检索。
- 本 ADR Accepted 时三级 token 解析与 MCP 工具**尚未实现**；任何 trusted 能力在端点、注册表、capabilities、测试矩阵齐备前不得开放（测试必交：agent 调直写面 → pending/403；trusted 写 submissions/删除/L1L2 → 403）。

## Tradeoffs

- **新表 vs 复用 context**：复用会污染词绑定读模型且答案/选项无处安放；新表代价是第二套 CRUD/RLS/测试，但题与「词的用法」语义正交，长期成本更低。
- **payload JSON 引用 vs sections 表**：JSON 免一张关联表、改卷=改一行、与 l3_sessions.plan 同构；代价是引用完整性靠服务层+删题 409 护栏而非 FK（jsonb 内 id 无法建外键），接受该代价并以渲染降级兜底。
- **文件派生视图 vs 文件表**：真实试卷一文一题型，`(source_id, question_type)` 聚合天然 1:1，建表是冗余真相；散题用 file_key 定界。若未来出现强文件元数据需求（自定义封面/排序），另立 ADR 增补，不提前建模。
- **trusted 例外 vs 纯 proposal**：收窄 ADR-0029 的极简红线，换取本地 agent 工作流可用；用「显式配置 + 面收窄 + 留痕可改判 + submissions 永禁」把风险压在评卷/录题两个可纠错面内。

## Consequences

- V1 迁移：`l3_questions` / `l3_papers`（含 RLS own_all、复合 owner FK、CHECK、partial unique input_hash、索引）+ `schema.ts` 同步 + drift 验证；不建 sections/文件表。
- domain 纯函数层：题型枚举与中文名、type→space 映射、payload 版本常量与结构校验（零出向、确定性、可单测，先例 `l3-practice-task.ts`）。
- owner 入库面（建卷/录题/删除护栏）+ 文件/卷读面随后续波次交付；做题台（三模式/证据层/草稿）与评卷闭环见任务分解 V2/V3。
- ADR-0029 关于「agent 全部 proposal-only」的表述在 trusted 白名单面（录题/评卷）被本 ADR 显式收窄；其余面（圈记/关联/导入提案、删除、L1/L2、submissions）边界一字不动。
- 错误类型 taxonomy（37 code）以服务端常量 `src/domain/l3-error-taxonomy.ts` 落地（评卷波次），zod 收 code、不走 DB CHECK，演进免迁移。
