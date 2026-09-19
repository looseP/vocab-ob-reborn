# ADR（study-notes-workspace）: 学习笔记（N1 后端合同）——跨材料笔记、专题与可追溯引用

- **Status**: Accepted（2026-09-19：N1 后端合同批次 Task 00–06 随批冻结；前端 Task 07–11 后续交付）
- **Date**: 2026-09-19
- **Amends**: ADR-0019（**仅声明修订，不修改原文**——ADR 不可变）：其「知识点/方法论复用 `context_type='note'`」的表述被显式修订——跨题长篇学习笔记拆为独立实体（走 ADR-0019 §4 预留的「知识点需要独立生命周期再拆」路径）；**不复活**已退役的 `notes`/`note_revisions` 文档模型。ADR-0029：记录 N1 全部新端点为 owner-only；引用面不向 agent（含 trusted）开放任何写权限，也不借评析区开口外扩。
- **References**: 设计《题型学习笔记设计 v1》（`docs/plan/study-notes-design-2026-09-18.md`，唯一 N1 合同）；《学习笔记 Implementation Plan》（`docs/plan/study-notes-execution-plan-2026-09-18.md`，Task 00–11）；ADR-0023（在线优先/服务器权威）；ADR-0030（题与 context 分离、question 实体、payload 引用哲学）；ADR《writing-workspace》（题面引用式与 requestId 幂等先例）；`docs/design/l3-space/baseline.md`（UI 锚点，前端批次消费）

## Context

L3 已有素材（source/context/occurrence）、题目与试卷（ADR-0030）、圈词注记（`l3_question_annotations`）、单题评析（`l3_question_assessments`）与作文工作区（writing-workspace）。用户需要在**做题之外**写自由的跨材料学习笔记：一篇笔记可归属 1–7 个题型，可加入多个专题，可携带对原文/题干/选项片段的**可追溯引用**。

现状实体均不适合充当该载体：`note_entries` 依附词/词书（词级短条）、annotations 依附题目（题级分析）、`context_type='note'` 依附 source 且随 source 级联删除（丢失引用语义）。同时必须避免三类重复真源：不建第二份题库、不建第二份作文正文、不复制作答历史。

## Decision

### 1. 独立实体（5 张 owner 表，N1 后端批次）

`l3_study_notes`（笔记：title/body_md/status/pinned/version/CAS 与幂等列）、`l3_study_note_venues`（1–7 题型归属）、`l3_study_topics`（平面专题，属唯一题型）、`l3_study_topic_notes`（专题成员与 position 排序）、`l3_study_note_references`（引用快照与定位）。全部：`user_id` + owner RLS（own_all）+ 复合 owner FK；引用涉及 source/question 的行使用 **RESTRICT**（见 §4）。

笔记/专题**只有归档恢复、无硬删入口**；正文与引用可编辑移除。题型归属由单一应用写入口在事务内保持「至少一个」；最后一个归属不得移除；仍属某题型专题时移除归属 409 并列出专题。

### 2. 引用契约（strict 枚举 + 服务端快照）

- 五种 kind 严格枚举：`source / source_quote / question / stem_quote / option_quote`；N1 **不预留**可任意写 JSON 的 target 字段（N2 历史引用另定新增枚举，不靠后门）。
- 快照与 hash **一律由服务端读取真实对象生成**：客户端提交坐标与 quote，服务端校验 owner/active/字段存在与 `quote === field.slice(start,end)`（UTF-16 code unit，不 trim、不归一化、不拆代理对）；客户端不得指定可信出处、内容 hash 或快照。
- hash 口径：source/source_quote 用完整 `content_text`（NULL 整体来源按空字符串）；stem_quote 用 `stem`；option_quote 用对应 `option.text`；question 用固定键序 `{stem,options}` JSON（options 保持题面顺序）。标题变化只更新 liveTitle、不标 changed；整题内容改写标 changed。
- 正文标记 `[[ref:<uuid>]]` 仅在 marked **顶层 paragraph token 且 text 完全等于标记**时识别；标记集合必须与 `ReferenceWrite.id` 集合完全相等且无重复，缺失/多余/未知标记显式拒绝（422），不静默丢弃。
- 引用状态 `current / changed / unavailable`：**保留引用时的摘录**，不以旧 offset 套新文本、不自动重锚；`keep` 只保留原摘录，`capture` 明确新建或更新。

### 3. 保存、幂等与锁序

- 保存为完整笔记状态（`expectedVersion` + `requestId`）：锁 note → 同 requestId 同载荷返回当前结果、同 ID 异载荷 409 → CAS `version` 比对 → 校验限额与目标 → 正文/归属/引用**同一事务**原子替换；失败整体回滚。
- **仅保证最后一次请求的幂等**（不宣称全历史去重）：旧 requestId 已被新写入覆盖则按版本冲突处理；冲突 409 只返回 currentVersion，不自动返回当前内容。
- 固定锁序：专题成员操作 `topic → note`；笔记保存只读 topic 成员、不反向取 topic 锁。GET/预览/搜索/反向引用**零写**（不创建题纸、不创建作答、不调用 openSheet）。

### 4. 删除保护（引用阻止源永久删除）

- N1 明确取舍：**被引用的 source / question 不能直接删除**——先移除引用，或把卡片**显式转换**为普通摘录（用户明确操作，界面注明「将保留一份独立文字摘录」），才能删源。归档笔记中的引用同样阻止删除。
- source 删除必须**同时检查其下题目的引用**（question → source 为 ON DELETE CASCADE，直接删 source 会级联）；数据库以复合 owner FK + RESTRICT 兜底并发竞态，服务端提供可理解的 409 blocker（含可读笔记标题/引用数），FK 异常仍映射 409 而非 500。
- 数据库被直接绕过应用时缺失的目标显示 `unavailable` 占位，不把笔记整页渲染失败。

### 5. 权限（owner-only）与 N1/N2 边界

- 全部新 HTTP 端点 owner-only：未认证 401、agent 403、他人资源 404；引用解析、反向索引与导出都走 actor 事务/RLS。**不借**既有评析区 agent 开口扩大本面。
- N1 范围：自由笔记、七题型归属、平面专题、引用 source/question 及其指定片段、预览/反向引用、并发保存保护。**N2（不在本批）**：注记/评析摘录、笔记互链、历史 attempt/sheet/grading、作文稿次/feedback 引用——启动条件与接入顺序见执行计划 §4。

### 6. 旧模型不迁移

`note_entries`（词级）、`l3_question_annotations`（题级）、`l3_question_assessments`（评析）、`context_type='note'`（source 级）均**保持各自职责，不迁移**为学习笔记；也不复活 `notes`/`note_revisions`。学习笔记与它们共享的只是"都是笔记"的日常语感，不是数据关系。

## Tradeoffs

- **独立 5 表 vs 复用 note_entries/context**：新表代价是第二套 CRUD/RLS/测试，但换得跨题型归属、引用完整性（复合 FK + RESTRICT）与版本语义；复用会把引用完整性与归属约束挂在错误的生命周期上。
- **引用阻止删除 vs 快照自由化**：阻止删除把复杂度留在删除路径（预检查 + FK 兜底 + 转换操作），换取"不存在悬空引用"的强不变量；与「引用保留原对象关联」的产品方向一致。
- **服务端快照 vs 客户端提交快照**：服务端读取生成杜绝伪造出处/内容断言；代价是 capture 必须与目标读取在同事务（`lockTargets` 稳定顺序 FOR SHARE）。
- **最后请求幂等 vs 全历史去重**：全历史去重需要请求账本与无界存储；最后请求幂等用两个列覆盖重试主场景，语义诚实标注。

## Consequences

- ✅ 「引用沿用真源」成立：source/question 仍是唯一真源，笔记只存快照与定位；不存在第二份题库/正文/作答历史。
- ✅ 三个可测不变量：引用集合与正文标记相等；归属至少一个；被引用源不可删。
- ⚠️ `l3_study_note_references` 的 RESTRICT 使删除路径必须处理 blocker——源删除端点的兼容性回归纳入本批验收（既有未被引用对象删除按原合同运行）。
- ⚠️ 快照总量上限 2 MiB/笔记（422），防 100 个整题快照无限放大；导出（未来批次）以已存快照输出、不替换历史摘录。
- ⚠️ 本 ADR 冻结的是**后端合同**；「端点可用」不等于「学习笔记空间已交付」，前端 Task 07–11 完成前不得对外宣称 N1 交付。
