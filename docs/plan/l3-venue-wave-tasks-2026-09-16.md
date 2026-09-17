# L3 试卷工作台 · V0–V3 任务分解（2026-09-16）

- **设计真源**：[l3-subspace-venue-design-card-2026-09-16.md](./l3-subspace-venue-design-card-2026-09-16.md)（v3.1，D1–D6 全部定案）
- **六决策快照**：D1 双层标签+Text 级文件统一面；D2 paper.payload JSON 引用（version+三护栏）；D3 agent 两级角色；D4 37 个 error code taxonomy（`src/domain/l3-error-taxonomy.ts`，V3 落地）；D5 点选配对/按钮排序，拖拽延后；D6 自动草稿（逐题 merge）+显式交卷软确认。
- **纪律（每任务通用）**：先 ADR 后代码（V1 前 ADR-0030 Accepted，Amends ADR-0029）；中文文案+设计 token 起步，不新增英文工程文案；UI 交付必带基线引用+前后截图（空/加载/错/满+明暗+≤480px）；门禁 typecheck/arch:check/test:unit（分层覆盖+diff ≥85%）/frontend:build；API 变更走 api:governance 六步；DDL 变更走 schema.ts 同步+RLS+converge/verifier+drift+快照链唯一性。
- **复杂度棘轮**：新路由文件须在 `scripts/verify-route-complexity.ts` 登记基线；domain 纯函数零出向、确定性、无答案不出题（先例 `src/domain/l3-practice-task.ts`）。

---

## V0 · 接通子空间死轴（0 DDL，S–M）— **本轮执行**

> 目标：`l3_source_spaces` 从只读轴变成可写轴；书架能按空间筛选。无新表（0030 已建 junction+RLS+CHECK+索引）。

| ID | 任务 | 落点（已核实） | 验收 |
|---|---|---|---|
| V0-T1 | service 输入类型加 `spaces?: L3SubSpace[]`，枚举校验/去重/默认 `['通用']` | `src/schemas/service/index.ts:432` CreateL3SourceInput；枚举真源 `src/domain/index.ts:538` L3SubSpace | 非法值 400；空数组归一 `['通用']`；重复值去重 |
| V0-T2 | repository 事务化写入：建 source 同事务 insert junction；新增 `replaceSourceSpaces(userId,id,spaces[])`（delete+insert，先 findSourceById 所有权校验） | `src/repositories/interfaces.ts`（IL3ContextRepository）、`src/repositories/l3-context.repository.ts:478` createSource；走现有 TxRunner | 单测：建后 junction 行数/值正确；replace 全量替换；越权 id 不产生写入 |
| V0-T3 | service 接线：createSource 透传 spaces；新增 `replaceSourceSpaces` 方法；两处 createSource 调用点（193 直建 / 421 导入管线）都透传 | `src/services/l3-context.service.ts:193,421` | 现有 service 测试不破；新增用例覆盖默认值与去重 |
| V0-T4 | HTTP 契约：`l3SourceCreateSchema` 加 `spaces`（zod enum 数组、可选）；新增 `PUT /l3/sources/:id/spaces`（body `{spaces}`）；list 响应 items 带出 `spaces: string[]`（SQL `ARRAY_AGG` 子查询） | `src/schemas/http/index.ts:250`、`src/http/routes/l3/sources.ts`、`src/http/operations.ts`；list SQL `l3-context.repository.ts:809`（space 过滤 EXISTS 已在 828–832） | api:governance 六步；OpenAPI/`src/frontend/api/generated/openapi.ts` 再生；路由复杂度登记 |
| V0-T5 | 前端录入：批量导入表单加"能力域"多选（chips，默认勾"通用"）；手动编辑页补标签编辑 | `L3ImportPage.tsx`、`L3ManualEditorPage.tsx`（共享一个 `SpaceSelect` 小组件，避免两处各写一套） | 截图四态；中文；窄屏 chips 换行不溢出 |
| V0-T6 | 书架空间筛选 chips + 卡片显示空间徽标；复用现有 list 端点 space 参数（确认路由已透传，缺则补） | `L3Bookshelf.tsx` + 其 view model/hook | 筛选与类型/搜索/排序可叠加；URL 不要求持久化（V0） |
| V0-T7 | 测试 | service 单测扩 3 用例（默认/去重/越权）；路由契约用例；前端组件测试（chips 筛选调用带 space） | test:unit 全绿、diff 覆盖 ≥85% |

**V0 完成判定**：导入一篇文章勾选"阅读/作文" → 书架卡片显示双徽标 → 筛选"作文"能命中、清空恢复 → 练习页/错题库既有 space 过滤开始有数据（死轴激活的端到端证据）。

---

## V1 · 题/文件/卷入库 + agent 分级（L）

> **进度（2026-09-16 晚）**：owner 切片已落地（ADR-0030 Accepted + 迁移 0032 + T2/T4/T5/T7/T8 owner 侧）。
> 已交付：`l3_questions`/`l3_papers`（RLS+CHECK+复合 owner FK+input_hash partial unique）、
> domain 题型/映射/payload 纯校验、owner 粘贴建卷（单事务、自动落材料能力域标签、删题 409、渲染降级）、
> 文件/卷/题 7 端点、试卷台 UI（题型空间文件 + 我的试卷 + 粘贴建卷）。
> **剩余**：T3 agent 三段式 token/双 lifecycle、T6 MCP 工具（submit_paper 等）、T4 的 pending 审查流、
> T8 真实库集成测试（RLS/迁移）；question/paper 的 UPDATE/归档端点按波次再授 DB GRANT（现仅 SELECT/INSERT[/DELETE 题]）。

**前置**：ADR-0030（题目与 context 分离、文件派生视图、paper.payload JSON+version、平台零 LLM、grading 异步、Amends ADR-0029 trusted 白名单/禁写面/留痕）。

| ID | 任务 | 要点 |
|---|---|---|
| V1-T1 | 迁移 0032：`l3_questions` / `l3_papers` | questions：stem/options jsonb/answer jsonb/explanation/evidence jsonb/ordinal/source_id?/paper_id?/space/question_type CHECK 7 值/created_by/status(pending/active/rejected)；papers：title/direction/metadata jsonb/payload jsonb+version/status；均 own_all RLS + converge/verifier/drift；**不建 sections 表、不建文件表** |
| V1-T2 | domain 常量 | `l3-question-types.ts`（7 题型 + 文件身份规则 `(source_id, question_type)` 与题组键）；`question_type→space` 自动映射（cloze/reading_choice/new_question→阅读 等，设计卡 §2.1）；题型→布局注册位预留 |
| V1-T3 | agent 三级 token 解析 | `src/config/agent-tokens.ts` 升 `agentId:token[:role]`，缺省 agent、非法 fail-fast、旧配置零变化；Principal 带 agentRole；minRole 注册表扩展；capabilities 按角色广告 lifecycle；必交角色拒绝测试矩阵 |
| V1-T4 | 建卷/录题写入管线（owner 直写 + agent 双 lifecycle） | 契约 papers/questions create；service 校验 payload.version、引用归属、题型↔space 映射一致性；agent→pending 包审查流（复用 L3ProposalPage 模式），trusted→active 一条代码路径；幂等 input_hash（0031 范式，23505 回读） |
| V1-T5 | 读端点 | 文件列表（按 question_type/direction/做题状态/搜索）、文件详情（source+题组）、paper 详情（现拉组装 sections，缺失引用降级占位）；删题被 active 卷引用 → 409 blocker 中文化 |
| V1-T6 | MCP 工具 | `submit_paper` / `list_papers` / `list_practice_files` / `list_questions`；工具描述按角色提示直入/待确认；进授权注册表 F 类+runbook+capabilities |
| V1-T7 | owner 最小建卷 UI | 粘贴建卷表单（section+题+选项+答案）、题源库/文件列表（无做题交互，只入库与浏览） |
| V1-T8 | 测试 | 迁移/RLS（含真实库集成测试先例 tests/l3-rls）、双 lifecycle、幂等、角色 403 矩阵、payload 降级 |

## V2 · 文件管理与卷面做题台（L，体验核心；0 DDL）

| ID | 任务 | 要点 |
|---|---|---|
| V2-T1 | venue 两视图路由 | `?venue=<type>` 文件列表 / `&file=<键>` 做题表面 / `?paper=<id>&mode=` 整卷；handoff/nonce 一致；列表：年份/卷种/状态/错题数筛选+上下文件切换不离开表面 |
| V2-T2 | 三模式可见性引擎 | 纯前端 mode store + URL；痕迹层矩阵（设计卡 §2.4）；同表面三套数据显隐，切换不丢作答 |
| V2-T3 | 题型布局配置（先 3 种） | cloze（空号同屏）、reading_choice（左文右题/移动文上题下、段落导航）、sentence_translation（逐句对照卡）；材料×题组×笔记三区配置化 |
| V2-T4 | 证据锚点层 | agent 证据区间渲染（独立层，不进选区偏移计算——09-13 P0-2 教训）；用户 evidence_pick 点选；与圈记层互斥 |
| V2-T5 | 新题型交互（D5） | 配对组件（点选项→点空框，七选五/小标题共用）；排序上移/下移按钮；answers 存储与交互解耦 |
| V2-T6 | 草稿/交卷前端（D6，提交端点在 V3-T1 之前可先用临时契约？否——拆序：V3-T1 的 submissions 表前移到 V2 末） | 逐题防抖 PATCH merge qid；保存中/已保存状态；未答题软确认；submitted 冻结 |
| V2-T7 | 测试与截图 | 三模式×三题型×明暗×窄屏矩阵；选区不被污染回归；自动保存 merge 不互踩（双标签模拟） |

> 排程备注：submissions 表（V3-T1）实际须在 V2-T6 前落地，执行时把 V3-T1/V3-T2 的 owner 侧提交端点提前到 V2 末；agent 评卷侧仍留 V3。

## V3 · 异步评卷闭环（L）

| ID | 任务 | 要点 |
|---|---|---|
| V3-T1 | 迁移 0033：`l3_submissions`（file_scope jsonb / paper_id 二选一、部分唯一索引一行 in_progress、可多次作答）、`l3_grading_results`（lifecycle proposed/confirmed/auto_confirmed、owner_corrected_at、graded_by_agent_id） | RLS own_all；submissions 仅 owner 客户端可写（**任何 agent 角色 403**，DB policy + 路由双保险） |
| V3-T2 | owner 作答端点 | 草稿 merge PATCH、交卷（软确认信息来自服务端未答题计数）、重做新开一行；文件/卷双作用域 |
| V3-T3 | grading taxonomy 落地 | `src/domain/l3-error-taxonomy.ts`（37 code 正式清单，设计卡 §2.7）；zod 收 code 校验、appliesTo 一致性；deprecated 演进规则 |
| V3-T4 | agent 评卷面 | MCP：list_submissions/get_submission/read_source_annotations/submit_grading/get_grading_taxonomy；双 lifecycle（agent→proposed / trusted→auto_confirmed）；(submission,agent) 幂等回读 |
| V3-T5 | 评卷确认与改判 UI | proposed 逐题确认/整包通过；auto_confirmed 可逐条改判（留痕）；题级错题本派生视图（confirmed+auto_confirmed，wrong/partial，取最新已评作答）；与句级错题分区 |
| V3-T6 | 解析修正模式闭环 | 错误 tag 徽标+证据跳位+订正笔记（context_type='note'）；"复制评卷指令"按钮（无 webhook/轮询） |
| V3-T7 | 测试 | 隔离：agent 写 submission 403；幂等；改判后错题口径；RLS 真实库；capabilities taxonomy 一致性快照 |

## V4（数据驱动后排）

七选五/排序 HTML5 拖拽、作文整文写作+稿纸区、图画题图片位（无 OCR）、整套计时、雅思题型族、HTML5 音频 seek（衔接 deferred media 模型）、薄弱题型推荐（recommendation 引擎吃 error code 聚合）、taxonomy 校准回看。

---

## 端到端验收主线（每波结束手工走一遍）

V0：导入勾"阅读"→书架筛选命中→练习页 space 下拉有数据。
V1：trusted agent 一份 2023 英一卷包 → 确认/直入 → 文件列表出现 4 篇 Text+完型+翻译+作文文件 → 组卷顺序正确。
V2：打开 Text 1 左文右题纯净首做 → 切做题模式恢复草稿 → 文内点证据 → 交卷软确认 → 整卷模式文件串联。
V3：本地 agent 评卷 → 解析模式看证据/37 类 tag → 改判一题 → 题级错题本口径更新 → 攻坚包按题型抽题。
