# ADR-0033: 做题注记（原文分析）与素材笔记分轨（题挂锚点 + 两级规律标签 + 卷面圈记缓冲）

- **Status**: Accepted
- **Date**: 2026-09-16
- **References**: ADR-0030（题目/试卷工作台，题与 context 分离）、ADR-0019（L3 圈记/context 体系与子空间）、ADR-0029（owner/agent 边界）、实施计划《做题注记 + 素材笔记区（批次一）》（2026-09-16）

## Context

试卷工作台（ADR-0030 V1）上线做题/核对后，做题中的两类沉淀需要落地方：

1. **做题注记**：「这道题为什么错/为什么选」——挂在**题**下，常常锚定原文一句话（错误选项在原文应证的位置），带两类规律标签：题型归因（细节/推断/主旨…）与错误类型（同义替换/偷换概念/无中生有…，可按选项 A–D 打标）。它与「词在真实语料中的用法」（l3_contexts/occurrences）不是一回事：挂 context 会污染词空间高亮与图读模型（ADR-0030 已为此把题独立成表）。
2. **素材笔记**：做题时顺手圈出原文生词/好句，想事后到素材空间按词处理（查词、绑定、复习）。做题面不是圈记管理入口，不能把 L3ReadingView 的完整圈记表单塞进卷面。

约束：桌面端试卷布局不动（左文右题）；官方 evidence 只在解析模式出现，用户锚点全程可见；判分节奏（自动保存/显式交卷）是批次二，本批次不碰。

## Decision

### 1. 做题注记 = 挂题实体；与素材圈记分轨（新表，不写 context）

- `l3_question_annotations`：`question_id uuid NOT NULL → l3_questions(id) ON DELETE CASCADE`（复合 RLS 谓词带 user_id；题删注记随删，卷面 active 卷引用的题本就被 409 护栏挡删）、`anchor_start/anchor_end/excerpt`（三者同空同非空，CHECK 双保险）、`note text`、`entry_tags jsonb`（题型标签数组）、`option_tags jsonb`（A–D 键 → 错误类型数组）、`ordinal`（题内顺序，插入时取题内 max+1）、`status active|deleted` 软删、时间戳。
- CHECK：`(anchor_start IS NULL) = (anchor_end IS NULL)`、`anchor_start IS NULL OR anchor_end > anchor_start`、`(anchor_start IS NULL) = (excerpt IS NULL)`；jsonb 默认 `[]` / `{}`。部分索引 `(user_id, question_id) WHERE status='active'`。
- **锚点幂等**：同 `(user_id, question_id, anchor_start, anchor_end)` 的 active 条目重复创建直接返回既有行（200），不插第二行；幂等编排收口在 service（先 `findByAnchor` 再 insert），DB 不建额外唯一索引（软删/改锚点场景下部分唯一约束代价高，服务层 + 同一 RLS 事务足够）。
- 无锚点条目（纯题型归因/笔记）合法，但 note 与两级标签不得同时为空（domain zod 拦截）。
- **三轨隔离不变**：注记表不写 FSRS/l2，service 只做归属校验与锚点幂等；L3 context/occurrence 读写一字不动。

### 2. 两级规律标签：预置 + 用户可增删改，按用户隔离

- `l3_annotation_tags`：`kind entry|option`、`label`、`ordinal`、`status active|deleted`；部分唯一索引 `(user_id, kind, label) WHERE status='active'`（软删旧行不阻塞重新插入）。
- 冻结预置集（`src/domain/l3-annotations.ts` 常量单一真源）：entry 6 个（细节/推断/主旨/态度/词汇/例证），option 7 个（同义替换/偷换概念/无中生有/过度推断/正反颠倒/张冠李戴/答非所问）。预置只是首次读的默认内容，用户可整体增删改（PUT 整存：事务内软删全部旧行 + 插新行，`requireTx` 保证原子）。
- **lazy-seed**：首次 GET 标签字典（表内无 active 行）时，同一事务写入预置集再返回；之后恒读用户自己的行。标签统计聚合是批次三，本批次不做。

### 3. 卷面文栏三通道 + 纯函数分片

- 三个标注通道在同一 content 坐标系（UTF-16 偏移，含 `〖n〗` 占位字符）：**空位角标**（不可划词，点击跳题）、**官方 evidence**（`l3_questions.evidence`，仅解析模式实心底高亮）、**用户注记锚点**（全程显示，下划线/描边，纯 `<mark>` 无 onClick/cursor）。
- 通道重叠优先级：空位 > evidence > annotation；越界/倒挂锚点裁剪丢弃。分片为纯函数 `buildPassageSpans`（不重叠连续区间，可单测），渲染只消费 span。
- 高亮是纯 mark：**不加 onClick、不加 cursor-pointer、不拦截划词**；跳转入口只有句末行内小角标按钮（点击 `stopPropagation`，滚到右侧题卡并展开原文分析）。反向定位（题卡定位钮 → 文栏）走 scrollIntoView + 1.2s CSS pulse。
- 选区偏移映射：渲染时每个文本段带 `data-content-off`（该段在 content 的起点），选区起止文本节点上溯取偏移相加；空位 `user-select:none` 不参与选区，跨空位选择自动按 content 坐标对齐。

### 4. 划词分叉：建原文分析 vs 圈词入笔记；卷面只做缓冲

文栏 mouseup 浮动作条两分支：

- **建原文分析条目**：弹当前 section 题号选择器 → POST 注记（锚点 start/end + excerpt 自动带入，note/标签在题卡补充）。
- **圈词入笔记**：最小表单（目标词 slug + 可选 bound sense，语境句由 `enclosingSentence` 纯函数按句读切取）→ 复用既有 owner 直写端点 `POST /l3/sources/:id/captures`，**不新增圈记后端**。
- 卷面不做圈记管理：文栏卡片底部「素材笔记」折叠抽屉只读展示该 source 的圈记（复用 `GET /l3/sources/:id/space`），行尾深链 `/l3?contextId=` 回素材空间阅读视图；首次展开才请求。本会话新圈的 context 打「缓冲」徽标，事后在素材空间处理。

### 5. 端点、鉴权与 RLS

- 6 个 owner-only 端点（`/api/l3/question-annotations` GET 批量（questionIds 逗号分隔，1–200 个 uuid）/ POST（幂等 200、新建 201）/ PATCH / DELETE 软删 204；`/api/l3/annotation-tags` GET / PUT）。做题台面是私人数据，读也不开放给 agent（授权注册表显式登记 OWNER_READS/OWNER_WRITES）。
- `:id` 不做 uuid 预校验（不存在/非属主统一由 service 转 404）。PATCH 仅改提交列（显式 `null` 可去锚点；zod 形状纯 optional 无 default，避免未提交键被默认值误清空）。
- RLS：两表各一条 `FOR ALL ... USING/WITH CHECK (auth.uid()=user_id)` policy（ENABLE 仅 RLS，FORCE 对表属主无意义，vocab_app 非属主 NOBYPASSRLS）；`vocab_app` 四权 GRANT（SELECT/INSERT/UPDATE/DELETE，行锁 UPDATE 需要 FOR UPDATE，故四权齐备）；授权双落点：迁移 GRANT + bootstrap-database-roles converge + verify-database-roles 期望清单三处同步。

## Tradeoffs

- **新表 vs 复用 l3_contexts**：做题注记的聚合维度是题、标签是题型/错因而非词；复用会让词空间出现「题注」高亮、图里出现非语义节点。新表代价是第二套 CRUD，但语义正交、读模型零污染。
- **锚点幂等放 service vs DB 唯一索引**：唯一索引在软删、改锚点、同位置多条演进时会成为枷锁（需要 DEFERRABLE/去重键等复杂度）；做题面并发极低（单 owner 单会话），service 同事务先查后插足够，竞态最坏结果是多一条（可删），不损坏数据。
- **标签整存（软删+重插）vs 逐行 diff upsert**：每用户标签 ≤50/kind，整存语义简单、顺序由 ordinal 重排、事务保证；代价是标签 id 每次 PUT 后变化（标签 id 不被注记引用——注记存的是 label 字符串快照），无外键代价。
- **圈词走 captures 最小表单 vs 内嵌完整圈记流**：卷面核心动作是做题，圈记是顺手旁路；目标词 + 语境义两字段覆盖 80% 场景，完整查词/多词绑定/回访统一留给素材空间，避免在卷面复制 L3ReadingView 的大表单。
- **evidence 与 annotation 视觉分轨 vs 合并高亮**：两者归属不同（官方 vs 用户）、生命周期不同（随题录入 vs 做题中产生），实心底 vs 下划线区分，解析模式才显示 evidence 可避免做题时答案提示干扰。

## Consequences

- 迁移 0033：两表（CHECK/部分索引/own_all RLS/四权 GRANT/cascade）+ 34 journal entries；schema drift 与 RLS acceptance 实链（11 用例）验证。
- domain zod 契约（锚点三元组/标签上限/A–D 白名单/空条目规则）+ repository（幂等查询/动态 SET/标签事务整存）+ service（题归属 404/幂等/lazy-seed）+ 6 端点（operations 注册、strict 响应契约、OpenAPI 纯新增无 breaking）。
- 前端：卷面组件自加载注记/标签并本地闭环 CRUD；题卡内嵌「原文分析」折叠子区（计数徽标/定位/编辑/删除/选项打标浮层）；文栏三通道分片纯函数 + 划词浮动条 + 定位 pulse；素材笔记抽屉只读 + 深链。
- 批次二/三保留：判分节奏（自动保存/显式交卷/即判开关）、移动端交错流、evidence 录入 UI、标签统计聚合面板仍在后续波次；本批次不触碰 submissions/grading 与 FSRS。
