# N2 只读盘点与冻结要求（2026-09-23）

> 分支：`study-notes-n2-inventory` @ `04abb4f5`（main，Task 11 merge #133 之后）。
> 本文件**只读盘点**：不新增表、不写实现、不改任何 `src/`。
> 目的：在写实现之前，先冻结**数据模型 / 权限 / 引用版本 / 导出兼容**四项要求。
> 上游依据：`study-notes-design-2026-09-18.md:23`（N2 独立交付）、
> `study-notes-execution-plan-2026-09-18.md:358-362`（接入顺序与必备件）。

---

## 1. N1 已冻结的引用模型（N2 的输入约束）

| 项 | 事实 | 位置 |
|---|---|---|
| 引用型枚举 | 五型严格：`source` / `source_quote` / `question` / `stem_quote` / `option_quote`；**不预留可任意写 JSON 的后门** | `src/domain/l3-study-notes.ts:61-69` |
| 目标形状 | camelCase 判别联合：`source{sourceId}`、`source_quote{sourceId,start,end,quote}`、`question{questionId}`、`stem_quote{questionId,start,end,quote}`、`option_quote{questionId,optionKey,start,end,quote}` | 同上 `:77-88` |
| 状态三态 | `current` / `changed`（field_hash 变） / `unavailable`（越库删除） | 同上 `:71-73` |
| marker 语法 | `^\[\[ref:(…)\]\]$`；仅**顶层 paragraph 且整段等于 marker** 才替换 | 同上 `:262`、`:276` |
| 引用时快照 | `display_snapshot`（服务端白名单组装，不含标准答案面）+ `captured_at` | `src/db/schema.ts:1689` 注释 |
| 变更判定 | `field_hash` = 原字段 UTF-8 SHA256（64 hex） | `src/db/schema.ts:1702`、`:1731` |

## 2. N2 五类目标 vs 现存实体

`src/db/schema.ts` 现有 **27 张 `l3_*` 实体表**。与 N2 相关者：

| N2 目标 | 现存表 | 备注 |
|---|---|---|
| 注记 | `l3_question_annotations` | |
| 评析 | `l3_question_assessments` | 「评析」可改判 → 引用版本语义待定 |
| 笔记互链 | **无专用表**（`l3_study_notes` / `l3_study_topic_notes`） | 见 §6 待定项 D2 |
| 历史题纸 | `l3_papers` | 卷面/作答另见下行 |
| 作答（卷面 / 逐题） | `l3_submissions`、`l3_question_attempts` | `l3_question_attempts_writing_sheet_unique` |
| 评卷 | `l3_grading_results` | `sheet+question` unique、`verdict` check |
| 作文任务 / 反馈 | `l3_writing_tasks`、`l3_writing_feedback` | `l3_writing_feedback_sheet_owner_fk` |

写作「稿次」本体未以独立 `l3_writing_sheets` 形式出现（**已裁决：保持如此**，见 §8 D1）。

## 3. 冻结项 A — 数据模型

- **A1** 新增引用型必须扩展 `REFERENCE_KINDS` 与 `ReferenceTarget` 判别联合（`src/domain/l3-study-notes.ts`），
  **不得**用 `unknown`/自由 JSON 承载目标——设计明文禁止后门。
- **A2** 每种新目标都要有可判定的 `field_hash` 输入字段集合，并在实现期写死（否则 `changed` 三态退化为恒 `current`）。
- **A3** 目标必须可被**级联 blocker** 登记：现有 `getSourceDeleteBlockers` / `getQuestionDeleteBlockers`
  是「删除前先查引用」的先例，新目标需同款 blocker。
- **A4** 不复制正文为第二份真源：作文已提交稿与动态评析一律采用**引用当时摘录**。

## 4. 冻结项 B — 权限与归属

- **B1** owner-only：每张 `l3_*` 表带 `*_own_all` RLS 策略；引用行带跨表属主一致性 FK
  （`note_owner_fk` / `source_owner_fk` / `question_owner_fk`）。新目标表沿用同款。
- **B2** agent 403：导出链路上 agent 角色恒 403（http 测试已断言）；N2 不得借新引用型扩大 agent 权限。
- **B3** 只读导航：N2 只走 `GET`（list/get），不新增写入面（前端任务书 N2 行已如此约定）。

## 5. 冻结项 C — 引用版本

- **C1** 引用时快照、不回套活体文本（ADR `:28` / `:40`）；`changed` 只提示不改写；`unavailable` 保留占位块。
- **C2** 每种目标的四件必备：归属、内容清理、引用时快照、变更提示（execution-plan `:362`），
  另加**只读导航测试**。
- **C3** 改判语义（评卷/评析可重判）必须先定：是「新增一条快照」还是「就地更新 + changed 提示」。

## 6. 冻结项 D — 导出兼容

- **D1** `exportSchemaVersion = 1`（`src/services/l3-study-note-export.service.ts:61`）；
  payload 字段冻结（P2 决策表）、响应头 `X-Export-Sha256` / `X-Export-Schema-Version`、双段 hash + 内容校验行、
  marker→五型引用块渲染、JSON 围栏自适应。
- **D2** 新引用型必然改变 `payload.references[].kind` 取值域与 `target` 形状 →
  **必须显式升 schema 版本**，不得在 v1 上就地塞新形状。
  **已裁决（用户，2026-09-23）**：升 **`exportSchemaVersion = 2`**，v1 永久冻结、v2 显式选择
  （详见任务书 §5.1 P4）。这是顺带闭合 F-1（`bodyMd` → v2 内更名 `renderedBodyMarkdown`）的唯一时机。

## 7. 只读导航（F-1 回看协议，N2 复用不自造）

- `/l3?sheet=<id>`、`?paper=<id>`、`L3ExamPaper.replaySheetId`（design `:9`）；
- 作文稿次协议（task/sheet/origin/resume）已随整合合并（design `:10`）。
- N2 **复用**已合并接口，不改名另起一套参数。

## 8. 待定项（设计阶段必须先拍板，未定不写实现）

| # | 待定 | 影响 | 裁决（2026-09-23） |
|---|---|---|---|
| D1 | 作文「稿次」本体是哪张表 | 目标形状、`field_hash` 输入、导出 target | ✅ **`l3_submissions`**（identity = `{ submissionId, revisionNo }`，writing 必带 revisionNo；`draft_version` 不作身份）；详见任务书 §5.1 D1 |
| D2 | 笔记互链：新建链接表还是扩展 `l3_study_note_references` | 后者会动 N1 冻结的 kind 枚举与导出 v1 | ⏳ **仍未裁决** |
| D3 | 注记可编辑 / 评析可改判 → 快照与 `changed` 用哪些字段 | C2/C3 | ✅ **当前结果可更新（沿用既有 latest-wins 合同）+ 引用快照不可变**（转 `changed`，不覆盖旧摘录）；详见任务书 §5.1 D3 |
| D4 | 历史 attempt 引用是否要求「只读回看」先落地验收 | 启动条件（design `:23`） | ⏳ **仍未裁决** |

**裁决后新开的待确认项**（详见任务书 §5.1 尾部，均只阻塞后半链）：

- **D1-a**：是否只允许引用 sealed 稿 —— **未裁决（2026-09-23）**。未裁决前：第 5 条链不开工，
  草稿态引用语义不实现（不允许先放宽后收紧）。
- **D3-a**：`l3_grading_results` 无历史版本列。~~暂定（2026-09-23，待签字）~~ → **已签字，见 ADR-0039（2026-09-26）**：N2 只支持「引用当前评卷」，
  历史评卷版本引用显式不做，不新增版本列/历史表，不为不可表达的需求虚构版本语义。
