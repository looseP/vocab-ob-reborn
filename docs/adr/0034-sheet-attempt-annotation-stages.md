# ADR-0034: 题纸、作答历史题中心化与草稿注记 stage 生命周期（定格三档 + 冻结导出）

- **Status**: Accepted
- **Date**: 2026-09-17
- **Amends**: ADR-0030（**仅声明修订，不修改原文**——ADR 不可变）：将其「payload 是引用不是冻结快照」哲学推广到作答侧（attempts 是唯一作答真源，题纸不冻第二份副本）；ADR-0033 §5（注记面从「agent 连读都不开放」修订为「提交即授权、按题纸作用域收口」，见 §4）
- **References**: ADR-0025（可携带导出契约——冻结导出对齐版本化 + 原子写 + manifest 模式）、ADR-0029（owner/agent 边界与授权注册表）、ADR-0019 §4（子空间/错题派生/计划存引用）、ADR-0004 §6（L3 零 FSRS）、设计卡《L3 题纸与草稿注记设计卡》（2026-09-17，D7–D12 定稿）、任务表《L3 批次二任务分解》（2026-09-17）

## Context

批次一（ADR-0033）交付后，卷面已能做题、建注记、圈词入笔记，但**作答本身还没有家**：答案写哪、历史怎么管、做题时随手写的判据（「划线句子关联题号 + 自己的理由」）算什么、agent 评卷读什么。2026-09-17 设计卡会话把这一批的数据模型一次定死，本 ADR 把其中不可回退的决策钉死为架构约束。

三条设计哲学红线（设计卡 §0/§2 收口）：

1. **引用与派生，不是冻结副本**——同一事实只存一份。凡出现「两份存储、一侧可删」的形状，就是双真相 bug 的胚胎，必须在建模期拆掉。
2. **作答历史的粒度是题，不是卷**——一题一条历史链，管理/删除/重做全部按题操作；题纸只是会话信封，不再是历史管理单位。
3. **草稿注记是「主张」，需要被检验**——做题中产生的划线判据不是解题草稿，随题纸定格提交给 agent 检验，检验产物只写 review 段，原文不可篡改。

## Decision

### 1. 题纸 `l3_submissions`：两个 venue 的统一作答容器

- **题纸 = 一行 `l3_submissions`**，`file / paper` 只是作用域（`scope` CHECK 二选一），产品名统一「题纸」。file venue 的「即答即存」= 草稿自动保存，体感不变；「换新题纸」= 新开一行，多刷天然隔离。
- **作用域键 `scope_key text NOT NULL`**：`file:<source_id>:<question_type>` 或 `paper:<paper_id>`。规避组合列（source_id + question_type 分开存）在 NULL 时唯一索引不去重的陷阱——单列非空字符串，语义完整。
- **状态机**：`draft`（任意涂画，防抖 PATCH 自动保存）→ `sealed`（定格：物化 attempts，此后 PATCH **409 拒写**）| `discarded`。部分唯一索引 `(user_id, scope_key) WHERE status='draft'` 保证一作用域同时至多一张在写题纸（开纸冲突复用返回既有行，幂等）。
- **定格后 `answers` 清空**：`answers jsonb` 仅 draft 期有效；`seal` 事务内物化 attempts 后清空该列。**attempts 是唯一作答真源**（双真相点 #2，建模期拆除）——被否决方案 `submissions.answers` 与 attempts 双写同一事实，允许一侧删就必然漂移（「卷里显示 A、题历史里没有」是双真相的必然结果）。
- question 归属校验（file→source 属主、paper→paper 属主）由 service 借道既有 repo 收口，404 语义同批次一。

### 2. 作答历史题中心化：`l3_question_attempts`

- **管理粒度从「卷/文件」下沉到「题」**（修订 wave-tasks V3-T1）：`question_id` + `venue('file'|'paper')` + `sheet_id?`（→ 题纸） + `answer` jsonb + **当场自评快照** `self_assessment` + `created_at` + `status('active'|'deleted')` + `deleted_at`。
- **attempt 只存作答事实，无判定列**（双真相点 #1）：agent 评卷 verdict 真源仍归 `l3_grading_results`（批次三建），否则 agent 改判时两处同步即腐化。
- **软删 + 派生渲染**（照 ADR-0033 注记软删先例）：删除 = `status='deleted' + deleted_at`，不物理删；结果页逐题明细**直接从 attempts 按 sheet_id 派生渲染**——attempt 行不可变，串行即天然快照，`submission` 不冻第二份副本；卷级统计同源现算。删除的可见语义两处分流：题历史列表过滤 deleted；结果页该题显示「作答记录已清理」占位（内容不展示、尊重删除意图），**统计保持交卷时口径**（软删行仍在库，天然不受影响）。**不做级联消失**——删一条历史改写已发生的成绩更糟；「抹掉那次成绩」的正确操作对象是整卷归档/隐藏，与删单条不共用按钮。
- **时空序：attempts 与 submissions 同批建（本批次），不留给批次三从 jsonb 派生**——避免历史迁移。
- 题删级联：`question_id FK → l3_questions ON DELETE CASCADE`（题删注记/attempts 随删，卷面 409 护栏本已挡删 active 引用题）；`sheet_id FK → l3_submissions ON DELETE SET NULL`。

### 3. 注记 stage 生命周期：扩 `l3_question_annotations`（不建第二张表）

- **新列 `stage text NOT NULL DEFAULT 'confirmed' CHECK('draft','submitted','confirmed')`**——存量自动回填 `confirmed`（历史注记即已确认终态）；流转：`draft`（做题中产生，挂题纸）→ `submitted`（随题纸定格提交，待检验）→ `confirmed`（agent 检验通过 / owner 确认）。
- **`stage` 与既有 `status`（软删）正交**：status ∈ active|deleted 只管可知性，stage 管生命周期位置；删除枚举归属本 ADR 钉死，两轴互不代偿。
- **`sheet_id uuid?` FK→l3_submissions ON DELETE SET NULL**：草稿期挂题纸（定格前必填语义由 service 保证）；定格升格后保留 sheet 引用做溯源。
- **`review jsonb`**：agent 检验产物 `{verdict:'sound'|'questionable'|'wrong', corrected_tags?, comment?}`——batch 三 agent 写（本批只留列与契约形状）。
- **渲染规则**：`stage=draft` 仅在所属题纸做题/解析模式可见（虚线描边与正式注记区分），纯净模式与其他题纸上下文不显示；`submitted/confirmed` 沿用批次一「全程可见」规则。

### 4. 提交即授权（Amends ADR-0033 §5）

- 草稿注记**随题纸提交时作为评卷输入交给 agent**；**历史正式注记群默认不开放**。ADR-0033 §5「注记面 agent 连读都不开放」被本条**部分修订**：开放范围 = 该题纸 `stage='submitted'` 的草稿注记，按题纸作用域收口。授权注册表同步登记（本批登记语义，执行面批次三）。
- **agent 写边界（不可篡改性）**：agent **只写 `review` 段**，永不写注记内容——`note` / 锚点 / 用户原判标签是不可篡改的原始事实；订正放 `review.corrected_*`，**采纳归 owner**（owner 手动改自己的注记，或不理会）。
- 评卷产物加 `annotation_reviews[]` 段即可，**不新增白名单面**（不走 proposal 新类型）——ADR-0030 §5 trusted 白名单面保持两个（录题/建卷、评卷结果）不变。

### 5. 定格三档（题纸的一次性收场）

| 档位 | 作答事实 | 草稿注记 | 题纸 |
|---|---|---|---|
| **完整记录** | 物化 attempts | 全部升格（draft→submitted，待检验） | 保留（sealed） |
| **增量条目** | 不落 attempts | 全部升格 | 弃（discarded） |
| **只留总结** | 不落 | 只留「本次刷题总结」条（无锚点注记，挂作用域代表题） | 弃（discarded） |

- 定格动作时选择档位（默认完整记录）；`discarded` 题纸行保留墓碑（状态 + 时间），内容字段清空可回收。
- 「增量条目」服务场景：答得不值得存（全对无悬念/纯练手），但判据想留；「只留总结」服务场景：本次只有元认知值得留。
- 未答题计数作为 paper 交卷软确认数据源（响应含 `unansweredCount`），不硬阻断。

### 6. 冻结导出（对齐 ADR-0025）

- 定格后可导出**只出不进**的冻结档案：文章 + 题面 + 答案（attempts）+ 草稿注记（锚点 `==高亮==`）+ 评审 + 统计；**Markdown 起步**（贴 agent 友好），带 `exportSchemaVersion`（起步 1）。
- 复用 ADR-0025 的原子写 + manifest + sha256 模式与**单一代码路径纪律**；**不回灌**（避免第二真相源），导入语义不在本批。

## Tradeoffs

- **题纸信封 vs 作答历史单位**：题纸从「历史管理单位」降为「会话信封」，历史管理下沉到 attempts（题级）。代价是多一层 join（结果页按 sheet_id 派生前需读 sheet 行），收益是「一题一套」的管理粒度和「删单条不改写成绩」的语义自洽。
- **scope_key 单列字符串 vs 组合列部分唯一索引**：组合列 `(user_id, source_id, question_type)` 在 paper venue 下两列均 NULL，部分唯一索引的 NULL 不去重会造成「同卷多张 draft 并存」；单列非空 scope_key 语义完整、索引简单，代价是键格式由服务端纪律维护（domain 纯函数生成 + CHECK 形状校验）。
- **定格后清空 answers vs 保留**：保留 = 双真相（删除/修改一侧必然漂移）；清空 = 定格瞬间 attempts 物化后弃置草稿副本，唯一代价是「定格后重进题纸详情」必须走 attempts 派生路径（本批已实现，成本一次）。
- **stage 扩列 vs 新表**：草稿注记与正式注记同族（同题、同锚点体系、同软删），新表会造「两份注记、跨表迁移」的第二真相点；扩列代价是 `stage` 与 `status` 两轴并存需文档纪律，收益是锚点幂等/标签/渲染全链复用批次一。
- **三档定格 vs 单一交卷**：三档服务三种真实收场（值得全存/只留判据/只留元认知）；代价是 seal 路径三个分支都要测试覆盖，收益是题纸「价值交付后即可弃」的定位落地。

## Consequences

- 迁移 0034：`l3_submissions`（题纸，scope_key + 部分唯一索引 + 状态 CHECK）+ `l3_question_attempts`（题级历史，无判定列）+ `l3_question_annotations` 扩三列（stage/sheet_id/review）；三表 own_all RLS + vocab_app 四权 + converge/verifier 双落点 + 迁移计数断言 34→35。
- domain 纯函数层（零出向）：题纸状态机（canPatchSheet / sheetStatusAfterSeal）、seal 输入形状、attempt 契约、stage 流转谓词、覆盖度视图 `annotationCoverage`（「A✓ B✓ C— D—」只呈现不催）。
- service/route：题纸开纸（幂等 200/201）/读（sealed 从 attempts 派生）/PATCH merge（非 draft 409）/定格（三档事务）/attempts 批量徽标 + 软删，7 端点 owner-only；`answerIndex`/标准答案绝不出现在做题模式响应（设计卡 D8）。
- 前端：题纸栏（状态徽标 + 防抖保存）、定格三档 modal、题卡历史徽标 + modal 预览（含「去题型空间打开此文」深链）、draft 注记虚线分轨、覆盖度子区。
- 批次三保留：agent 评卷执行面（MCP submit_grading）、`stage='submitted'→'confirmed'` 检验回写、标签统计聚合面板、`l3_grading_results` 建表；FSRS/l2/context 圈记体系一字不动。
